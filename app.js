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
// Server mode: when the app is served by cloudflare/worker.js, the RunPod key and endpoint IDs live on
// the server (set once in Settings) and every RunPod and storage call goes through it. Nothing secret
// is kept in the browser. Holds { runpodKeySet, endpoint, editEndpoint } from GET /api/config.
let server = null;
async function detectServer() {
  if (location.protocol === "file:") return;
  try {
    const r = await fetch("/api/config", { cache: "no-store", credentials: "same-origin" });
    const c = r.ok && /json/.test(r.headers.get("content-type") || "") ? await r.json() : null;
    if (c?.server) server = c;
  } catch {}
}
const creds = () => server
  ? { key: server.runpodKeySet ? "(saved on server)" : "", endpoint: server.endpoint, editEndpoint: server.editEndpoint }
  : { key: store.get("rp_key") || "", endpoint: store.get("rp_endpoint") || "", editEndpoint: store.get("rp_edit_endpoint") || "" };
// Character / scene reference (Qwen Image Edit) can run on its own endpoint so each GPU worker
// only holds one set of large models; it falls back to the main endpoint if none is set.
const endpointFor = (modelId) => (MODELS[modelId]?.endpoint === "edit" && creds().editEndpoint) || creds().endpoint;

async function rp(path, opts = {}, endpointOverride) {
  const { key } = creds();
  const endpoint = endpointOverride || creds().endpoint;
  if (!key || !endpoint) throw new Error("Open Settings and add your RunPod endpoint ID and API key.");
  const res = server
    ? await fetchRetry(`/api/runpod/${endpointOverride && endpointOverride === server.editEndpoint ? "edit" : "main"}${path}`, {
      ...opts,
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
    })
    : await fetchRetry(`${API}/${endpoint}${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    if (server && res.status === 401 && body.error === "Not signed in") { location.replace("/"); throw new Error("Signed out. Sign in again."); }
    if (server && res.status === 400 && body.error) throw new Error(body.error);
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

// ---------- Storage (IndexedDB in this browser, optionally synced to Cloudflare R2) ----------
// "images" = gallery, "refs" = reference images, "chat" = chat messages, "library" = library entries.
// In the cloud each item is <prefix>/<id>.json; gallery images also have <prefix>/<id>.png.
const CLOUD_PREFIX = { images: "gallery", refs: "refs", chat: "chat", library: "library" };
let _idb = null;
async function idb() {
  if (_idb) return _idb;
  _idb = await new Promise((resolve, reject) => {
    const req = indexedDB.open("image-studio", 4);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const n of Object.keys(CLOUD_PREFIX)) if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _idb;
}
function makeStore(name) {
  const prefix = CLOUD_PREFIX[name];
  const tx = async (mode, fn) => {
    const d = await idb();
    return new Promise((resolve, reject) => {
      const t = d.transaction(name, mode);
      const out = fn(t.objectStore(name));
      t.oncomplete = () => resolve(out?.result ?? out);
      t.onerror = () => reject(t.error);
    });
  };
  const local = {
    put: (item) => tx("readwrite", (s) => s.put(item)),
    del: (id) => tx("readwrite", (s) => s.delete(id)),
    get: (id) => tx("readonly", (s) => s.get(id)),
    all: () => tx("readonly", (s) => s.getAll()),
  };
  const keysFor = (id) => name === "images" ? [`${prefix}/${id}.json`, `${prefix}/${id}.png`] : [`${prefix}/${id}.json`];

  async function push(item) {
    if (!cloud.configured()) return;
    const { blob, synced, ...meta } = item;
    if (blob) await cloud.put(`${prefix}/${item.id}.png`, blob, "image/png");
    await cloud.put(`${prefix}/${item.id}.json`, JSON.stringify(meta), "application/json");
    const cur = await local.get(item.id);
    if (cur) await local.put({ ...cur, synced: true });
  }
  async function deleteRemote(id) {
    if (!cloud.configured()) return;
    for (const k of keysFor(id)) {
      try { await cloud.del(k); } catch { pendingDeletes.add(k); }
    }
  }

  return {
    name, prefix, local, push,
    async add(item) {
      await local.put({ ...item, synced: false });
      push(item).then(() => syncStatus.ok(), (e) => syncStatus.fail(e));
    },
    async remove(id) { await local.del(id); deleteRemote(id); },
    all: local.all,
    async clear() {
      const all = await local.all();
      await tx("readwrite", (s) => s.clear());
      for (const it of all) deleteRemote(it.id);
    },
    // Two-way sync: upload new local items, download items from other devices,
    // and remove local items that were deleted on another device.
    async sync() {
      const remoteIds = new Set((await cloud.list(prefix + "/")).filter((k) => k.endsWith(".json")).map((k) => k.slice(prefix.length + 1, -5)));
      const locals = await local.all();
      let changed = false;
      for (const it of locals) {
        if (!it.synced) { await push(it); }
        else if (!remoteIds.has(it.id)) { await local.del(it.id); changed = true; }
      }
      const have = new Set(locals.map((i) => i.id));
      for (const id of remoteIds) {
        if (have.has(id)) continue;
        const res = await cloud.get(`${prefix}/${id}.json`);
        if (!res) continue;
        const item = await res.json();
        if (name === "images") {
          const img = await cloud.get(`${prefix}/${id}.png`);
          if (!img) continue;
          item.blob = new Blob([await img.arrayBuffer()], { type: "image/png" });
        }
        await local.put({ ...item, synced: true });
        changed = true;
      }
      return changed;
    },
  };
}
const db = makeStore("images");
const refDb = makeStore("refs");
const chatDb = makeStore("chat");
const libDb = makeStore("library");

// Remote deletes that failed (e.g. offline) are retried on the next sync.
const pendingDeletes = {
  load() { try { return JSON.parse(store.get("cloud_pending_deletes") || "[]"); } catch { return []; } },
  add(k) { const l = this.load(); if (!l.includes(k)) l.push(k); store.set("cloud_pending_deletes", JSON.stringify(l), true); },
  async flush() {
    const left = [];
    for (const k of this.load()) { try { await cloud.del(k); } catch { left.push(k); } }
    store.set("cloud_pending_deletes", JSON.stringify(left), true);
  },
};

const syncStatus = {
  set(text, cls) { const el = $("syncState"); if (!el) return; el.textContent = text; el.className = "conn " + (cls || ""); el.hidden = !cloud.configured(); },
  ok() { this.set(`Synced ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`, "ok"); },
  fail(e) { this.set("Sync error", "error"); this.lastError = e?.message || String(e); $("syncState").title = this.lastError; },
};

let syncing = null;
let lastSync = 0;
function syncAll() {
  if (!cloud.configured()) { syncStatus.set(""); return Promise.resolve(); }
  if (syncing) return syncing;
  syncStatus.set("Syncing…");
  syncing = (async () => {
    try {
      await pendingDeletes.flush();
      const changed = [];
      for (const st of [db, refDb, chatDb, libDb]) if (await st.sync()) changed.push(st.name);
      lastSync = Date.now();
      await checkStorage();
      syncStatus.ok();
      if (changed.length) await reloadAfterSync(changed);
    } catch (e) {
      syncStatus.fail(e);
      throw e;
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

// ---------- Storage meter ----------
// Cloudflare R2's free tier includes 10 GB; beyond that it's about $0.015 per GB per month.
const FREE_GB = 10;
let storageBytes = null;
async function checkStorage() {
  try { storageBytes = (await cloud.listDetailed("")).reduce((t, o) => t + o.size, 0); } catch { return; }
  store.set("cloud_bytes", String(storageBytes), true);
  showStorage();
}
function showStorage() {
  const b = storageBytes ?? Number(store.get("cloud_bytes") || NaN);
  const el = $("storageWarn");
  if (!cloud.configured() || !Number.isFinite(b)) { el.hidden = true; $("storageUse").textContent = ""; return; }
  const gb = b / 1e9, pct = Math.round((gb / FREE_GB) * 100);
  $("storageUse").textContent = `Cloud storage used: ${gb < 0.1 ? (b / 1e6).toFixed(0) + " MB" : gb.toFixed(2) + " GB"} of ${FREE_GB} GB free (${pct}%).`;
  let msg = "";
  if (gb >= FREE_GB) msg = `Cloud storage is ${gb.toFixed(1)} GB, past the ${FREE_GB} GB free tier. Cloudflare now charges about $${(Math.max(0, gb - FREE_GB) * 0.015).toFixed(2)}/month. Delete images you don't need, or export a backup and clear old ones.`;
  else if (gb >= FREE_GB * 0.8) msg = `Cloud storage is ${pct}% full (${gb.toFixed(1)} of ${FREE_GB} GB free). Consider deleting images you don't need.`;
  el.textContent = msg;
  el.hidden = !msg;
}

function cloudCreds() {
  return { endpoint: store.get("r2_endpoint") || "", bucket: store.get("r2_bucket") || "image-studio",
    keyId: store.get("r2_key_id") || "", secret: store.get("r2_secret") || "" };
}
// Accepts the full S3 URL Cloudflare shows (https://<account>.r2.cloudflarestorage.com) or just the account ID.
function applyCloudCreds() {
  if (server) { cloud.configureServer(); return; }
  const c = cloudCreds();
  const account = (c.endpoint.match(/([0-9a-f]{32})/i) || [])[1] || "";
  cloud.configure(account && c.keyId && c.secret ? { account, bucket: c.bucket, keyId: c.keyId, secret: c.secret } : null);
}

// ---------- UI state ----------
let size = "1:1";
let currentJob = null;
let urls = new Map(); // image id -> object URL
let refs = []; // [{ id, dataUrl, added }]

let view = "chat";
// Every picture is made with Qwen-Image 2.1 (MAIN_MODEL); attached images are its references, used as the
// prompt says ("the woman from image 1", "in the pose from image 2", "change her shirt in image 1").
const MAIN_MODEL = "qwen-image-21";
function refMode() { return refs.length ? "refs" : "none"; }
// In chat view the panel's own reference mode is not used, so the model picker is always free.
function effectiveModelId() { return MAIN_MODEL; }

function initControls() {
  const sizes = $("sizes");
  for (const k of ["Auto", ...Object.keys(SIZES)]) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.textContent = k;
    b.setAttribute("role", "radio");
    b.addEventListener("click", () => setSize(k));
    sizes.append(b);
  }
  setSize(store.get("ui_size") || "Auto");

  $("prompt").value = store.get("ui_prompt") || "";
  $("prompt").addEventListener("input", () => { store.set("ui_prompt", $("prompt").value, true); updateLoraPreview(); });

  applyRefMode(false);
}

