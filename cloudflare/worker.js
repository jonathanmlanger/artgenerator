// Image Studio server: a Cloudflare Worker that serves the app behind a password and holds the keys.
//
// - The app files are bundled into this script by cloudflare/build.mjs (see ASSETS below).
// - Bindings: BUCKET (R2 bucket "image-studio"), SESSION_SECRET (secret), PASSWORD_HASH (secret, initial password).
// - Private settings (RunPod key, endpoint IDs, changed password) are stored in the bucket under _config/,
//   which the file API below never exposes.

/* ASSETS_PLACEHOLDER */

const SESSION_DAYS = 365;
const CONFIG_KEY = "_config/settings.json";
const RUNPOD_PATH = /^(run|health|status\/[\w-]+|cancel\/[\w-]+)$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/api/login" && request.method === "POST") return login(request, env);
      if (path === "/api/logout" && request.method === "POST") return logout();

      const authed = await checkSession(request, env);
      if (path.startsWith("/api/")) {
        if (!authed) return json({ error: "Not signed in" }, 401);
        return api(request, env, url);
      }
      if (path === "/" || path === "/index.html") {
        return asset(authed ? "index.html" : "login.html");
      }
      const name = path.slice(1);
      if (ASSETS[name] && name !== "login.html") return asset(name);
      return new Response("Not found", { status: 404 });
    } catch (e) {
      return json({ error: e.message || String(e) }, 500);
    }
  },
};

