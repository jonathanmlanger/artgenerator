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
// "images" = gallery, "refs" = the current reference images (kept so characters persist between visits).
let _idb = null;
async function idb() {
  if (_idb) return _idb;
  _idb = await new Promise((resolve, reject) => {
    const req = indexedDB.open("image-studio", 3);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("images")) d.createObjectStore("images", { keyPath: "id" });
      if (!d.objectStoreNames.contains("refs")) d.createObjectStore("refs", { keyPath: "id" });
      if (!d.objectStoreNames.contains("chat")) d.createObjectStore("chat", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _idb;
}
function makeStore(name) {
  const tx = async (mode, fn) => {
    const d = await idb();
    return new Promise((resolve, reject) => {
      const t = d.transaction(name, mode);
      const out = fn(t.objectStore(name));
      t.oncomplete = () => resolve(out?.result ?? out);
      t.onerror = () => reject(t.error);
    });
  };
  return {
    add: (item) => tx("readwrite", (s) => s.put(item)),
    remove: (id) => tx("readwrite", (s) => s.delete(id)),
    all: () => tx("readonly", (s) => s.getAll()),
    clear: () => tx("readwrite", (s) => s.clear()),
  };
}
const db = makeStore("images");
const refDb = makeStore("refs");
const chatDb = makeStore("chat");

// ---------- UI state ----------
let size = "1:1";
let currentJob = null;
let urls = new Map(); // image id -> object URL
let refs = []; // [{ id, dataUrl, added }]

let view = "chat";
function refMode() { return $("refMode").value; }
// In chat view the panel's own reference mode is not used, so the model picker is always free.
function panelMode() { return view === "chat" ? "none" : refMode(); }
function effectiveModelId() { return REF_MODES[panelMode()]?.model || $("model").value; }

function initControls() {
  const modelSel = $("model");
  for (const [id, m] of Object.entries(MODELS)) {
    if (m.hidden) continue;
    const o = document.createElement("option");
    o.value = id;
    o.textContent = m.label + (m.needsUpgrade ? " (after upgrade)" : "");
    modelSel.append(o);
  }
  modelSel.value = MODELS[store.get("ui_model")] && !MODELS[store.get("ui_model")].hidden ? store.get("ui_model") : "z-image-turbo";
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

  const rm = $("refMode");
  for (const [id, r] of Object.entries(REF_MODES)) {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = r.label + (r.needsUpgrade ? " (after upgrade)" : "");
    rm.append(o);
  }
  rm.value = REF_MODES[store.get("ui_refmode")] ? store.get("ui_refmode") : "none";
  rm.addEventListener("change", () => { store.set("ui_refmode", rm.value, true); applyRefMode(true); });
  $("refStrength").addEventListener("input", () => {
    $("strengthVal").textContent = Number($("refStrength").value).toFixed(2);
  });
  applyRefMode(false);
}

function applyRefMode(changed) {
  const r = REF_MODES[refMode()];
  const on = refMode() !== "none";
  $("refWrap").hidden = !on;
  $("model").disabled = !!REF_MODES[panelMode()].model;
  if (on) {
    $("refNote").textContent = r.note;
    $("strengthWrap").hidden = r.strength == null;
    if (r.strength != null && (changed || !$("refStrength").dataset.set)) {
      $("refStrength").value = r.strength;
      $("refStrength").dataset.set = "1";
    }
    $("strengthVal").textContent = Number($("refStrength").value).toFixed(2);
  }
  applyModel(changed);
  renderRefs();
}

function setSize(k) {
  if (!SIZES[k]) k = "1:1";
  size = k;
  store.set("ui_size", k, true);
  for (const b of $("sizes").children) b.setAttribute("aria-checked", String(b.textContent === k));
}

function applyModel(resetAdvanced) {
  const forced = REF_MODES[panelMode()]?.model;
  const m = MODELS[effectiveModelId()];
  $("modelNote").textContent = forced ? `This mode uses ${m.label.split(" —")[0]}. ${m.needsUpgrade ? "Requires the Step 6 upgrade." : ""}` : m.note;
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
// Builds the job settings from the left panel plus a prompt and reference images.
// Throws an Error with a user-facing message if something is missing.
function prepareSettings(prompt, refList, mode = refMode(), strengthValue = $("refStrength").value) {
  const rmode = REF_MODES[mode];
  const modelId = rmode.model || $("model").value;
  const m = MODELS[modelId];
  // If this mode uses a different model than the one the panel shows, use that model's own steps/CFG.
  const own = modelId === effectiveModelId();
  if (!prompt) throw new Error("Write a prompt first.");
  const useRefs = mode === "none" ? [] : refList.slice(0, rmode.maxImages);
  if (mode !== "none" && !useRefs.length) throw new Error("Add a reference image, or set Reference image to “No reference image”.");
  const flagged = checkPrompt(prompt);
  if (flagged) throw new Error(`This studio only creates images of adults. Remove "${flagged}" from the prompt.`);

  const [width, height] = SIZES[size];
  const seedInput = $("seed").value.trim();
  const settings = {
    model: modelId,
    prompt,
    negative: m.supportsNegative ? $("negative").value.trim() : "",
    width, height,
    count: Number($("count").value),
    steps: own ? clampInt($("steps").value, 1, 80, m.defaults.steps) : m.defaults.steps,
    cfg: own ? clampNum($("cfg").value, 1, 15, m.defaults.cfg) : m.defaults.cfg,
    seed: seedInput ? Number(seedInput) : Math.floor(Math.random() * 2 ** 48),
    refMode: mode,
    refCount: useRefs.length,
    refStrength: rmode.strength == null ? null : clampNum(strengthValue, 0.05, 1, rmode.strength),
    refNames: useRefs.map((r) => `studio_ref_${r.id}.jpg`),
  };
  return { settings, useRefs };
}

// Runs a generation and saves the results to the gallery. Returns { items, summary }.
async function executeGeneration(settings, useRefs, onStatus) {
  const started = Date.now();
  onStatus(useRefs.length ? "Uploading reference images and sending job…" : "Sending job to RunPod…");
  const workflow = applyReference(MODELS[settings.model].build(settings), settings);
  const input = { workflow };
  if (useRefs.length) input.images = useRefs.map((r, i) => ({ name: settings.refNames[i], image: r.dataUrl }));
  const result = await runJob(input, (st, secs) => {
    if (st === "IN_QUEUE") {
      onStatus(`Waiting for a GPU worker… ${secs}s\n(The first job after a while idle can take 1–3 minutes while the worker boots and loads the model. Tip: press “Wake up GPU” when you sit down.)`);
    } else onStatus(`Generating… ${secs}s`);
  });
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
  const exec = result.executionTime ? ` (GPU time ${(result.executionTime / 1000).toFixed(1)}s)` : "";
  return { items, summary: `Done in ${secs}s${exec}. Seed ${settings.seed}.` };
}

async function generate() {
  if (currentJob || busy) return;
  let prep;
  try { prep = prepareSettings($("prompt").value.trim(), refs); }
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
async function runJob(input, onProgress, track = true) {
  const started = Date.now();
  const job = await rp("/run", { method: "POST", body: JSON.stringify({ input }) });
  if (track) currentJob = job.id;
  while (true) {
    await sleep(2000);
    if (track && currentJob !== job.id) throw new Error("Cancelled.");
    const result = await rp(`/status/${job.id}`);
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
    const r = await runJob({ workflow: warmupWorkflow() }, (st, secs) => {
      btn.textContent = st === "IN_QUEUE" ? `Starting GPU… ${secs}s` : "Loading model…";
    }, false);
    if (r.status !== "COMPLETED") throw new Error(describeFailure(r));
    btn.textContent = "GPU ready";
    btn.classList.add("ready");
    btn.title = "A worker is warm. It shuts down after your endpoint's idle timeout.";
    setTimeout(() => { btn.textContent = "Wake up GPU"; btn.classList.remove("ready"); }, 60000);
  } catch (e) {
    btn.textContent = "Wake up GPU";
    setStatus("Wake-up failed: " + (e.message || e), true);
  } finally {
    waking = false;
    btn.disabled = false;
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
  if (/not in list|value_not_in_list|unet_name|clip_name|lora_name|model_patch/i.test(msg)) {
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
    `${MODELS[s.model]?.label || s.model} · ${s.width}×${s.height} · seed ${s.seed}${s.index ? ` (+${s.index} in batch)` : ""} · ${s.steps} steps · CFG ${s.cfg}${s.refMode && s.refMode !== "none" ? ` · ${REF_MODES[s.refMode].label} (${s.refCount} image${s.refCount > 1 ? "s" : ""}${s.refStrength != null ? `, strength ${s.refStrength}` : ""})` : ""}\n${s.prompt}`;
  $("vDownload").href = urls.get(item.id);
  $("vDownload").download = `studio-${s.seed}-${item.id}.png`;
  $("viewer").showModal();
}

function reuse(item) {
  const s = item.settings;
  if (MODELS[s.model] && !MODELS[s.model].hidden) { $("model").value = s.model; store.set("ui_model", s.model, true); }
  $("refMode").value = s.refMode || "none"; store.set("ui_refmode", $("refMode").value, true);
  applyRefMode(false);
  if (s.refStrength != null) { $("refStrength").value = s.refStrength; $("strengthVal").textContent = Number(s.refStrength).toFixed(2); }
  $("prompt").value = s.prompt; store.set("ui_prompt", s.prompt, true);
  if (view === "chat") { $("chatInput").value = s.prompt; $("chatInput").dispatchEvent(new Event("input")); }
  if (s.negative) { $("negative").value = s.negative; store.set("ui_negative", s.negative, true); }
  const sizeKey = Object.keys(SIZES).find((k) => SIZES[k][0] === s.width && SIZES[k][1] === s.height);
  if (sizeKey) setSize(sizeKey);
  $("seed").value = s.seed;
  $("steps").value = s.steps;
  $("cfg").value = s.cfg;
  $("count").value = "1";
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
  const max = REF_MODES[refMode()]?.maxImages || 1;
  for (const f of files) {
    try {
      const item = { id: `${Date.now()}${Math.floor(Math.random() * 1000)}`, dataUrl: await prepareImage(f), added: Date.now() };
      if (max === 1) { for (const r of refs) await refDb.remove(r.id); refs = []; }
      refs.push(item);
      await refDb.add(item);
      while (refs.length > 3) { await refDb.remove(refs[0].id); refs.shift(); }
    } catch {
      setStatus("Couldn't read that image. Try a JPG or PNG.", true);
    }
  }
  renderRefs();
}

function renderRefs() {
  const list = $("refList");
  list.textContent = "";
  const max = REF_MODES[refMode()]?.maxImages || 1;
  refs.forEach((r, i) => {
    const d = document.createElement("div");
    d.className = "ref";
    d.style.opacity = i < max ? "1" : ".35";
    const img = document.createElement("img");
    img.src = r.dataUrl;
    img.alt = `Reference image ${i + 1}`;
    const x = document.createElement("button");
    x.type = "button";
    x.textContent = "×";
    x.title = "Remove";
    x.setAttribute("aria-label", `Remove reference image ${i + 1}`);
    x.addEventListener("click", async () => { await refDb.remove(r.id); refs = refs.filter((y) => y !== r); renderRefs(); });
    const cap = document.createElement("span");
    cap.textContent = i < max ? (max > 1 ? `image ${i + 1}` : "reference") : "not used";
    d.append(img, x, cap);
    list.append(d);
  });
  $("refAdd").firstChild.textContent = refs.length >= max && max === 1 ? "Replace image " : "Add image ";
}

function initRefs() {
  $("refFile").addEventListener("change", (e) => { addRefs(e.target.files); e.target.value = ""; });
  const wrap = $("refWrap");
  wrap.addEventListener("dragover", (e) => { e.preventDefault(); wrap.classList.add("drag"); });
  wrap.addEventListener("dragleave", () => wrap.classList.remove("drag"));
  wrap.addEventListener("drop", (e) => { e.preventDefault(); wrap.classList.remove("drag"); addRefs(e.dataTransfer.files); });
  document.addEventListener("paste", (e) => {
    if (view === "chat") {
      const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
      if (files.length) { e.preventDefault(); addChatAttachments(files); }
      return;
    }
    if (refMode() === "none") return;
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addRefs(files); }
  });
  refDb.all().then((all) => { refs = all.sort((a, b) => a.added - b.added); renderRefs(); }).catch(() => {});
}

async function useAsReference(item) {
  if (view === "chat") return editInChat(item);
  if (refMode() === "none") {
    $("refMode").value = "pose";
    store.set("ui_refmode", "pose", true);
    applyRefMode(true);
  }
  if (!(await askConsent())) return;
  await addRefs([new File([item.blob], "gallery.png", { type: "image/png" })]);
  setStatus("Added to reference images. Pick the reference mode you want above.");
}

// ---------- Chat ----------
// Messages: { id, created, role: "user" | "assistant", text, attachments: [dataUrl], mode, imageIds: [], error, summary }
let messages = [];
let chatAttach = []; // [{ id, dataUrl }]
let pending = null; // { status } while a chat job runs

function setView(v) {
  view = v === "studio" ? "studio" : "chat";
  store.set("ui_view", view, true);
  document.body.dataset.view = view;
  $("tabChat").setAttribute("aria-selected", String(view === "chat"));
  $("tabGallery").setAttribute("aria-selected", String(view === "studio"));
  $("chatView").hidden = view !== "chat";
  $("galleryView").hidden = view !== "studio";
  applyRefMode(false);
  if (view === "chat") scrollThread();
}

function initChat() {
  const cm = $("chatRefMode");
  for (const [id, r] of Object.entries(REF_MODES)) {
    if (id === "none") continue;
    const o = document.createElement("option");
    o.value = id;
    o.textContent = r.label + (r.needsUpgrade ? " (after upgrade)" : "");
    cm.append(o);
  }
  cm.value = REF_MODES[store.get("ui_chatmode")] && store.get("ui_chatmode") !== "none" ? store.get("ui_chatmode") : "pose";
  cm.addEventListener("change", () => { store.set("ui_chatmode", cm.value, true); renderAttachments(); });

  const cs = $("chatStrength");
  cs.value = store.get("ui_chatstrength") || "0.7";
  const showStrength = () => { $("chatStrengthVal").textContent = Number(cs.value).toFixed(2); };
  cs.addEventListener("input", () => { store.set("ui_chatstrength", cs.value, true); showStrength(); });
  showStrength();

  $("tabChat").addEventListener("click", () => setView("chat"));
  $("tabGallery").addEventListener("click", () => setView("studio"));
  $("newChat").addEventListener("click", async () => {
    if (pending) return;
    if (messages.length && !confirm("Start a new chat? Your images stay in the Gallery.")) return;
    await chatDb.clear();
    messages = [];
    renderThread();
  });

  const input = $("chatInput");
  const grow = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 200) + "px"; };
  input.addEventListener("input", grow);
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
    try { chatAttach.push({ id: `${Date.now()}${Math.floor(Math.random() * 1000)}`, dataUrl: await prepareImage(f) }); }
    catch { setStatus("Couldn't read that image. Try a JPG or PNG.", true); }
  }
  chatAttach = chatAttach.slice(-3);
  renderAttachments();
  $("chatInput").focus();
}

function renderAttachments() {
  const list = $("attachList");
  list.textContent = "";
  $("attachRow").hidden = !chatAttach.length;
  const max = REF_MODES[$("chatRefMode").value].maxImages;
  chatAttach.forEach((a, i) => {
    const d = document.createElement("div");
    d.className = "ref";
    d.style.opacity = i < max ? "1" : ".35";
    d.title = i < max ? (max > 1 ? `image ${i + 1}` : "reference") : "Not used in this mode (it takes 1 image)";
    const img = document.createElement("img");
    img.src = a.dataUrl;
    img.alt = `Attached image ${i + 1}`;
    const x = document.createElement("button");
    x.type = "button";
    x.textContent = "×";
    x.setAttribute("aria-label", `Remove attached image ${i + 1}`);
    x.addEventListener("click", () => { chatAttach = chatAttach.filter((y) => y !== a); renderAttachments(); });
    d.append(img, x);
    list.append(d);
  });
}

async function sendChat(retryOf) {
  if (pending || busy) return;
  const text = retryOf ? retryOf.text : $("chatInput").value.trim();
  const atts = retryOf ? retryOf.attachments.map((dataUrl, i) => ({ id: `${retryOf.id}${i}`, dataUrl })) : chatAttach.slice();
  const mode = retryOf ? retryOf.mode : (atts.length ? $("chatRefMode").value : "none");
  if (!text) { $("chatInput").focus(); return; }

  let prep;
  try { prep = prepareSettings(text, atts, mode, $("chatStrength").value); }
  catch (e) {
    messages.push({ id: `e${Date.now()}`, created: Date.now(), role: "assistant", error: e.message, local: true });
    return renderThread();
  }

  let userMsg = retryOf;
  if (!retryOf) {
    userMsg = { id: `u${Date.now()}`, created: Date.now(), role: "user", text, mode,
      attachments: prep.useRefs.map((r) => r.dataUrl) };
    messages.push(userMsg);
    await chatDb.add(userMsg);
    $("chatInput").value = "";
    $("chatInput").style.height = "";
    chatAttach = [];
    renderAttachments();
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
    reply.summary = `${MODELS[prep.settings.model].label.split(" —")[0]}${mode !== "none" ? ` · ${REF_MODES[mode].label}` : ""} · ${summary}`;
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
      if (msg.mode && msg.mode !== "none") el.append(meta(REF_MODES[msg.mode].label));
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
  chatAttach = [{ id: `${Date.now()}`, dataUrl: await prepareImage(item.blob) }];
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
let busy = false;
function setBusy(b) {
  busy = b;
  $("generate").disabled = b;
  $("cancel").hidden = !b;
  if (typeof updateChatBusy === "function") updateChatBusy();
}

// ---------- wire up ----------
initControls();
initRefs();
initChat();
setView(store.get("ui_view") || "chat");
initSettings();
updateConn();
renderGallery();
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
if (!creds().key) setStatus("Start by opening Settings to connect your RunPod endpoint.");