function applyRefMode() {
  applyModel();
  renderRefs();
}

// "Auto": with an attached image, the picture takes image 1's shape (right for edits); a hogtie is landscape
// (sizeForLoras); otherwise square.
function setSize(k) {
  if (k !== "Auto" && !SIZES[k]) k = "Auto";
  size = k;
  store.set("ui_size", k, true);
  for (const b of $("sizes").children) b.setAttribute("aria-checked", String(b.textContent === k));
}

function applyModel() {
  renderLoras();
}

// ---------- LoRA add-ons ----------
// Saved per browser as { _auto, [loraId]: { on, strength } }. _auto (default on) picks add-ons from the prompt.
function loraState() {
  try { return JSON.parse(store.get("ui_loras") || "{}") || {}; } catch { return {}; }
}
function saveLoraState(st) { store.set("ui_loras", JSON.stringify(st), true); }
function loraSettings(id, st = loraState()) {
  const l = LORAS[id];
  return { on: !!st[id]?.on, strength: clampNum(st[id]?.strength, 0.05, 1.5, l.strength) };
}
function loraAuto(st = loraState()) { return st._auto !== false; }
// The LoRAs to use with this model, as { id, label, file, strength }: picked from the prompt in
// automatic mode, otherwise the ticked ones.
function activeLoras(modelId, prompt) {
  const st = loraState();
  if (loraAuto(st)) return autoLoras(prompt, modelId);
  return Object.entries(LORAS)
    .filter(([id, l]) => l.models.includes(modelId) && loraSettings(id, st).on)
    .map(([id, l]) => ({ id, label: l.label, file: loraFile(l, modelId), strength: loraSettings(id, st).strength }));
}
function renderLoras() {
  const modelId = effectiveModelId();
  const list = $("loraList");
  list.textContent = "";
  const usable = Object.entries(LORAS).filter(([, l]) => l.models.includes(modelId));
  $("loraWrap").hidden = !usable.length;
  if (!usable.length) return;
  const auto = loraAuto();
  const autoRow = document.createElement("div");
  autoRow.className = "lora-row";
  const autoLab = document.createElement("label");
  autoLab.className = "lora-name";
  const autoCb = document.createElement("input");
  autoCb.type = "checkbox";
  autoCb.checked = auto;
  autoLab.append(autoCb, " On (recommended)");
  const preview = document.createElement("p");
  preview.className = "hint";
  preview.id = "loraAutoPreview";
  autoCb.addEventListener("change", () => {
    const st = loraState();
    st._auto = autoCb.checked;
    saveLoraState(st);
    renderLoras();
  });
  autoRow.append(autoLab, preview);
  list.append(autoRow);
  updateLoraPreview();
  if (auto) return;
  for (const [id, l] of usable) {
    const cur = loraSettings(id);
    const row = document.createElement("div");
    row.className = "lora-row";
    const lab = document.createElement("label");
    lab.className = "lora-name";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = cur.on;
    lab.append(cb, " " + l.label);
    const num = document.createElement("input");
    num.type = "number"; num.min = "0.05"; num.max = "1.5"; num.step = "0.05";
    num.value = cur.strength;
    num.setAttribute("aria-label", `${l.label} strength`);
    num.disabled = !cur.on;
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = l.note;
    const update = () => {
      const st = loraState();
      st[id] = { on: cb.checked, strength: clampNum(num.value, 0.05, 1.5, l.strength) };
      saveLoraState(st);
      num.disabled = !cb.checked;
    };
    cb.addEventListener("change", update);
    num.addEventListener("change", update);
    row.append(lab, num, note);
    list.append(row);
  }
}

// Shows which add-ons automatic mode will use for the prompt being typed.
function updateLoraPreview() {
  const el = document.getElementById("loraAutoPreview");
  if (!el) return;
  if (!loraAuto()) { el.textContent = "Off: pick add-ons below."; return; }
  const prompt = (view === "chat" ? $("chatInput") : $("prompt")).value;
  const picked = autoLoras(prompt, effectiveModelId());
  el.textContent = "";
}

function setStatus(msg, isError = false) {
  $("status").textContent = msg;
  $("status").classList.toggle("error", isError);
}

