"use strict";

const API = "https://api.runpod.ai/v2";
const $ = (id) => document.getElementById(id);

// ---------- Settings (stored only in this browser) ----------
const store = {
  get(k) { try { return localStorage.getItem(k) ?? sessionStorage.getItem(k); } catch { return null; } },
  set(k, v, remember) {
    try {
      (remember ? localStorage : sessionStorage).setItem(k, v);
      (remember ? sessionStorage : localStorage).removeItem(k);
    } catch {}
  },
  del(k) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch {} },
};
const creds = () => ({ key: store.get("rp_key") || "", endpoint: store.get("rp_endpoint") || "" });

async function rp(path, opts = {}) {
  const { key, endpoint } = creds();
  if (!key || !endpoint) throw new Error("Open Settings and add your RunPod endpoint ID and API key.");
  const res = await fetch(`${API}/${endpoint}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    if (res.status === 401) throw new Error("RunPod rejected the API key (401). Check it in Settings.");
    if (res.status === 404) throw new Error("Endpoint not found (404). Check the endpoint ID in Settings.");
    throw new Error(`RunPod error ${res.status}: ${body.error || body.raw || text}`);
  }
  return body;
}

// ---------- Content safeguard ----------
// This tool is for adults only. Prompts that reference minors are refused before anything is sent.
const MINOR_TERMS = /\b(child|children|kid|kids|minor|minors|underage|under-age|teen|teens|teenage|teenager|preteen|pre-teen|tween|youngster|toddler|infant|baby|babies|schoolgirl|schoolboy|school girl|school boy|loli|lolita|shota|little girl|little boy|young girl|young boy|juvenile|adolescent|pubescent|prepubescent|jailbait|middle school|elementary school|high school student)\b|\b(1[0-7]|[1-9])[\s-]*(yo|y\/o|years?[\s-]*old)\b/i;

function checkPrompt(text) {
  const m = text.match(MINOR_TERMS);
  return m ? m[0] : null;
}

// ---------- Gallery storage (IndexedDB, this browser only) ----------
const db = {
  _db: null,
  async open() {
    if (this._db) return this._db;
    this._db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("image-studio", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("images", { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this._db;
  },
  async tx(mode, fn) {
    const d = await this.open();
    return new Promise((resolve, reject) => {
      const t = d.transaction("images", mode);
      const out = fn(t.objectStore("images"));
      t.oncomplete = () => resolve(out?.result ?? out);
      t.onerror = () => reject(t.error);
    });
  },
  add(item) { return this.tx("readwrite", (s) => s.put(item)); },
  remove(id) { return this.tx("readwrite", (s) => s.delete(id)); },
  all() { return this.tx("readonly", (s) => s.getAll()); },
};

// ---------- UI state ----------
let size = "1:1";
let currentJob = null;
let urls = new Map(); // image id -> object URL

function initControls() {
  const modelSel = $("model");
  for (const [id, m] of Object.entries(MODELS)) {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = m.label + (m.needsUpgrade ? " (after upgrade)" : "");
    modelSel.append(o);
  }
  modelSel.value = store.get("ui_model") || "z-image-turbo";
  modelSel.addEventListener("change", () => { store.set("ui_model", modelSel.value, true); applyModel(true); });

  const sizes = $("sizes");
  for (const k of Object.keys(SIZES)) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.textContent = k;
    b.setAttribute("role", "radio");
    b.addEventListener("click", () => setSize(k));
    sizes.append(b);
  }
  setSize(store.get("ui_size") || "1:1");

  $("negative").value = store.get("ui_negative") ?? DEFAULT_NEGATIVE;
  $("prompt").value = store.get("ui_prompt") || "";
  $("prompt").addEventListener("input", () => store.set("ui_prompt", $("prompt").value, true));
  $("negative").addEventListener("input", () => store.set("ui_negative", $("negative").value, true));
  $("resetAdvanced").addEventListener("click", () => applyModel(true));
  applyModel(false);
}

function setSize(k) {
  if (!SIZES[k]) k = "1:1";
  size = k;
  store.set("ui_size", k, true);
  for (const b of $("sizes").children) b.setAttribute("aria-checked", String(b.textContent === k));
}

function applyModel(resetAdvanced) {
  const m = MODELS[$("model").value];
  $("modelNote").textContent = m.note;
  $("negWrap").hidden = !m.supportsNegative;
  if (resetAdvanced || !$("steps").value) {
    $("steps").value = m.defaults.steps;
    $("cfg").value = m.defaults.cfg;
  }
}

function setStatus(msg, isError = false) {
  $("status").textContent = msg;
  $("status").classList.toggle("error", isError);
}

// ---------- Generation ----------
async function generate() {
  const modelId = $("model").value;
  const m = MODELS[modelId];
  const prompt = $("prompt").value.trim();
  if (!prompt) return setStatus("Write a prompt first.", true);

  const flagged = checkPrompt(prompt);
  if (flagged) {
    return setStatus(`This studio only creates images of adults. Remove "${flagged}" from the prompt.`, true);
  }

  const [width, height] = SIZES[size];
  const seedInput = $("seed").value.trim();
  const settings = {
    model: modelId,
    prompt,
    negative: m.supportsNegative ? $("negative").value.trim() : "",
    width, height,
    count: Number($("count").value),
    steps: clampInt($("steps").value, 1, 80, m.defaults.steps),
    cfg: clampNum($("cfg").value, 1, 15, m.defaults.cfg),
    seed: seedInput ? Number(seedInput) : Math.floor(Math.random() * 2 ** 48),
  };

  setBusy(true);
  const placeholders = addPlaceholders(settings.count, width / height);
  const started = Date.now();
  try {
    setStatus("Sending job to RunPod…");
    const job = await rp("/run", { method: "POST", body: JSON.stringify({ input: { workflow: m.build(settings) } }) });
    currentJob = job.id;

    let result;
    while (true) {
      await sleep(2000);
      if (currentJob !== job.id) throw new Error("Cancelled.");
      result = await rp(`/status/${job.id}`);
      const secs = Math.round((Date.now() - started) / 1000);
      if (result.status === "IN_QUEUE") {
        setStatus(`Waiting for a GPU worker… ${secs}s\n(The first job after a while idle can take 1–3 minutes while the worker boots and loads the model.)`);
      } else if (result.status === "IN_PROGRESS") {
        setStatus(`Generating… ${secs}s`);
      } else break;
    }

    if (result.status !== "COMPLETED") {
      throw new Error(describeFailure(result));
    }
    const images = extractImages(result.output);
    if (!images.length) throw new Error("The job finished but returned no images. " + JSON.stringify(result.output).slice(0, 300));

    for (const [i, b64] of images.entries()) {
      const blob = b64ToBlob(b64);
      const item = { id: `${Date.now()}-${i}`, created: Date.now(), blob, settings: { ...settings, index: i } };
      await db.add(item);
    }
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    const exec = result.executionTime ? ` (GPU time ${(result.executionTime / 1000).toFixed(1)}s)` : "";
    setStatus(`Done in ${secs}s${exec}. Seed ${settings.seed}.`);
  } catch (e) {
    setStatus(e.message || String(e), true);
  } finally {
    placeholders.forEach((p) => p.remove());
    currentJob = null;
    setBusy(false);
    renderGallery();
  }
}

async function cancel() {
  const id = currentJob;
  currentJob = null;
  if (id) { try { await rp(`/cancel/${id}`, { method: "POST" }); } catch {} }
  setStatus("Cancelled.");
}

function describeFailure(r) {
  const err = r.error || r.output?.error || "";
  const msg = typeof err === "string" ? err : JSON.stringify(err);
  if (/not in list|value_not_in_list|unet_name|clip_name/i.test(msg)) {
    return "The worker doesn't have this model installed. If you picked a model marked “after upgrade”, finish Step 6 of the guide first.\n\nDetails: " + msg.slice(0, 400);
  }
  if (/out of memory|OOM/i.test(msg)) {
    return "The GPU ran out of memory. Try fewer images at once, or choose a GPU with more VRAM (24 GB+) for your endpoint.";
  }
  return `Job ${r.status}: ${msg.slice(0, 600) || "no details returned"}`;
}

function extractImages(output) {
  if (!output) return [];
  if (Array.isArray(output.images)) {
    return output.images.filter((x) => x.type === "base64" || !x.type).map((x) => x.data);
  }
  if (typeof output.message === "string") return [output.message]; // worker versions before 5.0
  return [];
}

// ---------- Gallery ----------
function addPlaceholders(n, ratio) {
  const g = $("gallery");
  $("empty").hidden = true;
  return Array.from({ length: n }, () => {
    const d = document.createElement("div");
    d.className = "tile pending";
    d.style.aspectRatio = String(ratio);
    d.textContent = "Generating…";
    g.prepend(d);
    return d;
  });
}

async function renderGallery() {
  const items = (await db.all()).sort((a, b) => b.created - a.created);
  const g = $("gallery");
  g.querySelectorAll(".tile:not(.pending)").forEach((t) => t.remove());
  const seen = new Set();
  for (const item of items) {
    seen.add(item.id);
    if (!urls.has(item.id)) urls.set(item.id, URL.createObjectURL(item.blob));
    const b = document.createElement("button");
    b.className = "tile";
    b.style.aspectRatio = `${item.settings.width} / ${item.settings.height}`;
    const img = document.createElement("img");
    img.src = urls.get(item.id);
    img.alt = item.settings.prompt.slice(0, 120);
    img.loading = "lazy";
    b.append(img);
    b.addEventListener("click", () => openViewer(item));
    g.append(b);
  }
  for (const [id, u] of urls) if (!seen.has(id)) { URL.revokeObjectURL(u); urls.delete(id); }
  $("empty").hidden = items.length > 0 || g.children.length > 0;
}

let viewing = null;
function openViewer(item) {
  viewing = item;
  const s = item.settings;
  $("viewerImg").src = urls.get(item.id);
  $("viewerImg").alt = s.prompt.slice(0, 120);
  $("viewerMeta").textContent =
    `${MODELS[s.model]?.label || s.model} · ${s.width}×${s.height} · seed ${s.seed}${s.index ? ` (+${s.index} in batch)` : ""} · ${s.steps} steps · CFG ${s.cfg}\n${s.prompt}`;
  $("vDownload").href = urls.get(item.id);
  $("vDownload").download = `studio-${s.seed}-${item.id}.png`;
  $("viewer").showModal();
}

function reuse(item) {
  const s = item.settings;
  $("model").value = s.model; store.set("ui_model", s.model, true);
  applyModel(false);
  $("prompt").value = s.prompt; store.set("ui_prompt", s.prompt, true);
  if (s.negative) { $("negative").value = s.negative; store.set("ui_negative", s.negative, true); }
  const sizeKey = Object.keys(SIZES).find((k) => SIZES[k][0] === s.width && SIZES[k][1] === s.height);
  if (sizeKey) setSize(sizeKey);
  $("seed").value = s.seed;
  $("steps").value = s.steps;
  $("cfg").value = s.cfg;
  $("count").value = "1";
  setStatus("Settings loaded. Keep the seed to recreate this image, or clear it for a new variation.");
}

// ---------- Settings dialog ----------
function initSettings() {
  const dlg = $("settings");
  $("openSettings").addEventListener("click", () => {
    const c = creds();
    $("endpointId").value = c.endpoint;
    $("apiKey").value = c.key;
    $("testResult").textContent = "";
    dlg.showModal();
  });
  dlg.addEventListener("close", () => {
    if (dlg.returnValue === "save") saveCreds();
    updateConn();
  });
  $("testConn").addEventListener("click", async () => {
    saveCreds();
    const out = $("testResult");
    out.classList.remove("error");
    out.textContent = "Testing…";
    try {
      const h = await rp("/health");
      const w = h.workers || {};
      out.textContent = `Connected. Workers — idle: ${w.idle ?? 0}, running: ${w.running ?? 0}, initializing: ${w.initializing ?? 0}. Jobs in queue: ${h.jobs?.inQueue ?? 0}.`;
      updateConn(true);
    } catch (e) {
      out.textContent = e.message;
      out.classList.add("error");
      updateConn(false);
    }
  });
  $("forget").addEventListener("click", () => {
    store.del("rp_key");
    $("apiKey").value = "";
    $("testResult").textContent = "Key removed from this browser.";
    updateConn();
  });
}

function saveCreds() {
  const remember = $("remember").checked;
  store.set("rp_endpoint", $("endpointId").value.trim(), remember);
  store.set("rp_key", $("apiKey").value.trim(), remember);
}

function updateConn(ok) {
  const c = creds();
  const el = $("conn");
  if (!c.key || !c.endpoint) { el.textContent = "Not connected"; el.classList.remove("ok"); return; }
  el.textContent = ok === false ? "Connection failed" : "Endpoint set";
  el.classList.toggle("ok", ok !== false);
}

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function clampInt(v, lo, hi, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; }
function clampNum(v, lo, hi, d) { const n = parseFloat(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; }
function b64ToBlob(b64) {
  const clean = b64.replace(/^data:[^;]+;base64,/, "");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: "image/png" });
}
function setBusy(busy) {
  $("generate").disabled = busy;
  $("cancel").hidden = !busy;
}

// ---------- wire up ----------
initControls();
initSettings();
updateConn();
renderGallery();
$("generate").addEventListener("click", generate);
$("cancel").addEventListener("click", cancel);
$("prompt").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) generate(); });
$("vClose").addEventListener("click", () => $("viewer").close());
$("vReuse").addEventListener("click", () => { reuse(viewing); $("viewer").close(); });
$("vDelete").addEventListener("click", async () => {
  if (!viewing || !confirm("Delete this image from your gallery?")) return;
  await db.remove(viewing.id);
  $("viewer").close();
  renderGallery();
});
$("viewer").addEventListener("click", (e) => { if (e.target === $("viewer")) $("viewer").close(); });
if (!creds().key) setStatus("Start by opening Settings to connect your RunPod endpoint.");