// ---------- static files ----------
const TYPES = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8" };
function asset(name) {
  return new Response(ASSETS[name], {
    headers: {
      "content-type": TYPES[name.split(".").pop()] || "application/octet-stream",
      "cache-control": "no-cache",
      "x-robots-tag": "noindex, nofollow",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

// ---------- auth ----------
const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64url = (buf) => b64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$100000$${b64(salt)}$${b64(await pbkdf2(password, salt, 100000))}`;
}
async function verifyPassword(password, stored) {
  const [, iter, salt, hash] = (stored || "").split("$");
  if (!hash) return false;
  const got = b64(await pbkdf2(password, unb64(salt), Number(iter)));
  return timingSafeEqual(got, hash);
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function loadConfig(env) {
  const obj = await env.BUCKET.get(CONFIG_KEY);
  return obj ? await obj.json() : {};
}
async function saveConfig(env, cfg) {
  await env.BUCKET.put(CONFIG_KEY, JSON.stringify(cfg), { httpMetadata: { contentType: "application/json" } });
}
async function currentPasswordHash(env) {
  return (await loadConfig(env)).passwordHash || env.PASSWORD_HASH;
}

// Session cookie: "<expiry>.<signature>". The signature covers the current password hash,
// so changing the password signs out every other device.
async function makeSession(env) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const sig = await hmac(env.SESSION_SECRET, `${exp}:${await currentPasswordHash(env)}`);
  return `${exp}.${sig}`;
}
async function checkSession(request, env) {
  const m = (request.headers.get("cookie") || "").match(/(?:^|;\s*)studio_session=([^;]+)/);
  if (!m) return false;
  const [exp, sig] = m[1].split(".");
  if (!sig || Number(exp) < Date.now()) return false;
  return timingSafeEqual(sig, await hmac(env.SESSION_SECRET, `${exp}:${await currentPasswordHash(env)}`));
}
const sessionCookie = (value, maxAge) =>
  `studio_session=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;

async function login(request, env) {
  const { password } = await request.json().catch(() => ({}));
  if (typeof password !== "string" || !(await verifyPassword(password, await currentPasswordHash(env)))) {
    await new Promise((r) => setTimeout(r, 1500)); // slows down guessing
    return json({ error: "Wrong password" }, 401);
  }
  return json({ ok: true }, 200, { "set-cookie": sessionCookie(await makeSession(env), SESSION_DAYS * 86400) });
}
const logout = () => json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });

// ---------- API ----------
async function api(request, env, url) {
  const path = url.pathname.slice(5); // after "/api/"
  const method = request.method;

  if (path === "config" && method === "GET") {
    const c = await loadConfig(env);
    return json({ server: true, runpodKeySet: !!c.runpodKey, endpoint: c.endpoint || "", editEndpoint: c.editEndpoint || "" });
  }
  if (path === "config" && method === "PUT") {
    const body = await request.json();
    const c = await loadConfig(env);
    if (typeof body.runpodKey === "string" && body.runpodKey.trim()) c.runpodKey = body.runpodKey.trim();
    if (typeof body.endpoint === "string") c.endpoint = body.endpoint.trim();
    if (typeof body.editEndpoint === "string") c.editEndpoint = body.editEndpoint.trim();
    await saveConfig(env, c);
    return json({ ok: true });
  }
  if (path === "password" && method === "POST") {
    const { current, next } = await request.json();
    if (!(await verifyPassword(current || "", await currentPasswordHash(env)))) return json({ error: "Current password is wrong" }, 403);
    if (typeof next !== "string" || next.length < 12) return json({ error: "Use at least 12 characters" }, 400);
    const c = await loadConfig(env);
    c.passwordHash = await hashPassword(next);
    await saveConfig(env, c);
    return json({ ok: true }, 200, { "set-cookie": sessionCookie(await makeSession(env), SESSION_DAYS * 86400) });
  }

  // Account balance, for the low-credit notice in the chat. Only the dollar amount is returned.
  if (path === "balance" && method === "GET") {
    const c = await loadConfig(env);
    if (!c.runpodKey) return json({ balance: null });
    try {
      const res = await fetch("https://api.runpod.io/graphql", {
        method: "POST",
        headers: { authorization: `Bearer ${c.runpodKey}`, "content-type": "application/json" },
        body: JSON.stringify({ query: "query { myself { clientBalance } }" }),
      });
      const b = (await res.json().catch(() => null))?.data?.myself?.clientBalance;
      return json({ balance: typeof b === "number" ? b : null });
    } catch {
      return json({ balance: null });
    }
  }

  // RunPod proxy: /api/runpod/<main|edit>/<run|health|status/ID|cancel/ID>
  let m = path.match(/^runpod\/(main|edit)\/(.+)$/);
  if (m) {
    const c = await loadConfig(env);
    const endpoint = m[1] === "edit" ? c.editEndpoint || c.endpoint : c.endpoint;
    if (!c.runpodKey || !endpoint) return json({ error: "RunPod isn't set up yet. Open Settings and add your RunPod API key and endpoint ID." }, 400);
    if (!RUNPOD_PATH.test(m[2])) return json({ error: "Not allowed" }, 400);
    const res = await fetch(`https://api.runpod.ai/v2/${endpoint}/${m[2]}`, {
      method,
      headers: { authorization: `Bearer ${c.runpodKey}`, "content-type": "application/json" },
      body: method === "GET" ? undefined : await request.text(),
    });
    return new Response(res.body, { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }

  // File storage: GET /api/files?prefix=  (list) ; GET|PUT|DELETE /api/files/<key>
  if (path === "files" && method === "GET") {
    const prefix = url.searchParams.get("prefix") || "";
    const out = [];
    let cursor;
    do {
      const page = await env.BUCKET.list({ prefix, cursor, limit: 1000 });
      for (const o of page.objects) if (!o.key.startsWith("_config/")) out.push({ key: o.key, size: o.size });
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return json(out);
  }
  m = path.match(/^files\/(.+)$/);
  if (m) {
    const key = decodeURIComponent(m[1]);
    if (key.startsWith("_config/") || key.includes("..")) return json({ error: "Not allowed" }, 403);
    if (method === "GET") {
      const obj = await env.BUCKET.get(key);
      if (!obj) return new Response("Not found", { status: 404 });
      return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType || "application/octet-stream", "cache-control": "no-store" } });
    }
    if (method === "PUT") {
      await env.BUCKET.put(key, await request.arrayBuffer(), { httpMetadata: { contentType: request.headers.get("content-type") || "application/octet-stream" } });
      return json({ ok: true });
    }
    if (method === "DELETE") {
      await env.BUCKET.delete(key);
      return json({ ok: true });
    }
  }
  return json({ error: "Not found" }, 404);
}