// ---------- Generation ----------
// Builds the job settings from the left panel plus a prompt and reference images.
// Throws an Error with a user-facing message if something is missing.
function prepareSettings(prompt, refList, mode = refMode()) {
  const modelId = MAIN_MODEL;
  const m = MODELS[modelId];
  if (!prompt) throw new Error("Write a prompt first.");
  const useRefs = mode === "none" ? [] : refList.slice(0, REF_MODES.refs.maxImages);
  const flagged = checkPrompt(prompt);
  if (flagged) throw new Error(`This studio only creates images of adults. Remove "${flagged}" from the prompt.`);

  const loras = activeLoras(modelId, prompt);
  // A lying-down pose (hogtie) comes out sitting or kneeling in a tall frame, so it uses landscape.
  const wide = sizeForLoras(2, 3, loras, prompt)[0] === 3;
  let [width, height] = SIZES[size] || SIZES["1:1"];
  let followImage1 = false, turnedWide = false;
  const edit = useRefs.length > 0 && isEditPrompt(prompt);
  if (size === "Auto") {
    if (edit) followImage1 = true; // keeps image 1's shape, so the edit lines up
    else if (wide) [width, height] = SIZES["3:2"];
  } else if (wide && height > width) {
    [width, height] = [height, width];
    turnedWide = true;
  }
  const seedInput = $("seed").value.trim();
  const settings = {
    model: modelId,
    prompt,
    negative: "",
    width, height, followImage1, turnedWide, sizeChoice: size,
    count: Number($("count").value),
    steps: m.defaults.steps,
    cfg: m.defaults.cfg,
    seed: seedInput ? Number(seedInput) : Math.floor(Math.random() * 2 ** 48),
    refMode: useRefs.length ? "refs" : "none",
    refCount: useRefs.length,
    refStrength: null,
    refNames: useRefs.map((r) => `studio_ref_${r.id}.jpg`),
    loras,
    loraAuto: loraAuto(),
  };
  // Automatic mode also spells out the pose and gag the way the LoRA was trained (kept apart from the
  // prompt, so reusing an image's settings doesn't repeat it).
  if (settings.loraAuto) settings.promptExtra = loraPromptHints(prompt, settings.loras, edit);
  return { settings, useRefs };
}

// Runs a generation and saves the results to the gallery. Returns { items, summary }.
async function executeGeneration(settings, useRefs, onStatus) {
  const started = Date.now();
  onStatus(useRefs.length ? "Uploading reference images and sending job…" : "Sending job to RunPod…");
  const built = { ...settings, prompt: settings.prompt + (settings.promptExtra || "") };
  const workflow = applyLoras(applyReference(MODELS[settings.model].build(built), built), settings.loras);
  const input = { workflow };
  if (useRefs.length) input.images = useRefs.map((r, i) => ({ name: settings.refNames[i], image: r.dataUrl }));
  const result = await runJob(input, (st, secs) => {
    if (st === "IN_QUEUE") onStatus(waitText(secs));
    else onStatus(`Generating… ${secs}s`);
  }, true, endpointFor(settings.model));
  if (result.status !== "COMPLETED") throw new Error(describeFailure(result));
  const images = extractImages(result.output);
  if (!images.length) throw new Error("The job finished but returned no images. " + JSON.stringify(result.output).slice(0, 300));

  const items = [];
  for (const [i, b64] of images.entries()) {
    const item = { id: `${Date.now()}-${i}`, created: Date.now(), blob: b64ToBlob(b64), settings: { ...settings, index: i } };
    await db.add(item);
    items.push(item);
  }
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  // Kept short; the full details (model, add-ons, size) are in the gallery's picture view.
  const wideText = settings.turnedWide ? " · made wide for this pose" : "";
  return { items, summary: `Done in ${secs} s · picture no. ${settings.seed}${wideText}` };
}

const waitText = (secs) => `Waiting for a GPU worker… ${secs}s\n(The first job after a while idle takes about 1–2 minutes while the worker starts up and loads the model. Tip: press “Wake up GPU” when you sit down.)`;

async function generate() {
  if (currentJob || busy) return;
  let prep;
  const lib = applyLibrary($("prompt").value.trim(), refs.slice(0, REF_MODES[refMode()].maxImages || 0), refMode(), "Studio");
  try { prep = prepareSettings(lib.prompt, lib.atts, lib.mode); }
  catch (e) { return setStatus(e.message, true); }
  const { settings, useRefs } = prep;
  setBusy(true);
  const placeholders = addPlaceholders(settings.count, settings.width / settings.height);
  try {
    const { summary } = await executeGeneration(settings, useRefs, (m) => setStatus(m));
    setStatus(summary);
  } catch (e) {
    setStatus(e.message || String(e), true);
  } finally {
    placeholders.forEach((p) => p.remove());
    currentJob = null;
    setBusy(false);
    renderGallery();
  }
}

// Sends a job and polls until it finishes. onProgress(status, seconds) is called while waiting.
let currentEndpoint = null;
async function runJob(input, onProgress, track = true, endpoint) {
  const started = Date.now();
  const job = await rp("/run", { method: "POST", body: JSON.stringify({ input }) }, endpoint);
  if (track) { currentJob = job.id; currentEndpoint = endpoint; }
  while (true) {
    await sleep(2000);
    if (track && currentJob !== job.id) throw new Error("Cancelled.");
    const result = await rp(`/status/${job.id}`, {}, endpoint);
    if (result.status === "IN_QUEUE" || result.status === "IN_PROGRESS") {
      onProgress?.(result.status, Math.round((Date.now() - started) / 1000));
    } else return result;
  }
}

// ---------- Wake up GPU ----------
let waking = false;
async function wake() {
  if (waking) return;
  const btn = $("wake");
  waking = true;
  btn.disabled = true;
  btn.classList.remove("ready");
  try {
    // Warm the GPU and the model on the endpoint that runs it.
    const ids = [effectiveModelId()];
    const rs = await Promise.all(ids.map((id) => runJob({ workflow: warmupWorkflow(id) }, (st, secs) => {
      btn.textContent = st === "IN_QUEUE" ? `Starting up… ${secs}s` : "Almost ready…";
    }, false, endpointFor(id))));
    const r = rs.find((x) => x.status !== "COMPLETED");
    if (r) throw new Error(describeFailure(r));
    btn.textContent = "Ready";
    btn.classList.add("ready");
    btn.title = "Ready. It stays on for 5 minutes after each picture, then switches off to save money.";
    // The image endpoint keeps a worker on for 5 minutes after its last job (RunPod idle timeout, 300 s).
    setTimeout(() => { btn.textContent = "Warm up"; btn.classList.remove("ready"); }, 300000);
  } catch (e) {
    btn.textContent = "Warm up";
    setStatus("Wake-up failed: " + (e.message || e), true);
  } finally {
    waking = false;
    btn.disabled = false;
  }
}

async function cancel() {
  const id = currentJob;
  currentJob = null;
  if (id) { try { await rp(`/cancel/${id}`, { method: "POST" }, currentEndpoint); } catch {} }
  setStatus("Cancelled.");
}

