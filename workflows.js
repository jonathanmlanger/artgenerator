// ComfyUI workflows (API format) for each model.
// Node settings come from the official ComfyUI workflow templates for these models.
// Each builder receives the user's settings and returns a workflow object for worker-comfyui.

// Qwen-Image 2.1 graph, from the official ComfyUI templates. full = the non-Turbo model with a plain
// 30-step KSampler (cfg 1, as in the template); otherwise the Turbo model with its 8-step schedule.
function buildQwen21(s, full) {
  const g = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: full ? "qwen_image_2.1_int8_convrot.safetensors" : "qwen_image_2.1_turbo_int8_convrot.safetensors", weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl_8b_int8_convrot.safetensors", type: "qwen_image", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: "qwen_image_2.1_vae_bf16.safetensors" } },
    "4": { class_type: "QwenImage21Cache", inputs: { model: ["1", 0], device: "auto", dtype: "default" } },
    "5": { class_type: "TextEncodeQwenImage21", inputs: { clip: ["2", 0], vae: ["3", 0], prompt: s.prompt, negative_prompt: "", resolution: 1024 } },
    "6": { class_type: "EmptyLatentImage", inputs: { width: s.width, height: s.height, batch_size: s.count } },
    // The Turbo model's own 8-step schedule from the template.
    "7": { class_type: "ManualSigmas", inputs: { sigmas: "1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0" } },
    "8": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
    "9": { class_type: "RandomNoise", inputs: { noise_seed: s.seed } },
    "11": { class_type: "CFGGuider", inputs: { model: ["4", 0], positive: ["5", 0], negative: ["5", 1], cfg: 1 } },
    "12": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["9", 0], guider: ["11", 0], sampler: ["8", 0], sigmas: ["7", 0], latent_image: ["6", 0] } },
    "13": { class_type: "VAEDecode", inputs: { samples: ["12", 0], vae: ["3", 0] } },
    "10": { class_type: "SaveImage", inputs: { images: ["13", 0], filename_prefix: "studio" } },
  };
  (s.refNames || []).slice(0, 3).forEach((name, i) => {
    const id = String(30 + i);
    g[id] = { class_type: "LoadImage", inputs: { image: name } };
    g["5"].inputs[`images.image_${i + 1}`] = [id, 0];
  });
  // followImage1: the canvas takes image 1's size and shape (the encoder's latent, as in the official
  // edit template), for edits of an existing picture; otherwise width/height.
  if (s.followImage1 && s.refNames?.length) {
    g["6"] = { class_type: "RepeatLatentBatch", inputs: { samples: ["5", 2], amount: s.count } };
  }
  if (full) {
    // The full model's template: a plain KSampler, euler / simple, cfg 1.
    for (const id of ["7", "8", "9", "11"]) delete g[id];
    g["12"] = { class_type: "KSampler", inputs: {
      model: ["4", 0], positive: ["5", 0], negative: ["5", 1], latent_image: ["6", 0],
      seed: s.seed, steps: s.steps || 30, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 } };
  }
  return g;
}

