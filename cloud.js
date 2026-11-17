"use strict";
// Minimal S3-compatible client for Cloudflare R2, signed in the browser (AWS Signature Version 4).
// Credentials come from Settings and are stored only in this browser.

const cloud = (() => {
  const enc = new TextEncoder();
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const sha256 = async (data) => hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data));
  async function hmac(key, msg) {
    const k = await crypto.subtle.importKey("raw", typeof key === "string" ? enc.encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return crypto.subtle.sign("HMAC", k, enc.encode(msg));
  }
  // S3 path encoding: encode everything except unreserved characters and "/".
  const encPath = (p) => p.split("/").map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())).join("/");
  const encQ = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

  let cfg = null; // { account, bucket, keyId, secret }
  function configure(c) {
    cfg = c && c.account && c.bucket && c.keyId && c.secret ? c : null;
  }
  const configured = () => !!cfg;

  async function request(method, key, { query = {}, body = null, contentType } = {}) {
    if (!cfg) throw new Error("Cloud sync is not set up.");
    const host = `${cfg.account}.r2.cloudflarestorage.com`;
    const path = `/${cfg.bucket}${key ? "/" + encPath(key) : ""}`;
    const qs = Object.keys(query).sort().map((k) => `${encQ(k)}=${encQ(query[k])}`).join("&");
    const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = now.slice(0, 8);
    let payload = body;
    if (payload instanceof Blob) payload = await payload.arrayBuffer();
    if (typeof payload === "string") payload = enc.encode(payload);
    const payloadHash = await sha256(payload || "");
    const headers = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": now };
    if (contentType) headers["content-type"] = contentType;
    const signed = Object.keys(headers).sort();
    const canonical = [method, path, qs, signed.map((h) => `${h}:${headers[h]}\n`).join(""), signed.join(";"), payloadHash].join("\n");
    const scope = `${date}/auto/s3/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", now, scope, await sha256(canonical)].join("\n");
    let k = await hmac("AWS4" + cfg.secret, date);
    for (const part of ["auto", "s3", "aws4_request"]) k = await hmac(k, part);
    const sig = hex(await hmac(k, toSign));
    const h = { ...headers };
    delete h.host;
    h.authorization = `AWS4-HMAC-SHA256 Credential=${cfg.keyId}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${sig}`;
    const res = await fetch(`https://${host}${path}${qs ? "?" + qs : ""}`, { method, headers: h, body: payload });
    if (!res.ok && !(method === "GET" && res.status === 404)) {
      const text = await res.text().catch(() => "");
      const code = (text.match(/<Code>([^<]+)/) || [])[1] || res.status;
      throw new Error(`Cloud storage error (${code})`);
    }
    return res;
  }

  return {
    configure, configured,
    put: (key, body, contentType) => request("PUT", key, { body, contentType }),
    async get(key) { const r = await request("GET", key); return r.status === 404 ? null : r; },
    del: (key) => request("DELETE", key),
    async list(prefix) {
      const keys = [];
      let token;
      do {
        const q = { "list-type": "2", prefix, "max-keys": "1000" };
        if (token) q["continuation-token"] = token;
        const xml = await (await request("GET", "", { query: q })).text();
        for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1].replace(/&amp;/g, "&"));
        token = (xml.match(/<NextContinuationToken>([^<]+)/) || [])[1];
      } while (token);
      return keys;
    },
  };
})();