function describeFailure(r) {
  const err = r.error || r.output?.error || "";
  const msg = typeof err === "string" ? err : JSON.stringify(err);
  const missingLora = Object.values(LORAS).find((l) => [l.file, ...Object.values(l.files || {})].some((f) => f && msg.includes(f)));
  if (missingLora && /not in list|value_not_in_list|lora_name/i.test(msg)) {
    return `The worker doesn't have the “${missingLora.label}” LoRA installed. Run worker/download-loras.sh on a Pod with the network volume attached (see the guide), or untick it.\n\nDetails: ` + msg.slice(0, 300);
  }
  if (/not in list|value_not_in_list|unet_name|clip_name|lora_name|model_patch/i.test(msg)) {
    return "The worker doesn't have this model installed. If you picked a model marked “after upgrade”, finish Step 6 of the guide first.\n\nDetails: " + msg.slice(0, 400);
  }
  if (/not reachable|HTTP unreachable|websocket reconnect/i.test(msg)) {
    return "The GPU worker crashed (usually it ran out of memory after loading several large models). Wait about a minute for it to shut down, then press Retry.\n\nDetails: " + msg.slice(0, 300);
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

// Select mode: tapping pictures ticks them for deleting several at once.
let selecting = false;
const selected = new Set(); // picture ids
let galleryIds = [];

function updateGalleryBar() {
  $("gallery").classList.toggle("selecting", selecting);
  $("gSelect").hidden = selecting || !galleryIds.length;
  for (const id of ["gCount", "gAll", "gDelete", "gCancel"]) $(id).hidden = !selecting;
  $("gCount").textContent = selected.size ? `${selected.size} selected` : "Tap pictures to select them";
  $("gDelete").disabled = !selected.size;
  $("gDelete").textContent = selected.size ? `Delete ${selected.size}` : "Delete";
  $("gAll").textContent = selected.size && selected.size === galleryIds.length ? "Select none" : "Select all";
}
function setSelecting(on) {
  selecting = on;
  selected.clear();
  for (const t of $("gallery").querySelectorAll(".tile.selected")) { t.classList.remove("selected"); t.setAttribute("aria-pressed", "false"); }
  updateGalleryBar();
}
function initGallerySelect() {
  $("gSelect").addEventListener("click", () => setSelecting(true));
  $("gCancel").addEventListener("click", () => setSelecting(false));
  $("gAll").addEventListener("click", () => {
    const all = selected.size !== galleryIds.length;
    selected.clear();
    if (all) galleryIds.forEach((id) => selected.add(id));
    for (const t of $("gallery").querySelectorAll(".tile[data-id]")) {
      t.classList.toggle("selected", all);
      t.setAttribute("aria-pressed", String(all));
    }
    updateGalleryBar();
  });
  $("gDelete").addEventListener("click", async () => {
    const n = selected.size;
    if (!n || !confirm(`Delete ${n} picture${n > 1 ? "s" : ""} from your gallery? This can't be undone.`)) return;
    $("gDelete").disabled = true;
    for (const id of [...selected]) await db.remove(id);
    setSelecting(false);
    await renderGallery();
    if (view === "chat") renderThread();
    setStatus(`Deleted ${n} picture${n > 1 ? "s" : ""}.`);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && selecting && view === "studio" && !document.querySelector("dialog[open]")) setSelecting(false);
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
    b.className = "tile" + (selected.has(item.id) ? " selected" : "");
    b.dataset.id = item.id;
    b.setAttribute("aria-pressed", String(selected.has(item.id)));
    b.style.aspectRatio = `${item.settings.width} / ${item.settings.height}`;
    const img = document.createElement("img");
    img.src = urls.get(item.id);
    img.alt = item.settings.prompt.slice(0, 120);
    img.loading = "lazy";
    b.append(img);
    b.addEventListener("click", () => {
      if (!selecting) return openViewer(item);
      const on = !selected.has(item.id);
      if (on) selected.add(item.id); else selected.delete(item.id);
      b.classList.toggle("selected", on);
      b.setAttribute("aria-pressed", String(on));
      updateGalleryBar();
    });
    g.append(b);
  }
  // Pictures deleted elsewhere (e.g. another device via sync) drop out of the selection.
  galleryIds = items.map((i) => i.id);
  for (const id of [...selected]) if (!seen.has(id)) selected.delete(id);
  updateGalleryBar();
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
    `${MODELS[s.model]?.label || s.model} · ${s.width}×${s.height} · seed ${s.seed}${s.index ? ` (+${s.index} in batch)` : ""} · ${s.steps} steps · CFG ${s.cfg}${s.refMode && s.refMode !== "none" ? ` · ${REF_MODES[s.refMode]?.label || "Reference images"} (${s.refCount} image${s.refCount > 1 ? "s" : ""}${s.refStrength != null ? `, strength ${s.refStrength}` : ""})` : ""}\n${s.prompt}`;
  $("vDownload").href = urls.get(item.id);
  $("vDownload").download = `studio-${s.seed}-${item.id}.png`;
  $("viewer").showModal();
}

function reuse(item) {
  const s = item.settings;
  if (view !== "chat") setView("chat");
  // Images made with an older model reuse their prompt, seed and size with Qwen-Image 2.1.
  const panelModel = MAIN_MODEL;
  $("prompt").value = s.prompt; store.set("ui_prompt", s.prompt, true);
  if (view === "chat") { $("chatInput").value = s.prompt; $("chatInput").dispatchEvent(new Event("input")); }
  const sizeKey = s.sizeChoice || Object.keys(SIZES).find((k) => SIZES[k][0] === s.width && SIZES[k][1] === s.height);
  if (sizeKey) setSize(sizeKey);
  $("seed").value = s.seed;
  $("count").value = "1";
  if (s.loraAuto) {
    const st = loraState();
    st._auto = true;
    saveLoraState(st);
    renderLoras();
  } else if (Array.isArray(s.loras)) {
    const st = loraState();
    st._auto = false;
    for (const id of Object.keys(LORAS)) {
      if (!LORAS[id].models.includes(panelModel)) continue;
      const used = s.loras.find((l) => l.id === id);
      st[id] = { on: !!used, strength: used ? used.strength : loraSettings(id, st).strength };
    }
    saveLoraState(st);
    renderLoras();
  }
  setStatus("Settings loaded. Keep the seed to recreate this image, or clear it for a new variation." +
    (s.refMode && s.refMode !== "none" ? " Reference images aren't saved with gallery images; check the ones shown are the ones you want." : ""));
}

// ---------- Reference images ----------
function consentGiven() { return store.get("ref_consent") === "1"; }
function askConsent() {
  if (consentGiven()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const d = $("refConsent");
    d.addEventListener("close", () => {
      const ok = d.returnValue === "yes";
      if (ok) store.set("ref_consent", "1", true);
      resolve(ok);
    }, { once: true });
    d.returnValue = "";
    d.showModal();
  });
}

// Shrinks an image so its longer side is at most 1536px and returns a JPEG data URL.
// Keeps uploads well under RunPod's 10 MB request limit.
async function prepareImage(blob) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, 1536 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c.toDataURL("image/jpeg", 0.92);
}

async function addRefs(files) {
  files = [...files].filter((f) => f.type.startsWith("image/"));
  if (!files.length) return;
  if (!(await askConsent())) return;
  for (const f of files) {
    try {
      const item = { id: `${Date.now()}${Math.floor(Math.random() * 1000)}`, dataUrl: await prepareImage(f), added: Date.now() };
      if (refs.length >= MAX_REFS) { setStatus(`Up to ${MAX_REFS} reference images. Remove one (×) to add another.`, true); break; }
      refs.push(item);
      await refDb.add(item);
    } catch {
      setStatus("Couldn't read that image. Try a JPG or PNG.", true);
    }
  }
  renderRefs();
}

const MAX_REFS = 3;

// Draws reference thumbnails. In a 1-image mode only the first is used; clicking another moves it first.
// onRemove(item) and onReorder(newList) update the caller's list.
function drawThumbs(list, items, mode, hintEl, onRemove, onReorder, onUseAll) {
  list.textContent = "";
  const max = REF_MODES[mode]?.maxImages || 1;
  items.forEach((r, i) => {
    const used = i < max;
    const d = document.createElement("div");
    d.className = "ref" + (used ? "" : " unused");
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "ref-pick";
    pick.title = used ? (max > 1 ? `image ${i + 1}` : "This image will be used") : "Click to use this image instead";
    pick.disabled = used;
    const img = document.createElement("img");
    img.src = r.dataUrl;
    img.alt = `Reference image ${i + 1}`;
    pick.append(img);
    pick.addEventListener("click", () => { if (!used) onReorder([r, ...items.filter((y) => y !== r)]); });
    const x = document.createElement("button");
    x.type = "button";
    x.className = "ref-x";
    x.textContent = "×";
    x.title = "Remove";
    x.setAttribute("aria-label", `Remove reference image ${i + 1}`);
    x.addEventListener("click", () => onRemove(r));
    const cap = document.createElement("span");
    cap.textContent = max > 1 ? (used ? `image ${i + 1}` : "not used") : (used ? "using" : "not used");
    d.append(pick, x, cap);
    list.append(d);
  });

  hintEl.textContent = "";
  if (items.length > max) {
    hintEl.append(max === 1
      ? "This mode uses one image (the first). Click another thumbnail to use it instead, or "
      : `This mode uses up to ${max} images. `);
    if (max === 1) {
      const a = document.createElement("button");
      a.type = "button";
      a.className = "linkish";
      a.textContent = "use all images together";
      a.addEventListener("click", onUseAll);
      hintEl.append(a, " (Character / scene reference, needs the Step 6 upgrade).");
    }
  }
  hintEl.hidden = !hintEl.textContent;
}