const MODELS = {
  // Text-to-image and reference images in one model (Comfy-Org repackage, Turbo int8; ComfyUI 0.37+,
  // see worker/start-qwen21.sh, which puts the files in the volume's unet/ and clip/ folders). Node layout follows the official "Qwen Image 2.1 Turbo" templates.
  // Reference images (refNames) are optional; the canvas size always comes from width/height.
  "qwen-image-21": {
    label: "Qwen-Image 2.1 — best quality (recommended)",
    note: "8 steps, coherent bodies and faces. Uses attached pictures as image 1–3.",
    needsUpgrade: false, // set up by worker/start-qwen21.sh, not the README's Step 6
    endpoint: "edit", // its files and the newer ComfyUI are set up on the edit endpoint (worker/start-qwen21.sh)
    supportsNegative: false,
    defaults: { steps: 8, cfg: 1 },
    build: (s) => buildQwen21(s, false),
  },

  // The full (non-Turbo) model: slower (30 steps) but more varied and natural. "More variety" in the menu.
  "qwen-image-21-full": {
    label: "Qwen-Image 2.1 (full model) — more variety, slower",
    note: "30 steps instead of 8: about three to four times slower, with more varied poses and compositions.",
    needsUpgrade: false,
    endpoint: "edit",
    hidden: true, // chosen with the "More variety" switch, not from a menu
    supportsNegative: false,
    defaults: { steps: 30, cfg: 1 },
    build: (s) => buildQwen21(s, true),
  },

  "z-image-turbo": {
    label: "Z-Image Turbo — fast photoreal",
    hidden: true, // older model, kept as a fallback; the app uses Qwen-Image 2.1
    note: "8 steps, ~5–10 s per image when warm. No negative prompt (turbo models ignore it).",
    needsUpgrade: false,
    supportsNegative: false,
    defaults: { steps: 8, cfg: 1 },
    build: (s) => ({
      "1": { class_type: "UNETLoader", inputs: { unet_name: "z_image_turbo_bf16.safetensors", weight_dtype: "default" } },
      "2": { class_type: "CLIPLoader", inputs: { clip_name: "qwen_3_4b.safetensors", type: "lumina2", device: "default" } },
      "3": { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } },
      "4": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 3 } },
      "5": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: s.prompt } },
      "6": { class_type: "ConditioningZeroOut", inputs: { conditioning: ["5", 0] } },
      "7": { class_type: "EmptySD3LatentImage", inputs: { width: s.width, height: s.height, batch_size: s.count } },
      "8": { class_type: "KSampler", inputs: {
        model: ["4", 0], positive: ["5", 0], negative: ["6", 0], latent_image: ["7", 0],
        seed: s.seed, steps: s.steps, cfg: s.cfg, sampler_name: "res_multistep", scheduler: "simple", denoise: 1 } },
      "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
      "10": { class_type: "SaveImage", inputs: { images: ["9", 0], filename_prefix: "studio" } },
    }),
  },

  "z-image-base": {
    label: "Z-Image Base — highest detail, negative prompts",
    hidden: true, // older model, kept as a fallback; the app uses Qwen-Image 2.1
    note: "25 steps, slower but more varied and controllable. Requires the Step 6 upgrade.",
    needsUpgrade: true,
    supportsNegative: true,
    defaults: { steps: 25, cfg: 4 },
    build: (s) => ({
      "1": { class_type: "UNETLoader", inputs: { unet_name: "z_image_bf16.safetensors", weight_dtype: "default" } },
      "2": { class_type: "CLIPLoader", inputs: { clip_name: "qwen_3_4b.safetensors", type: "lumina2", device: "default" } },
      "3": { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } },
      "4": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 3 } },
      "5": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: s.prompt } },
      "6": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: s.negative } },
      "7": { class_type: "EmptySD3LatentImage", inputs: { width: s.width, height: s.height, batch_size: s.count } },
      "8": { class_type: "KSampler", inputs: {
        model: ["4", 0], positive: ["5", 0], negative: ["6", 0], latent_image: ["7", 0],
        seed: s.seed, steps: s.steps, cfg: s.cfg, sampler_name: "res_multistep", scheduler: "simple", denoise: 1 } },
      "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
      "10": { class_type: "SaveImage", inputs: { images: ["9", 0], filename_prefix: "studio" } },
    }),
  },

  "chroma1-hd": {
    label: "Chroma1-HD — unfiltered training, any style",
    hidden: true, // older model, kept as a fallback; the app uses Qwen-Image 2.1
    note: "26 steps. Strong at illustration, painting and photo styles. Requires the Step 6 upgrade.",
    needsUpgrade: true,
    supportsNegative: true,
    defaults: { steps: 26, cfg: 3.5 },
    build: (s) => ({
      "1": { class_type: "UNETLoader", inputs: { unet_name: "Chroma1-HD-fp8mixed.safetensors", weight_dtype: "default" } },
      "2": { class_type: "CLIPLoader", inputs: { clip_name: "t5xxl_fp8_e4m3fn_scaled.safetensors", type: "chroma", device: "default" } },
      "3": { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } },
      "4": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 1 } },
      "11": { class_type: "T5TokenizerOptions", inputs: { clip: ["2", 0], min_padding: 0, min_length: 0 } },
      "5": { class_type: "CLIPTextEncode", inputs: { clip: ["11", 0], text: s.prompt } },
      "6": { class_type: "CLIPTextEncode", inputs: { clip: ["11", 0], text: s.negative } },
      "7": { class_type: "EmptySD3LatentImage", inputs: { width: s.width, height: s.height, batch_size: s.count } },
      "8": { class_type: "KSampler", inputs: {
        model: ["4", 0], positive: ["5", 0], negative: ["6", 0], latent_image: ["7", 0],
        seed: s.seed, steps: s.steps, cfg: s.cfg, sampler_name: "euler", scheduler: "beta", denoise: 1 } },
      "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
      "10": { class_type: "SaveImage", inputs: { images: ["9", 0], filename_prefix: "studio" } },
    }),
  },

  // Used only by the "Character / scene reference" mode.
  "qwen-edit": {
    label: "Qwen Image Edit 2511 — reference images",
    endpoint: "edit",
    note: "Uses your reference images directly. Refer to them in the prompt as “image 1”, “image 2”, “image 3”. Requires the Step 6 upgrade; a 48 GB GPU is recommended.",
    needsUpgrade: true,
    supportsNegative: false,
    hidden: true,
    defaults: { steps: 4, cfg: 1 },
    build: (s) => {
      const g = {
        "1": { class_type: "UNETLoader", inputs: { unet_name: "qwen_image_edit_2511_fp8mixed.safetensors", weight_dtype: "default" } },
        "2": { class_type: "CLIPLoader", inputs: { clip_name: "qwen_2.5_vl_7b_fp8_scaled.safetensors", type: "qwen_image", device: "default" } },
        "3": { class_type: "VAELoader", inputs: { vae_name: "qwen_image_vae.safetensors" } },
        "4": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 3.1 } },
        "12": { class_type: "CFGNorm", inputs: { model: ["4", 0], strength: 1 } },
        // Lightning LoRA: 4 steps at CFG 1 instead of 40 steps at CFG 4.
        "13": { class_type: "LoraLoaderModelOnly", inputs: { model: ["12", 0], lora_name: "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors", strength_model: 1 } },
        "5": { class_type: "TextEncodeQwenImageEditPlus", inputs: { clip: ["2", 0], vae: ["3", 0], prompt: s.prompt } },
        "6": { class_type: "TextEncodeQwenImageEditPlus", inputs: { clip: ["2", 0], vae: ["3", 0], prompt: "" } },
        "14": { class_type: "FluxKontextMultiReferenceLatentMethod", inputs: { conditioning: ["5", 0], reference_latents_method: "index_timestep_zero" } },
        "15": { class_type: "FluxKontextMultiReferenceLatentMethod", inputs: { conditioning: ["6", 0], reference_latents_method: "index_timestep_zero" } },
        "7": { class_type: "EmptySD3LatentImage", inputs: { width: s.width, height: s.height, batch_size: s.count } },
        "8": { class_type: "KSampler", inputs: {
          model: ["13", 0], positive: ["14", 0], negative: ["15", 0], latent_image: ["7", 0],
          seed: s.seed, steps: s.steps, cfg: s.cfg, sampler_name: "euler", scheduler: "simple", denoise: 1 } },
        "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
        "10": { class_type: "SaveImage", inputs: { images: ["9", 0], filename_prefix: "studio" } },
      };
      s.refNames.slice(0, 3).forEach((name, i) => {
        const id = String(30 + i);
        g[id] = { class_type: "LoadImage", inputs: { image: name } };
        g["5"].inputs[`image${i + 1}`] = [id, 0];
        g["6"].inputs[`image${i + 1}`] = [id, 0];
      });
      return g;
    },
  },
};

