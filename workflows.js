// ComfyUI workflows (API format) for each model.
// Node settings come from the official ComfyUI workflow templates for these models.
// Each builder receives the user's settings and returns a workflow object for worker-comfyui.

const MODELS = {
  "z-image-turbo": {
    label: "Z-Image Turbo — fast photoreal",
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
  pose: {
    label: "Copy pose & composition",
    note: "Traces the outlines of your image (bodies, poses, props, framing) and builds a new image on them that follows your prompt. Uses Z-Image Turbo. Strength 0.6–1.0 works well.",
    maxImages: 1, model: "z-image-turbo", needsUpgrade: false, strength: 0.8,
  },
  img2img: {
    label: "Start from this image",
    note: "Repaints your image with any model. Strength: 0.5–0.7 subtle touch-ups, ~0.8 restyle (e.g. photo → painting), 0.9+ big changes that keep only the rough layout.",
    maxImages: 1, model: null, needsUpgrade: false, strength: 0.75,
  },
  character: {
    label: "Character / scene reference",
    note: "Up to 3 images: e.g. image 1 = your character, image 2 = a pose or setting. Write prompts like “The woman from image 1 in the pose from image 2, in a candlelit room.” Requires the Step 6 upgrade.",
    maxImages: 3, model: "qwen-edit", needsUpgrade: true, strength: null,
  },
};

// Adds reference-image nodes to a workflow built by MODELS[...].build().
// s.refNames are the uploaded filenames, s.refStrength is 0–1.
function applyReference(g, s) {
  if (s.refMode === "pose") {
    g["20"] = { class_type: "LoadImage", inputs: { image: s.refNames[0] } };
    g["21"] = { class_type: "ImageScale", inputs: { image: ["20", 0], upscale_method: "bicubic", width: s.width, height: s.height, crop: "center" } };
    g["22"] = { class_type: "Canny", inputs: { image: ["21", 0], low_threshold: 0.1, high_threshold: 0.32 } };
    g["23"] = { class_type: "ModelPatchLoader", inputs: { name: "Z-Image-Turbo-Fun-Controlnet-Union.safetensors" } };
    g["24"] = { class_type: "QwenImageDiffsynthControlnet", inputs: {
      model: ["1", 0], model_patch: ["23", 0], vae: ["3", 0], image: ["22", 0], strength: s.refStrength } };
    g["4"].inputs.model = ["24", 0];
  } else if (s.refMode === "img2img") {
    g["20"] = { class_type: "LoadImage", inputs: { image: s.refNames[0] } };
    g["21"] = { class_type: "ImageScale", inputs: { image: ["20", 0], upscale_method: "bicubic", width: s.width, height: s.height, crop: "center" } };
    g["25"] = { class_type: "VAEEncode", inputs: { pixels: ["21", 0], vae: ["3", 0] } };
    g["26"] = { class_type: "RepeatLatentBatch", inputs: { samples: ["25", 0], amount: s.count } };
    delete g["7"];
    g["8"].inputs.latent_image = ["26", 0];
    g["8"].inputs.denoise = s.refStrength;
  }
  return g;
}

// A tiny job that only exists to start a GPU worker and load the model.
function warmupWorkflow() {
  // The small 256px result is returned but the app discards it.
  return MODELS["z-image-turbo"].build({ prompt: "warm up", width: 256, height: 256, count: 1, seed: 1, steps: 1, cfg: 1 });
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