function renderRefs() {
  drawThumbs($("refList"), refs, refMode(), $("refHint"),
    async (r) => { await refDb.remove(r.id); refs = refs.filter((y) => y !== r); renderRefs(); },
    async (list) => {
      // Re-save with new order so it persists.
      const t = Date.now();
      refs = list.map((r, i) => ({ ...r, added: t + i }));
      for (const r of refs) await refDb.add(r);
      renderRefs();
    },
    () => {});
  $("refAdd").hidden = refs.length >= MAX_REFS;
}

function initRefs() {
  $("refFile").addEventListener("change", (e) => { addRefs(e.target.files); e.target.value = ""; });
  const wrap = $("refWrap");
  wrap.addEventListener("dragover", (e) => { e.preventDefault(); wrap.classList.add("drag"); });
  wrap.addEventListener("dragleave", () => wrap.classList.remove("drag"));
  wrap.addEventListener("drop", (e) => { e.preventDefault(); wrap.classList.remove("drag"); addRefs(e.dataTransfer.files); });
  document.addEventListener("paste", (e) => {
    if ($("libEditor").open) {
      const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
      if (files.length) { e.preventDefault(); addLibImages(files); }
      return;
    }
    if (view === "chat") {
      const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
      if (files.length) { e.preventDefault(); addChatAttachments(files); }
      return;
    }
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addRefs(files); }
  });
  refDb.all().then((all) => { refs = all.sort((a, b) => a.added - b.added); renderRefs(); }).catch(() => {});
}

// "Use as reference" from the gallery: attach the picture in the chat, where pictures are made.
async function useAsReference(item) {
  return editInChat(item);
}

// ---------- Chat ----------
// Messages: { id, created, role: "user" | "assistant", text, attachments: [dataUrl], mode, imageIds: [], error, summary }
let messages = [];
let chatAttach = []; // [{ id, dataUrl }]
let pending = null; // { status } while a chat job runs

// ---------- Options drawer (menu button) ----------
function setDrawer(open) {
  $("drawer").classList.toggle("open", open);
  $("drawerBackdrop").hidden = !open;
  $("menuBtn").setAttribute("aria-expanded", String(open));
  if (open) $("drawerClose").focus();
}
function initDrawer() {
  $("menuBtn").addEventListener("click", () => setDrawer(!$("drawer").classList.contains("open")));
  $("drawerClose").addEventListener("click", () => { setDrawer(false); $("menuBtn").focus(); });
  $("drawerBackdrop").addEventListener("click", () => setDrawer(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("drawer").classList.contains("open") && !document.querySelector("dialog[open]")) setDrawer(false);
  });
  // Opening Settings or starting a new chat from the drawer closes it.
  $("openSettings").addEventListener("click", () => setDrawer(false));
  $("newChat").addEventListener("click", () => setDrawer(false));
}

function setView(v) {
  if (selecting) setSelecting(false);
  view = ["studio", "library"].includes(v) ? v : "chat";
  store.set("ui_view", view, true);
  document.body.dataset.view = view;
  $("tabChat").setAttribute("aria-selected", String(view === "chat"));
  $("tabGallery").setAttribute("aria-selected", String(view === "studio"));
  $("tabLibrary").setAttribute("aria-selected", String(view === "library"));
  $("chatView").hidden = view !== "chat";
  $("galleryView").hidden = view !== "studio";
  $("libraryView").hidden = view !== "library";
  applyRefMode(false);
  if (view === "chat") renderThread(); // also picks up chat changes synced while on another tab
}

function initChat() {
  $("tabChat").addEventListener("click", () => setView("chat"));
  $("tabGallery").addEventListener("click", () => setView("studio"));
  $("tabLibrary").addEventListener("click", () => setView("library"));
  $("newChat").addEventListener("click", async () => {
    if (pending) return;
    await chatDb.clear();
    messages = [];
    renderThread();
  });

  const input = $("chatInput");
  const grow = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 200) + "px"; };
  input.addEventListener("input", () => { grow(); updateLoraPreview(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat(); }
  });
  $("composer").addEventListener("submit", (e) => { e.preventDefault(); pending ? cancel() : sendChat(); });
  $("chatFile").addEventListener("change", (e) => { addChatAttachments(e.target.files); e.target.value = ""; });

  const chat = $("chatView");
  chat.addEventListener("dragover", (e) => { e.preventDefault(); $("composer").classList.add("drag"); });
  chat.addEventListener("dragleave", (e) => { if (!chat.contains(e.relatedTarget)) $("composer").classList.remove("drag"); });
  chat.addEventListener("drop", (e) => { e.preventDefault(); $("composer").classList.remove("drag"); addChatAttachments(e.dataTransfer.files); });

  chatDb.all().then((all) => { messages = all.sort((a, b) => a.created - b.created); renderThread(); }).catch(() => renderThread());
}

async function addChatAttachments(files) {
  files = [...files].filter((f) => f.type.startsWith("image/"));
  if (!files.length) return;
  if (!(await askConsent())) return;
  for (const f of files) {
    let dataUrl;
    try { dataUrl = await prepareImage(f); }
    catch { setStatus("Couldn't read that image. Try a JPG or PNG.", true); continue; }
    // Checked after the await so two quick pastes can't both slip past the limit.
    if (chatAttach.length >= MAX_REFS) { renderAttachments(); return flashAttachHint(`Up to ${MAX_REFS} images per message. Remove one (×) to add another.`); }
    chatAttach.push({ id: `${Date.now()}${Math.floor(Math.random() * 1000)}`, dataUrl });
  }
  renderAttachments();
  $("chatInput").focus();
}

function renderAttachments() {
  $("attachRow").hidden = !chatAttach.length;
  drawThumbs($("attachList"), chatAttach, "refs", $("attachHint"),
    (a) => { chatAttach = chatAttach.filter((y) => y !== a); renderAttachments(); },
    (list) => { chatAttach = list; renderAttachments(); },
    () => {});
}
function flashAttachHint(msg) {
  const h = $("attachHint");
  h.textContent = msg;
  h.hidden = false;
}

async function sendChat(retryOf) {
  if (pending || busy) return;
  const text = retryOf ? retryOf.text : $("chatInput").value.trim();
  if (!text) { $("chatInput").focus(); return; }
  // A retry resends exactly what was sent before; a new message gets library terms applied.
  const lib = retryOf
    ? { prompt: retryOf.prompt || retryOf.text, atts: retryOf.attachments.map((dataUrl, i) => ({ id: `${retryOf.id}${i}`, dataUrl })), mode: retryOf.mode, used: retryOf.library || [] }
    : applyLibrary(text, chatAttach.slice(), chatAttach.length ? "refs" : "none");
  const mode = lib.mode;

  let prep;
  try { prep = prepareSettings(lib.prompt, lib.atts, mode); }
  catch (e) {
    messages.push({ id: `e${Date.now()}`, created: Date.now(), role: "assistant", error: e.message, local: true });
    return renderThread();
  }

  let userMsg = retryOf;
  if (!retryOf) {
    userMsg = { id: `u${Date.now()}`, created: Date.now(), role: "user", text, prompt: lib.prompt, mode,
      library: lib.used, attachments: prep.useRefs.map((r) => r.dataUrl) };
    messages.push(userMsg);
    await chatDb.add(userMsg);
    $("chatInput").value = "";
    $("chatInput").style.height = "";
    chatAttach = [];
    renderAttachments();
    libChoice.clear();
    updateChips();
  }

  pending = { status: "Sending…" };
  setBusy(true);
  renderThread();
  const reply = { id: `a${Date.now()}`, created: Date.now(), role: "assistant", replyTo: userMsg.id };
  try {
    const { items, summary } = await executeGeneration(prep.settings, prep.useRefs, (m) => {
      pending.status = m;
      const el = document.getElementById("pendingStatus");
      if (el) el.textContent = m;
    });
    reply.imageIds = items.map((i) => i.id);
    reply.summary = summary;
  } catch (e) {
    reply.error = e.message || String(e);
  } finally {
    pending = null;
    currentJob = null;
    setBusy(false);
  }
  messages.push(reply);
  await chatDb.add(reply);
  renderThread();
  renderGallery();
}

