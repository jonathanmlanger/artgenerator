"use strict";
// Minimal S3-compatible client for Cloudflare R2, signed in the browser (AWS Signature Version 4).
// Credentials come from Settings and are stored only in this browser.
// In server mode (the app is served by cloudflare/worker.js) it talks to the server's /api/files
// instead, and needs no keys: the signed-in session cookie is enough.

// fetch() that rides out a spotty connection: retries network failures and temporary server errors
// (429, 502, 503, 504) for about a minute before giving up. Bodies must be reusable (string, Blob, ArrayBuffer).
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000, 15000, 15000];
async function fetchRetry(url, opts) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, opts);
      if (![429, 502, 503, 504].includes(res.status) || i >= RETRY_DELAYS.length) return res;
    } catch (e) {
      if (i >= RETRY_DELAYS.length) throw e;
    }
    await new Promise((r) => setTimeout(r, RETRY_DELAYS[i]));
  }
}

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

  let cfg = null; // { account, bucket, keyId, secret } or { server: true }
  function configure(c) {
    cfg = c && c.account && c.bucket && c.keyId && c.secret ? c : null;
  }
  const configureServer = () => { cfg = { server: true }; };
  const configured = () => !!cfg;

  async function serverRequest(method, key, { query = {}, body = null, contentType } = {}) {
    const qs = new URLSearchParams(query).toString();
    const url = key ? `/api/files/${key.split("/").map(encodeURIComponent).join("/")}` : `/api/files${qs ? "?" + qs : ""}`;
    const res = await fetchRetry(url, { method, headers: contentType ? { "content-type": contentType } : {}, body, credentials: "same-origin" });
    if (res.status === 401) { location.replace("/"); throw new Error("Signed out. Sign in again."); }
    if (!res.ok && !(method === "GET" && res.status === 404)) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Server storage error (${err.error || res.status})`);
    }
    return res;
  }

  async function request(method, key, opts = {}) {
    if (!cfg) throw new Error("Cloud sync is not set up.");
    if (cfg.server) return serverRequest(method, key, opts);
    const { query = {}, body = null, contentType } = opts;
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
    const res = await fetchRetry(`https://${host}${path}${qs ? "?" + qs : ""}`, { method, headers: h, body: payload });
    if (!res.ok && !(method === "GET" && res.status === 404)) {
      const text = await res.text().catch(() => "");
      const code = (text.match(/<Code>([^<]+)/) || [])[1] || res.status;
      throw new Error(`Cloud storage error (${code})`);
    }
    return res;
  }

  return {
    configure, configureServer, configured,
    isServer: () => !!cfg?.server,
    put: (key, body, contentType) => request("PUT", key, { body, contentType }),
    async get(key) { const r = await request("GET", key); return r.status === 404 ? null : r; },
    del: (key) => request("DELETE", key),
    async list(prefix) {
      return (await this.listDetailed(prefix)).map((o) => o.key);
    },
    // Returns [{ key, size }] for every object under prefix.
    async listDetailed(prefix) {
      if (cfg?.server) return (await request("GET", "", { query: { prefix } })).json();
      const out = [];
      let token;
      do {
        const q = { "list-type": "2", prefix, "max-keys": "1000" };
        if (token) q["continuation-token"] = token;
        const xml = await (await request("GET", "", { query: q })).text();
        for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const key = (m[1].match(/<Key>([^<]+)<\/Key>/) || [])[1];
          const size = Number((m[1].match(/<Size>(\d+)<\/Size>/) || [])[1] || 0);
          if (key) out.push({ key: key.replace(/&amp;/g, "&"), size });
        }
        token = (xml.match(/<NextContinuationToken>([^<]+)/) || [])[1];
      } while (token);
      return out;
    },
  };
})();