// Reference-image modes.
const REF_MODES = {
  none: { label: "No reference image" },
  // Attached images go to Qwen-Image 2.1 as image 1–3; the prompt says how to use them.
  refs: { label: "Reference images", maxImages: 3, model: "qwen-image-21", strength: null },
};

// Reference images are wired in by the Qwen-Image 2.1 builder itself (refNames); nothing else to add.
function applyReference(g) {
  return g;
}

// LoRA add-ons: small files that teach a model a concept (a pose, prop or style).
// Files live in models/loras on the network volume; worker/download-loras.sh downloads them.
// models: the MODELS ids each LoRA works with. file: one file for all of them, or files: { modelId: file }.
const LORAS = {
  "rope-bound": {
    label: "Rope bound",
    files: { "z-image-turbo": "rope_bound_zit.safetensors", "z-image-base": "rope_bound_zib.safetensors" },
    models: ["z-image-turbo", "z-image-base"],
    strength: 0.8,
    note: "General rope bondage: ropes around the torso, wrists, ankles and legs, sitting, standing, lying or tied to a chair. Describe the rope colour and where it goes. Works best on Z-Image Base.",
    source: "https://civitai.com/models/2203450",
    // General words only count when no pose LoRA (like hogtie) was picked, which draws its own ropes.
    generalKeywords: /\b(rope[sd]?|roped|tied|bound|bondage|restrained|tied up)\b/i,
  },
  "rope-cleave": {
    label: "Rope bondage + cleave gag",
    file: "rope_cleave_gag_zib.safetensors",
    models: ["z-image-base", "z-image-turbo"],
    strength: 0.8,
    note: "Ropework (chest harness, wrists, ankles, arms behind the back) and cloth cleave gags. Describe the ropes, colours and position in plain sentences. Made for Z-Image Base; also works on Turbo.",
    source: "https://civitai.com/models/2532774",
    keywords: /\b(shibari|cleave[- ]?gag(ged)?|chest harness)\b/i,
  },
  "ball-gags": {
    label: "Ball gag",
    file: "ball_gags_joschek_zit.safetensors",
    models: ["z-image-turbo"], // breaks Z-Image Base images (tested 2026-11-18)
    strength: 0.8,
    note: "A normal-sized ball gag. Write “ballgag” (or “ball gag”) in the prompt; you can name a colour. Turbo only.",
    source: "https://civitai.com/models/2246853",
    keywords: /\bball[- ]?gag(s|ged)?\b/i, // "ballgag", "ball gag", "ball-gagged"
  },
  "ball-gag": {
    label: "Large ball gag",
    file: "ball_gag_zit.safetensors",
    models: ["z-image-turbo", "z-image-base"],
    strength: 0.8,
    note: "An oversized ball gag. On Turbo, automatic mode uses it only when the prompt says “large”, “big” or “huge” ballgag; on Base it is the only ball gag. Made for Z-Image Turbo.",
    source: "https://civitai.com/models/999177",
    keywords: /\bball[- ]?gag(s|ged)?\b/i,
    // Steps aside for the normal-sized one when both are usable, unless the prompt asks for a big one.
    yieldsTo: "ball-gags",
    forceKeywords: /\b(large|big|huge|giant|oversized)\b[\w ,-]{0,20}?\bball[- ]?gag/i,
  },
  "bondage-megapack": {
    label: "Pose & detail pack",
    file: "bondage_megapack_qwen21.safetensors",
    models: ["qwen-image-21", "qwen-image-21-full"],
    strength: 1.0,
    fullStrength: true, // its author recommends 1.0 (1.2 if bodies warp); automatic mode doesn't lower it
    note: "Recommended for this model. Describe the pose and props in plain sentences.",
    source: "https://civitai.com/models/2994404",
    keywords: /\b(hog[- ]?tie[ds]?|ball[- ]?gag(s|ged)?|gag(s|ged)?|rope[sd]?|tied|bound|bondage|restrained|tape[d]?|cuff(s|ed)?|shibari)\b/i,
    // Short prompts ("hogtied with a ballgag") often miss the pose; the LoRA was trained on these
    // descriptions (from its Civitai page), so automatic mode adds the matching ones behind the scenes.
    // Each entry: [keyword, wordings]. One wording is picked per picture (see pickFor), so poses vary
    // while the key part (e.g. ankles tied to wrists) stays.
    promptHints: [
      [/\bhog[- ]?(tie[ds]?|tying)\b/i, [
        "She is lying on her stomach in a tight hogtie: her wrists are tied behind her back and pulled to her ankles, her knees bent and her feet raised behind her.",
        "She is hogtied face down: her arms are bound behind her back at the wrists and elbows, her ankles are crossed and tied, and a short rope joins her ankles to her wrists, pulling her feet up.",
        "She is lying on her side in a tight hogtie: her wrists are tied behind her back, her ankles are tied together, and her knees are bent sharply so her bound ankles are pulled up behind her and tied to her bound wrists with a short rope.",
        "She is lying on her stomach, hogtied with extra rope around her thighs and knees; her bound wrists are tied to her bound ankles behind her and her feet point upward.",
        "She is hogtied on her stomach with rope wrapped around her chest and upper arms, her wrists tied behind her back and joined to her ankles, her head raised.",
      ]],
      [/\b(tied to a chair|chair[- ]?tie[ds]?|bound to a chair)\b/i, [
        "She is sitting on a chair, bound to it with rope wrapped around her chest and the chair back, her wrists tied behind the chair and her ankles tied to the chair legs.",
        "She is tied to a chair: rope crosses her chest and waist and holds her to the backrest, her arms are tied behind the chair, and her knees and ankles are bound together.",
        "She sits on a chair with her wrists tied to the armrests and her ankles tied to the front legs, a rope around her waist holding her against the backrest.",
      ]],
      [/\bball[- ]?gag(s|ged)?\b/i, [
        "She has a ball gag in her mouth fastened with leather straps behind her head.",
        "A ball gag is strapped firmly between her lips, its strap buckled behind her head under her hair.",
      ]],
      [/\bcleave[- ]?gag(s|ged)?\b/i, [
        "She has a strip of cloth cleave gag between her lips fastened behind her head.",
        "A knotted cloth is pulled between her teeth as a cleave gag and tied tightly behind her head.",
      ]],
      [/\btape[- ]?gag(s|ged)?\b/i, ["She has a tape gag wrapped tightly around her mouth, looping behind her head."]],
      [/\b(otm|over[- ]the[- ]mouth)\b/i, ["She has a wide strip of cloth covering her mouth as a gag, fastened behind her head."]],
    ],
    // Without clothes in the prompt, this LoRA drifts towards underwear or nudity (tested), so automatic
    // mode names an outfit (picked per picture) when the prompt names no clothing.
    clothingHints: [
      "She is fully clothed, wearing a long-sleeved sweater and full-length jeans.",
      "She is fully clothed, wearing a white blouse and a black pencil skirt.",
      "She is fully clothed, wearing a fitted long-sleeved t-shirt and leggings.",
      "She is fully clothed, wearing a flannel shirt and jeans.",
      "She is fully clothed, wearing a knee-length summer dress.",
      "She is fully clothed, wearing a blazer, a silk blouse and trousers.",
      "She is fully clothed, wearing a turtleneck and a plaid skirt with tights.",
    ],
    // A lying-down pose comes out sitting or kneeling in a tall frame (tested), so hogties use landscape.
    widePrompt: /\bhog[- ]?(tie[ds]?|tying)\b/i,
  },
  "hogtie": {
    label: "Hogtie",
    // Separate Turbo and Base versions of the same LoRA.
    files: { "z-image-turbo": "hogtie_zit.safetensors", "z-image-base": "hogtie_zib.safetensors" },
    models: ["z-image-turbo", "z-image-base"],
    strength: 0.8,
    note: "Lying on the stomach, wrists and ankles tied together behind the back. Describe the rope colour, clothes, shoes or bare feet and the gag (ball or cloth) in plain sentences.",
    source: "https://civitai.com/models/2267371",
    keywords: /\bhog[- ]?(tie[ds]?|tying)\b/i, // "hogtie", "hogtied", "hog-tied", "hog tied"
    pose: true,
    // A lying-down pose: in a tall frame the body ends up head-down towards the camera (tested), so
    // portrait sizes are turned to landscape when this LoRA is used.
    wide: true,
  },
};

