# RunPod serverless worker for Image Studio (Step 6 "upgrade" in README.md).
# Starts from RunPod's official ComfyUI worker image that already contains Z-Image Turbo,
# then adds Z-Image Base and Chroma1-HD so all three models in the web app work.
FROM runpod/worker-comfyui:5.10.0-z-image-turbo

# Z-Image Base (~12 GB): slower, more detailed, supports negative prompts.
# Reuses the Qwen text encoder and VAE already in the base image.
RUN comfy model download \
      --url https://huggingface.co/Comfy-Org/z_image/resolve/main/split_files/diffusion_models/z_image_bf16.safetensors \
      --relative-path models/diffusion_models --filename z_image_bf16.safetensors

# Chroma1-HD (~9 GB) plus its T5 text encoder (~5 GB). Uses the same ae.safetensors VAE.
RUN comfy model download \
      --url https://huggingface.co/Comfy-Org/Chroma1-HD_repackaged/resolve/main/split_files/diffusion_models/Chroma1-HD-fp8mixed.safetensors \
      --relative-path models/diffusion_models --filename Chroma1-HD-fp8mixed.safetensors
RUN comfy model download \
      --url https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn_scaled.safetensors \
      --relative-path models/text_encoders --filename t5xxl_fp8_e4m3fn_scaled.safetensors