async function renderThread() {
  const thread = $("thread");
  const items = new Map((await db.all()).map((i) => [i.id, i]));
  thread.querySelectorAll(".msg").forEach((m) => m.remove());
  $("chatEmpty").hidden = messages.length > 0 || !!pending;

  for (const msg of messages) {
    const el = document.createElement("div");
    el.className = `msg ${msg.role}`;
    if (msg.role === "user") {
      if (msg.attachments?.length) {
        const a = document.createElement("div");
        a.className = "msg-attach";
        for (const src of msg.attachments) {
          const img = document.createElement("img");
          img.src = src; img.alt = "Attached image";
          a.append(img);
        }
        el.append(a);
      }
      const b = document.createElement("div");
      b.className = "bubble";
      b.textContent = msg.text;
      el.append(b);
      const notes = [];
      if (msg.library?.length) notes.push("Library: " + msg.library.join(", "));
      if (notes.length) el.append(meta(notes.join(" · ")));
    } else if (msg.error) {
      el.append(meta(msg.error, true));
      const orig = messages.find((m) => m.id === msg.replyTo);
      if (orig) {
        const acts = document.createElement("div");
        acts.className = "msg-actions";
        acts.append(btn("Retry", () => sendChat(orig)));
        el.append(acts);
      }
    } else {
      const grid = document.createElement("div");
      grid.className = "results";
      for (const id of msg.imageIds || []) {
        const item = items.get(id);
        const r = document.createElement("div");
        r.className = "result";
        if (!item) { r.append(meta("(deleted from gallery)")); grid.append(r); continue; }
        if (!urls.has(id)) urls.set(id, URL.createObjectURL(item.blob));
        const open = document.createElement("button");
        open.type = "button";
        open.setAttribute("aria-label", "View full size");
        const img = document.createElement("img");
        img.src = urls.get(id);
        img.alt = item.settings.prompt.slice(0, 120);
        img.width = item.settings.width; img.height = item.settings.height;
        img.style.height = "auto";
        open.append(img);
        open.addEventListener("click", () => openViewer(item));
        const acts = document.createElement("div");
        acts.className = "result-actions";
        acts.append(btn("Edit", () => editInChat(item)));
        const dl = document.createElement("a");
        dl.className = "button ghost"; dl.textContent = "Download";
        dl.href = urls.get(id); dl.download = `studio-${item.settings.seed}-${id}.png`;
        dl.style.cssText = "padding:4px 10px;font-size:13px";
        acts.append(dl);
        r.append(open, acts);
        grid.append(r);
      }
      el.append(grid);
      if (msg.summary) el.append(meta(msg.summary));
    }
    thread.append(el);
  }

  if (pending) {
    const el = document.createElement("div");
    el.className = "msg assistant";
    const b = document.createElement("div");
    b.className = "bubble";
    b.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
    const st = meta(pending.status);
    st.id = "pendingStatus";
    st.style.whiteSpace = "pre-wrap";
    el.append(b, st);
    thread.append(el);
  }
  scrollThread();
}

function meta(text, isError) {
  const p = document.createElement("div");
  p.className = "meta" + (isError ? " error" : "");
  p.textContent = text;
  return p;
}
function btn(label, fn) {
  const b = document.createElement("button");
  b.type = "button"; b.className = "ghost"; b.textContent = label;
  b.addEventListener("click", fn);
  return b;
}
function scrollThread() { requestAnimationFrame(() => { const t = $("thread"); t.scrollTop = t.scrollHeight; }); }

async function editInChat(item) {
  if (view !== "chat") setView("chat");
  if (!(await askConsent())) return;
  if (chatAttach.length >= MAX_REFS) chatAttach.shift();
  chatAttach.push({ id: `${Date.now()}`, dataUrl: await prepareImage(item.blob) });
  renderAttachments();
  const input = $("chatInput");
  input.focus();
  input.placeholder = "Describe the changes…";
}

function updateChatBusy() {
  const b = $("chatSend");
  if (!b) return;
  b.textContent = pending ? "Stop" : "Send";
  b.classList.toggle("primary", !pending);
  b.classList.toggle("ghost", !!pending);
}