// Automatic mode (the default): picks add-ons from the prompt using each LoRA's keywords.
// General rope words add "Rope bound" unless a pose LoRA (hogtie) was picked. A LoRA with yieldsTo
// steps aside for that one unless its forceKeywords match, then that one steps aside instead
// (the large ball gag vs the normal one). If nothing matches, "Rope bound" is used,
// so every image leans towards bondage. Several LoRAs at full strength fight each other, so
// strengths drop as more are picked; a pose LoRA keeps full strength and the others drop further,
// because the pose is what goes missing first (tested).
const AUTO_DEFAULT_LORAS = ["rope-bound", "bondage-megapack"]; // first one the model can use
const AUTO_STRENGTHS = [0.8, 0.65, 0.55]; // for 1, 2, 3+ LoRAs
function autoLoras(prompt, modelId) {
  const usable = Object.entries(LORAS).filter(([, l]) => l.models.includes(modelId));
  const text = prompt || "";
  let picked = usable.filter(([, l]) => l.keywords?.test(text));
  if (!picked.some(([, l]) => l.pose)) {
    picked = usable.filter(([id, l]) => picked.some(([p]) => p === id) || l.generalKeywords?.test(text));
  }
  const drop = new Set();
  for (const [id, l] of picked) {
    if (!l.yieldsTo || !picked.some(([p]) => p === l.yieldsTo)) continue;
    drop.add(l.forceKeywords?.test(text) ? l.yieldsTo : id);
  }
  picked = picked.filter(([id]) => !drop.has(id));
  if (!picked.length) {
    const id = AUTO_DEFAULT_LORAS.find((d) => usable.some(([u]) => u === d));
    picked = usable.filter(([u]) => u === id);
  }
  const cap = AUTO_STRENGTHS[Math.min(picked.length, AUTO_STRENGTHS.length) - 1];
  const hasPose = picked.length > 1 && picked.some(([, l]) => l.pose);
  const strengthOf = (l) => l.fullStrength ? l.strength : !hasPose ? Math.min(l.strength, cap)
    : l.pose ? l.strength : Math.max(0.4, Math.round((cap - 0.15) * 100) / 100);
  return picked.map(([id, l]) => ({ id, label: l.label, file: loraFile(l, modelId), strength: strengthOf(l) }));
}

