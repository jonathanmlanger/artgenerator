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
        // Kept neutral about tightness: TIE_STYLES adds strict or loose. ("On her side" was dropped: the
        // add-on always draws her on her stomach.)
        "She is lying on her stomach, hogtied: her wrists are tied behind her back and joined to her ankles, her knees bent and her feet raised behind her.",
        "She is hogtied face down: her arms are bound behind her back at the wrists and elbows, her ankles are crossed and tied, and a rope joins her ankles to her wrists, pulling her feet up.",
        "She is lying on her stomach, hogtied with extra rope around her thighs and knees; her bound wrists are tied to her bound ankles behind her and her feet point upward.",
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
    // A short reminder added at the very end of the prompt, after outfit/place/light, so a long prompt
    // doesn't lose the key part of the pose (tested: with many added details the ankles came loose from the wrists).
    poseAnchors: [
      [/\bhog[- ]?(tie[ds]?|tying)\b/i, "Her bound ankles are pulled up and tied to her bound wrists behind her back."],
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

// How much the prompt already says, so the extra wording can match it:
//   "vague"    (short, says little: "hogtied and ballgagged") -> be creative: varied pose, outfit, angle and
//              place, plus rope colour, shoes, lighting and (without a reference picture) her look.
//   "some"     -> fill in only what's missing (outfit, angle, place).
//   "detailed" (long, or names three or more of the things below) -> the prompt leads: no angle, place or
//              style picks, and no pose wording if the prompt describes how she is tied. Only an outfit
//              is added when none is named (this LoRA drifts to nudity without one).
// Words about how she's tied (for promptDetail). "thigh-high" and "harness gag" are clothing/gag words, not pose.
const POSE_DETAIL_WORDS = /\b(wrists?|ankles?|elbows?|knees?|thighs?(?!-)|arms?|legs?|feet|toes?|on her (side|stomach|back|front|belly|knees)|face[- ]?down|chest|waist|frog[- ]?tie[ds]?|box[- ]?tie|kneeling|crossed)\b/i;
// The prompt itself says how wrists and ankles are joined: only then is the pose wording left out (tested:
// "hogtied" alone, without that wording, gave standing women).
const TIE_DESCRIBED = /\b(wrists?|hands?)\b[^.]*\b(ankles?|feet)\b|\b(ankles?|feet)\b[^.]*\b(wrists?|hands?)\b/i;
const GAG_DETAIL_WORDS = /\b(strap(s|ped)?|buckle[ds]?|between her (lips|teeth)|behind her head|harness)\b/i;
const LIGHT_WORDS = /\b(light(ing|s)?|lit|sun(light|lit|set)?|dark|dim|shadows?|candle(s|light)?|lamp|night|morning|evening|golden hour|moody|bright)\b/i;
const LOOK_WORDS = /\b(hair|blonde?|brunette|redhead|ginger|curly|ponytail|braids?|bun|freckles?|her (twenties|thirties|forties|fifties)|\d\d[- ]year[- ]old|image \d|picture \d|photo \d)\b/i;
const FOOT_WORDS = /\b(barefoot|bare feet|shoes?|heels?|boots?|sneakers?|trainers?|socks?|stockings?|tights|feet)\b/i;
const ROPE_COLOUR_WORDS = /\b(red|black|white|blue|pink|green|purple|yellow|jute|hemp|cotton|nylon|silk|tape|cuffs?|chains?)\b[^.]*\b(rope|ropes|cord|tied|bound)|\b(rope|ropes|cord)\b[^.]*\b(red|black|white|blue|pink|green|purple|jute|hemp|cotton|nylon)\b/i;
const LIGHT_HINTS = [
  "Soft natural window light.",
  "Warm evening lamp light with deep shadows.",
  "Bright, even daylight.",
  "Moody low light from a single lamp.",
  "Golden late-afternoon sunlight across the room.",
  "Cool overcast light from a large window.",
];
const LOOK_HINTS = [
  "She is a woman in her late twenties with long straight dark hair.",
  "She is a woman in her thirties with shoulder-length blonde hair.",
  "She is a woman in her early thirties with curly red hair.",
  "She is a woman in her forties with short brown hair.",
  "She is a woman in her late twenties with a long brown braid.",
  "She is a woman in her thirties with wavy auburn hair in a ponytail.",
  "She is a woman in her twenties with straight black hair in a bun.",
  "She is a woman in her thirties with honey-blonde hair, slightly messy.",
];
const FOOT_HINTS = ["She is barefoot.", "She is wearing black high heels.", "She is wearing white socks.",
  "She is wearing ankle boots.", "She is wearing sneakers.", "She is wearing sheer tights and no shoes."];
const ROPE_HINTS = ["The rope is natural tan jute.", "The rope is red.", "The rope is black.",
  "The rope is white cotton.", "The rope is natural tan jute."];

// Body type, picked when the prompt and reference pictures say nothing about it, and placed first (tested
// earlier: body wording at the start is followed best). Height and feet differ too, so not every woman
// comes out the same size. heavy: soft body, so a strict tie gets a sentence about the rope pressing in.
const BODY_WORDS = /\b(petite|short(?=[ -](and|woman|girl|height|frame|stature|build|with))|tall|slim|slender|skinny|athletic|toned|muscular|curvy|chubby|plump|heavy|heavier|heavyset|fat|plus[- ]size|full[- ]figured|thick(?=[ -]?(thighs?|body|build|figure|hips|woman))|bbw|voluptuous|busty|stocky|lanky|small[- ]framed|(her|a|an) \w+ (body|build|figure))\b/i;
const BODY_HINTS = [
  { t: "She is petite and short, with a small frame and small, narrow feet." },
  { t: "She is slim and of average height, with slender arms and legs." },
  { t: "She is athletic and toned, with strong legs and defined arms." },
  { t: "She has an average, soft build and medium height." },
  { t: "She is curvy, with full hips, a full bust and thick thighs.", heavy: true },
  { t: "She is a heavier, full-figured woman with a round belly, wide hips, soft arms and thick thighs.", heavy: true },
  { t: "She is tall and long-limbed, with long legs and long, slender feet." },
];
// How tight the hogtie is: the prompt's own word wins ("strict", "tight", "loose"); otherwise picked per
// picture (strict and standard twice as often as loose). Each style has its own closing reminder.
const TIGHT_WORDS = /\b(strict(ly)?|tight(ly|er)?|severe(ly)?|compact(ly)?|cinched)\b/i;
const LOOSE_WORDS = /\b(loose(ly|r)?|relaxed|slack)\b/i;
const HOGTIE_WORDS = /\bhog[- ]?(tie[ds]?|tying)\b/i;
const TIE_STYLES = {
  strict: { hint: "It is a strict, tight hogtie: her wrists and ankles are cinched together with almost no gap, her back arched and her body pulled into a compact bow.",
    anchor: "Her bound ankles are pulled up tight against her bound wrists behind her back." },
  standard: { hint: "", anchor: "Her bound ankles are pulled up and tied to her bound wrists behind her back." },
  loose: { hint: "It is a loose hogtie: a longer rope leaves a gap of about a foot between her bound wrists and her bound ankles, her knees bent at an easy angle.",
    anchor: "A rope joins her bound ankles to her bound wrists behind her back." },
};
const TIE_PICKS = ["strict", "strict", "standard", "standard", "loose"];
// Small details (rope wraps, knots) blur at this size unless asked for (see PLAN.md, 2026-11-21).
const ROPE_CLARITY = "The rope wraps and knots around her wrists and ankles are sharp and clearly visible.";

function promptDetail(prompt) {
  const p = String(prompt || "").replace(/\b(the )?(woman|girl|lady|person) (from|in) (image|picture|photo) \d\b/gi, "");
  const words = (p.match(/[a-z0-9'-]+/gi) || []).length;
  const named = [CLOTHING_WORDS, CAMERA_WORDS, SETTING_WORDS, POSE_DETAIL_WORDS, LIGHT_WORDS, LOOK_WORDS, FOOT_WORDS,
    ROPE_COLOUR_WORDS].filter((re) => re.test(p)).length;
  if (words >= 35 || named >= 3) return "detailed";
  if (words <= 12 && named <= 1) return "vague";
  return "some";
}

// Sentences the picked LoRAs add to the prompt (see promptHints and clothingHints), as one string
// starting with a space, sized to how much the prompt already says (promptDetail). Edits (isEdit) get
// only the pose/gag wording: no outfit, angle or place, which would change the picture being edited.
// Without a seed the first wording of each list is used and nothing random is added. hasRefs: a reference
// picture is attached, so her look comes from it.
function loraPromptHints(prompt, loras, isEdit = false, seed = null, hasRefs = false) {
  const ls = (loras || []).map((l) => LORAS[l.id]).filter(Boolean);
  if (!ls.length) return "";
  const detail = promptDetail(prompt);
  const choose = (list, salt) => (seed == null ? list[0] : pickFor(list, seed, salt));
  const hints = ls.flatMap((l) => (l.promptHints || []).filter(([re]) => re.test(prompt)).filter(([re]) => {
    if (detail !== "detailed") return true;
    // A detailed prompt that already says how she's tied (or how the gag sits) keeps its own wording.
    const isGag = /gag/.test(re.source);
    return !(isGag ? GAG_DETAIL_WORDS : TIE_DESCRIBED).test(prompt);
  }).map(([, wordings], k) => choose([].concat(wordings), 11 + k)));
  const clothing = ls.find((l) => l.clothingHints)?.clothingHints;
  if (!isEdit) {
    if (clothing && !CLOTHING_WORDS.test(prompt)) hints.push(choose(clothing, 3));
    if (seed != null && detail !== "detailed") {
      if (!CAMERA_WORDS.test(prompt)) hints.push(pickFor(CAMERA_HINTS, seed, 5));
      if (!SETTING_WORDS.test(prompt)) hints.push(pickFor(SETTING_HINTS, seed, 7));
    }
    if (seed != null && detail === "vague") {
      if (/\b(rope[sd]?|tied|bound|hog[- ]?tie)/i.test(prompt) && !ROPE_COLOUR_WORDS.test(prompt)) hints.push(pickFor(ROPE_HINTS, seed, 13));
      if (!FOOT_WORDS.test(prompt)) hints.push(pickFor(FOOT_HINTS, seed, 17));
      if (!LIGHT_WORDS.test(prompt)) hints.push(pickFor(LIGHT_HINTS, seed, 19));
      if (!hasRefs && !LOOK_WORDS.test(prompt)) hints.push(pickFor(LOOK_HINTS, seed, 23));
    }
  }
  const ownPose = detail === "detailed" && TIE_DESCRIBED.test(prompt);
  // Hogtie: how tight, its closing reminder and the rope-detail sentence (see TIE_STYLES).
  const hogtie = ls.some((l) => l.poseAnchors) && HOGTIE_WORDS.test(prompt);
  let style = "standard";
  if (TIGHT_WORDS.test(prompt)) style = "strict";
  else if (LOOSE_WORDS.test(prompt)) style = "loose";
  else if (seed != null && detail !== "detailed" && !isEdit) style = pickFor(TIE_PICKS, seed, 29);
  if (hogtie && !ownPose && TIE_STYLES[style].hint) hints.splice(1, 0, TIE_STYLES[style].hint);
  // Body type goes first (see BODY_HINTS).
  if (!isEdit && !hasRefs && seed != null && detail !== "detailed" && !BODY_WORDS.test(prompt)) {
    const body = pickFor(BODY_HINTS, seed, 31);
    hints.unshift(body.t);
    if (body.heavy && style === "strict" && hogtie) hints.push("The tight rope presses into the soft skin of her wrists, ankles and thighs.");
  }
  // Repeat the key part of the pose last (see poseAnchors). Always, even when the prompt describes the tie:
  // it agrees with any hogtie and keeps a long prompt from losing it.
  for (const l of ls) for (const [re, anchor] of l.poseAnchors || []) {
    if (!re.test(prompt)) continue;
    hints.push(re === l.poseAnchors[0][0] && hogtie ? TIE_STYLES[style].anchor : anchor);
    if (hogtie && !isEdit) hints.push(ROPE_CLARITY);
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