// ---------- Library ----------
// Entry: { id, name, aliases: [], description, images: [dataUrl], created }
let library = [];
const libChoice = new Map(); // entry id -> { on, image } for the message being written
let editing = null; // entry being edited (copy)

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function termsOf(e) { return [e.name, ...(e.aliases || [])].map((t) => t.trim()).filter(Boolean); }
function libraryMatches(text) {
  if (!text) return [];
  return library.filter((e) => termsOf(e).some((t) =>
    new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(t)}(s|es|ed)?(?=$|[^\\p{L}\\p{N}])`, "iu").test(text)));
}

// Adds matched library descriptions to the prompt and, when "+ example" is ticked, attaches the
// entry's first example image (switching to Character / scene reference, the mode that uses several images).
function applyLibrary(text, atts, mode) {
  let prompt = text;
  const out = atts.slice();
  const used = [];
  for (const e of libraryMatches(text)) {
    const ch = libChoice.get(e.id) || {};
    if (ch.on === false) continue;
    let line = e.description?.trim() ? `${e.name}: ${e.description.trim()}` : "";
    if (ch.image && e.images?.length && out.length < 3) {
      mode = "refs";
      out.push({ id: `lib${e.id}`, dataUrl: e.images[0] });
      const n = out.length;
      line += `${line ? " " : ""}The ${e.name} must look like the one shown in image ${n}. Use image ${n} only as a reference for the ${e.name}, not for the people or the setting.`;
      used.push(`${e.name} (+ example)`);
    } else used.push(e.name);
    if (line) prompt += `\n\n${line}`;
  }
  return { prompt, atts: out, mode, used };
}

function updateChips() {
  drawChips($("libChipsChat"), $("chatInput").value);
  drawChips($("libChipsStudio"), $("prompt").value);
}
function drawChips(box, text) {
  box.textContent = "";
  const matches = libraryMatches(text);
  box.hidden = !matches.length;
  for (const e of matches) {
    const ch = libChoice.get(e.id) || { on: true, image: false };
    const wrap = document.createElement("span");
    wrap.className = "lib-chip";
    const main = document.createElement("button");
    main.type = "button";
    main.textContent = "📖 " + e.name;
    main.setAttribute("aria-pressed", String(ch.on !== false));
    main.title = ch.on !== false ? `Adds your “${e.name}” description to the prompt. Click to skip it for this message.` : "Skipped for this message. Click to use it.";
    main.addEventListener("click", () => { libChoice.set(e.id, { ...ch, on: ch.on === false }); updateChips(); });
    wrap.append(main);
    if (e.images?.length && ch.on !== false) {
      const ex = document.createElement("button");
      ex.type = "button";
      ex.className = "ex";
      ex.textContent = ch.image ? "✓ example" : "+ example";
      ex.setAttribute("aria-pressed", String(!!ch.image));
      ex.title = "Attach this entry's first example image. Uses Character / scene reference mode (needs the Step 6 upgrade); a message can have 3 images in total.";
      ex.addEventListener("click", () => { libChoice.set(e.id, { ...ch, on: true, image: !ch.image }); updateChips(); });
      wrap.append(ex);
    }
    box.append(wrap);
  }
}

function renderLibrary() {
  const list = $("libList");
  list.textContent = "";
  $("libEmpty").hidden = library.length > 0;
  for (const e of [...library].sort((a, b) => a.name.localeCompare(b.name))) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "lib-card";
    if (e.images?.length) {
      const img = document.createElement("img");
      img.src = e.images[0]; img.alt = "";
      card.append(img);
    } else {
      const ph = document.createElement("span");
      ph.className = "noimg";
      card.append(ph);
    }
    const body = document.createElement("span");
    const t = document.createElement("strong");
    t.textContent = e.name;
    const al = document.createElement("span");
    al.className = "hint";
    al.textContent = [e.aliases?.length ? "Also: " + e.aliases.join(", ") : "", `${e.images?.length || 0} example image${e.images?.length === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
    const d = document.createElement("span");
    d.className = "hint";
    d.textContent = e.description || "No description";
    body.append(t, al, d);
    card.append(body);
    card.addEventListener("click", () => openLibEditor(e));
    list.append(card);
  }
}

function openLibEditor(entry) {
  editing = entry ? { ...entry, images: [...(entry.images || [])] } : { id: null, name: "", aliases: [], description: "", images: [] };
  $("libTitle").textContent = entry ? "Edit library entry" : "New library entry";
  $("libName").value = editing.name;
  $("libAliases").value = (editing.aliases || []).join(", ");
  $("libDesc").value = editing.description || "";
  $("libError").textContent = "";
  $("libDelete").hidden = !entry;
  renderLibImages();
  $("libEditor").showModal();
}
function renderLibImages() {
  const box = $("libImgs");
  box.textContent = "";
  editing.images.forEach((src, i) => {
    const d = document.createElement("div");
    d.className = "ref";
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "ref-pick";
    pick.title = i === 0 ? "Used as the reference" : "Click to make this the reference image";
    pick.disabled = i === 0;
    const img = document.createElement("img");
    img.src = src; img.alt = `Example ${i + 1}`;
    pick.append(img);
    pick.addEventListener("click", () => { editing.images.splice(i, 1); editing.images.unshift(src); renderLibImages(); });
    const x = document.createElement("button");
    x.type = "button"; x.className = "ref-x"; x.textContent = "×";
    x.setAttribute("aria-label", `Remove example ${i + 1}`);
    x.addEventListener("click", () => { editing.images.splice(i, 1); renderLibImages(); });
    const cap = document.createElement("span");
    cap.textContent = i === 0 ? "reference" : `example ${i + 1}`;
    d.append(pick, x, cap);
    box.append(d);
  });
}
async function addLibImages(files) {
  files = [...files].filter((f) => f.type.startsWith("image/"));
  if (!files.length || !editing) return;
  if (!(await askConsent())) return;
  if (!$("libEditor").open) $("libEditor").showModal();
  for (const f of files) {
    if (editing.images.length >= 6) { $("libError").textContent = "Up to 6 example images per entry."; break; }
    try { editing.images.push(await prepareImage(f)); } catch { $("libError").textContent = "Couldn't read that image. Try a JPG or PNG."; }
  }
  renderLibImages();
}
async function saveLibEntry() {
  const name = $("libName").value.trim();
  const aliases = $("libAliases").value.split(",").map((a) => a.trim()).filter(Boolean);
  const description = $("libDesc").value.trim();
  const err = $("libError");
  if (!name) { err.textContent = "Give the entry a term."; return; }
  const flagged = checkPrompt([name, ...aliases, description].join(" "));
  if (flagged) { err.textContent = `This studio only creates images of adults. Remove "${flagged}".`; return; }
  const clash = library.find((e) => e.id !== editing.id && termsOf(e).some((t) => [name, ...aliases].some((n) => n.toLowerCase() === t.toLowerCase())));
  if (clash) { err.textContent = `“${clash.name}” already uses one of these words.`; return; }
  const entry = { ...editing, id: editing.id || `${Date.now()}`, name, aliases, description, created: editing.created || Date.now() };
  delete entry.synced;
  await libDb.add(entry);
  library = library.filter((e) => e.id !== entry.id).concat(entry);
  $("libEditor").close();
  renderLibrary();
  updateChips();
}

function initLibrary() {
  $("libNew").addEventListener("click", () => openLibEditor(null));
  $("libSave").addEventListener("click", saveLibEntry);
  $("libDelete").addEventListener("click", async () => {
    if (!editing?.id || !confirm(`Delete “${editing.name}” from your library?`)) return;
    await libDb.remove(editing.id);
    library = library.filter((e) => e.id !== editing.id);
    $("libEditor").close();
    renderLibrary();
    updateChips();
  });
  $("libFile").addEventListener("change", (e) => { addLibImages(e.target.files); e.target.value = ""; });
  const ed = $("libEditor");
  ed.addEventListener("dragover", (e) => { e.preventDefault(); ed.classList.add("drag"); });
  ed.addEventListener("dragleave", (e) => { if (!ed.contains(e.relatedTarget)) ed.classList.remove("drag"); });
  ed.addEventListener("drop", (e) => { e.preventDefault(); ed.classList.remove("drag"); addLibImages(e.dataTransfer.files); });
  $("chatInput").addEventListener("input", updateChips);
  $("prompt").addEventListener("input", updateChips);
  libDb.all().then((all) => { library = all; renderLibrary(); updateChips(); }).catch(() => {});
}

// ---------- Settings dialog ----------
function initSettings() {
  const dlg = $("settings");
  $("openSettings").addEventListener("click", () => {
    const c = creds();
    $("endpointId").value = c.endpoint;
    $("editEndpointId").value = c.editEndpoint;
    $("apiKey").value = server ? "" : c.key;
    if (server) $("apiKey").placeholder = server.runpodKeySet ? "Saved on the server. Leave blank to keep it." : "rpa_…";
    $("pwCurrent").value = ""; $("pwNew").value = ""; $("pwResult").textContent = "";
    $("testResult").textContent = "";
    const cc = cloudCreds();
    $("r2Endpoint").value = cc.endpoint;
    $("r2Bucket").value = cc.bucket;
    $("r2KeyId").value = cc.keyId;
    $("r2Secret").value = cc.secret;
    $("syncResult").textContent = syncStatus.lastError && cloud.configured() ? "Last sync error: " + syncStatus.lastError : "";
    $("backupResult").textContent = "";
    dlg.showModal();
  });
  $("syncNow").addEventListener("click", async () => {
    saveCreds();
    const out = $("syncResult");
    out.classList.remove("error");
    if (!cloud.configured()) { out.textContent = "Fill in the endpoint URL, Access Key ID and Secret Access Key."; out.classList.add("error"); return; }
    out.textContent = "Syncing…";
    try {
      await syncAll();
      const n = (await db.all()).length, l = (await libDb.all()).length;
      out.textContent = `Synced. ${n} gallery image${n === 1 ? "" : "s"} and ${l} library entr${l === 1 ? "y" : "ies"} on this device.`;
      showStorage();
    } catch (e) {
      out.textContent = cloudErrorHelp(e);
      out.classList.add("error");
    }
  });
  $("syncOff").addEventListener("click", () => {
    for (const k of ["r2_endpoint", "r2_key_id", "r2_secret"]) store.del(k);
    $("r2KeyId").value = ""; $("r2Secret").value = "";
    applyCloudCreds();
    syncStatus.set("");
    updateStorageHint();
    showStorage();
    $("syncResult").textContent = "Sync turned off on this device. Your images stay here and in the bucket.";
  });
  $("exportBtn").addEventListener("click", exportBackup);
  $("importFile").addEventListener("change", (e) => { importBackup(e.target.files[0]); e.target.value = ""; });
  dlg.addEventListener("close", async () => {
    if (dlg.returnValue === "save") {
      try { await saveCreds(); } catch (e) { setStatus("Couldn't save settings: " + (e.message || e), true); }
    }
    updateConn();
  });
  $("testConn").addEventListener("click", async () => {
    const out = $("testResult");
    out.classList.remove("error");
    out.textContent = "Testing…";
    try {
      await saveCreds();
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
  $("pwChange").addEventListener("click", async () => {
    const out = $("pwResult");
    out.classList.remove("error");
    out.textContent = "Changing…";
    try {
      const r = await fetch("/api/password", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current: $("pwCurrent").value, next: $("pwNew").value }) });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(b.error || `Error ${r.status}`);
      $("pwCurrent").value = ""; $("pwNew").value = "";
      out.textContent = "Password changed. Other devices are signed out; this one stays signed in.";
    } catch (e) { out.textContent = e.message; out.classList.add("error"); }
  });
  $("signOut").addEventListener("click", async () => {
    if (!confirm("Sign out of this device?")) return;
    try { await fetch("/api/logout", { method: "POST", credentials: "same-origin" }); } catch {}
    location.replace("/");
  });
}

// Shows the parts of Settings that apply to how the app is being served.
function applyServerUi() {
  if (!server) return;
  for (const id of ["rememberRow", "r2Fields", "forget"]) $(id).hidden = true;
  $("serverAccount").hidden = false;
  $("keyHint").textContent = "Saved privately on your server, so you only enter them once for all your devices. They are never stored in this browser.";
  $("cloudTitle").textContent = "Storage";
  $("cloudHint").textContent = "Your gallery, chats, reference images and library are kept on your server and appear on every device you sign in on.";
}

async function saveServerCreds() {
  const body = { endpoint: $("endpointId").value.trim(), editEndpoint: $("editEndpointId").value.trim() };
  const key = $("apiKey").value.trim();
  if (key) body.runpodKey = key;
  const r = await fetch("/api/config", { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (r.status === 401) { location.replace("/"); throw new Error("Signed out. Sign in again."); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Error ${r.status}`);
  await detectServer();
  $("apiKey").value = "";
  $("apiKey").placeholder = server.runpodKeySet ? "Saved on the server. Leave blank to keep it." : "rpa_…";
}

function saveCreds() {
  if (server) return saveServerCreds();
  const remember = $("remember").checked;
  store.set("rp_endpoint", $("endpointId").value.trim(), remember);
  store.set("rp_edit_endpoint", $("editEndpointId").value.trim(), remember);
  store.set("rp_key", $("apiKey").value.trim(), remember);
  const before = JSON.stringify(cloudCreds());
  store.set("r2_endpoint", $("r2Endpoint").value.trim(), remember);
  store.set("r2_bucket", $("r2Bucket").value.trim() || "image-studio", remember);
  store.set("r2_key_id", $("r2KeyId").value.trim(), remember);
  store.set("r2_secret", $("r2Secret").value.trim(), remember);
  applyCloudCreds();
  updateStorageHint();
  if (JSON.stringify(cloudCreds()) !== before && cloud.configured()) syncAll().catch(() => {});
}

function cloudErrorHelp(e) {
  const m = e?.message || String(e);
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "Couldn't reach Cloudflare. Check the endpoint URL, and that the bucket's CORS policy allows this site.";
  if (/SignatureDoesNotMatch|InvalidAccessKeyId|Unauthorized|AccessDenied|403|401/i.test(m)) return "Cloudflare rejected the key. Check the Access Key ID and Secret, and that the key can read and write this bucket. (" + m + ")";
  if (/NoSuchBucket/i.test(m)) return "That bucket doesn't exist. Check the bucket name.";
  return m;
}

function updateStorageHint() {
  $("storageHint").textContent = cloud.configured() ? "Synced to your cloud storage" : "Saved only in this browser";
}

async function reloadAfterSync(changed) {
  if (changed.includes("refs")) { refs = (await refDb.all()).sort((a, b) => a.added - b.added); renderRefs(); }
  if (changed.includes("library")) { library = await libDb.all(); renderLibrary(); updateChips(); }
  if (changed.includes("chat") && !pending) messages = (await chatDb.all()).sort((a, b) => a.created - b.created);
  if (changed.includes("images") || changed.includes("chat")) { renderGallery(); if (view === "chat" && !pending) renderThread(); }
}

// ---------- Backup ----------
const blobToDataUrl = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
async function exportBackup() {
  const out = $("backupResult");
  out.classList.remove("error");
  out.textContent = "Preparing backup…";
  try {
    const images = [];
    for (const it of await db.all()) { const { blob, synced, ...rest } = it; images.push({ ...rest, png: await blobToDataUrl(blob) }); }
    const strip = (l) => l.map(({ synced, ...r }) => r);
    const data = { app: "image-studio", version: 1, exported: new Date().toISOString(), images,
      refs: strip(await refDb.all()), chat: strip(await chatDb.all()), library: strip(await libDb.all()) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = `image-studio-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    out.textContent = `Backup saved: ${images.length} images, ${data.library.length} library entries, ${data.chat.length} chat messages.`;
  } catch (e) { out.textContent = "Backup failed: " + e.message; out.classList.add("error"); }
}
async function importBackup(file) {
  const out = $("backupResult");
  out.classList.remove("error");
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== "image-studio") throw new Error("This isn't an Image Studio backup file.");
    let added = 0;
    const pairs = [[db, data.images], [refDb, data.refs], [chatDb, data.chat], [libDb, data.library]];
    for (const [st, list] of pairs) {
      const have = new Set((await st.all()).map((i) => i.id));
      for (const it of list || []) {
        if (have.has(it.id)) continue;
        const item = { ...it };
        if (st === db) { item.blob = b64ToBlob(item.png); delete item.png; }
        await st.add(item);
        added++;
      }
    }
    out.textContent = `Imported ${added} new item${added === 1 ? "" : "s"}.`;
    await reloadAfterSync(["images", "refs", "chat", "library"]);
  } catch (e) { out.textContent = "Import failed: " + e.message; out.classList.add("error"); }
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
let busy = false;
function setBusy(b) {
  busy = b;
  $("generate").disabled = b;
  $("cancel").hidden = !b;
  if (typeof updateChatBusy === "function") updateChatBusy();
}

// ---------- wire up ----------
(async () => {
  await detectServer();
  applyCloudCreds();
  showStorage();
  initControls();
  initDrawer();
  initGallerySelect();
  initRefs();
  initChat();
  initLibrary();
  updateStorageHint();
  setView(store.get("ui_view") || "chat");
  initSettings();
  applyServerUi();
  updateConn();
  renderGallery();
  syncAll().catch(() => {});
  if (!creds().key) setStatus("Not connected yet: open the menu (☰) and choose Settings.");
})();
// Pick up changes from other devices when you come back to this tab.
window.addEventListener("focus", () => { if (Date.now() - lastSync > 60000) syncAll().catch(() => {}); });
$("generate").addEventListener("click", generate);
$("cancel").addEventListener("click", cancel);
$("wake").addEventListener("click", wake);
$("vUseRef").addEventListener("click", () => { const it = viewing; $("viewer").close(); useAsReference(it); });

$("prompt").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) generate(); });
$("vClose").addEventListener("click", () => $("viewer").close());
$("vReuse").addEventListener("click", () => { reuse(viewing); $("viewer").close(); });
$("vDelete").addEventListener("click", async () => {
  if (!viewing || !confirm("Delete this image from your gallery?")) return;
  await db.remove(viewing.id);
  $("viewer").close();
  renderGallery();
  if (view === "chat") renderThread(); // removed images show as deleted
});
$("viewer").addEventListener("click", (e) => { if (e.target === $("viewer")) $("viewer").close(); });