// [width, height] to use: portrait sizes turn to landscape for a lying-down pose: a "wide" LoRA, or a
// LoRA whose widePrompt matches the prompt.
function sizeForLoras(width, height, loras, prompt = "") {
  const wide = (loras || []).some((l) => LORAS[l.id]?.wide || LORAS[l.id]?.widePrompt?.test(prompt));
  return wide && height > width ? [height, width] : [width, height];
}

const CLOTHING_WORDS = /\b(wear(s|ing)?|dressed|clothes|clothed|clothing|outfit|shirt|t-shirt|blouse|top|sweater|jumper|hoodie|cardigan|jacket|coat|dress|skirt|jeans|pants|trousers|leggings|shorts|uniform|suit|pyjamas|pajamas|lingerie|bra|panties|underwear|bikini|swimsuit|nude|naked|topless)\b/i;

// An edit of an attached picture ("In image 1, change her shirt to red", "Make the ropes blue") rather than
// a new picture. Edits keep image 1's shape and get no clothing sentence (it would change the outfit).
function isEditPrompt(prompt) {
  return /^\s*(in|on|for) (image|picture|photo) ?\d\b|^\s*(please\s+)?(change|make|replace|remove|add|turn|swap|give|recolou?r|edit|put|take|tighten|loosen|move|fix)\b/i.test(prompt || "");
}

