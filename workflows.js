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
};

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