// Camera angle and place, picked per picture when the prompt names neither, so pictures don't all share
// the model's favourite framing.
const CAMERA_HINTS = [
  "Photographed from the side at floor level.",
  "Three-quarter view from slightly above.",
  "Seen from above, looking down at her.",
  "Full-body shot from a low angle close to the floor.",
  "Medium shot from the front at eye level.",
  "Wide shot that shows the whole room around her.",
];
const CAMERA_WORDS = /\b(from (above|below|behind|the side|the front|the back)|side view|close-?up|wide shot|medium shot|low angle|high angle|overhead|top-down|three-quarter|profile|full[- ]body|camera|angle|view|portrait|framing)\b/i;
const SETTING_HINTS = [
  "The scene is a sunlit living room with a wooden floor.",
  "The scene is a dim bedroom with an unmade bed.",
  "The scene is a cosy room with a rug in front of a fireplace.",
  "The scene is an empty warehouse with a concrete floor and soft window light.",
  "The scene is a modern apartment with a leather couch.",
  "The scene is a photo studio with a plain grey backdrop.",
  "The scene is a hotel room with white sheets.",
  "The scene is a rustic cabin with wooden walls.",
];
const SETTING_WORDS = /\b(bed|bedroom|floor|room|couch|sofa|rug|carpet|studio|warehouse|basement|cabin|hotel|kitchen|office|barn|forest|woods|outdoors|outside|garage|attic|dungeon|backdrop|apartment|house|car|beach|garden|field|stage)\b/i;

// A stable choice from a list for this picture: the same picture number (seed) gives the same choice, so
// "Repeat a picture" repeats it; salt keeps different lists from moving in step.
function pickFor(list, seed, salt) {
  if (!list?.length) return undefined;
  let x = (Math.floor(Number(seed) || 0) % 2147483647 + salt * 7919) | 0;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  return list[(x >>> 0) % list.length];
}

// Sentences the picked LoRAs add to the prompt (see promptHints and clothingHints), as one string
// starting with a space. Edits (isEdit) get only the pose/gag wording: no outfit, angle or place, which
// would change the picture being edited. Without a seed the first wording of each list is used.
function loraPromptHints(prompt, loras, isEdit = false, seed = null) {
  const ls = (loras || []).map((l) => LORAS[l.id]).filter(Boolean);
  if (!ls.length) return "";
  const choose = (list, salt) => (seed == null ? list[0] : pickFor(list, seed, salt));
  const hints = ls.flatMap((l) => (l.promptHints || []).filter(([re]) => re.test(prompt))
    .map(([, wordings], k) => choose([].concat(wordings), 11 + k)));
  const clothing = ls.find((l) => l.clothingHints)?.clothingHints;
  if (!isEdit) {
    if (clothing && !CLOTHING_WORDS.test(prompt)) hints.push(choose(clothing, 3));
    if (seed != null && !CAMERA_WORDS.test(prompt)) hints.push(pickFor(CAMERA_HINTS, seed, 5));
    if (seed != null && !SETTING_WORDS.test(prompt)) hints.push(pickFor(SETTING_HINTS, seed, 7));
  }
  return hints.length ? " " + hints.join(" ") : "";
}

// The LoRA file to load for a model: per-model files win over the shared one.
function loraFile(l, modelId) {
  return l.files?.[modelId] || l.file;
}

// Chains LoRA loaders onto the diffusion model (node "1") and points everything that used it at the last one.
// loras: [{ file, strength }]
function applyLoras(g, loras) {
  if (!loras?.length) return g;
  const ids = new Set();
  let prev = ["1", 0];
  loras.forEach((l, i) => {
    const id = String(40 + i);
    ids.add(id);
    g[id] = { class_type: "LoraLoaderModelOnly", inputs: { model: prev, lora_name: l.file, strength_model: l.strength } };
    prev = [id, 0];
  });
  for (const [id, node] of Object.entries(g)) {
    if (ids.has(id)) continue;
    const m = node.inputs.model;
    if (Array.isArray(m) && m[0] === "1" && m[1] === 0) node.inputs.model = prev;
  }
  return g;
}

// A tiny job that only exists to start a GPU worker and load the model.
// modelId: the model to load, so the next real job with it starts straight away.
function warmupWorkflow(modelId = "z-image-turbo") {
  // The small 256px result is returned but the app discards it.
  const m = MODELS[modelId] || MODELS["z-image-turbo"];
  return m.build({ prompt: "warm up", negative: "", width: 256, height: 256, count: 1, seed: 1, steps: 1, cfg: 1, refNames: [] });
}

const DEFAULT_NEGATIVE =
  "low quality, blurry, jpeg artifacts, deformed, bad anatomy, extra fingers, extra limbs, watermark, text, signature";

// Sizes are multiples of 64, around one megapixel, which these models are trained for.
const SIZES = {
  "1:1": [1024, 1024],
  "4:5": [896, 1120],
  "2:3": [832, 1248],
  "3:4": [896, 1184],
  "9:16": [768, 1344],
  "5:4": [1120, 896],
  "3:2": [1248, 832],
  "4:3": [1184, 896],
  "16:9": [1344, 768],
};
