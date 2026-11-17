# RunPod serverless worker for Image Studio (Step 6 "upgrade" in README.md).
# Starts from RunPod's official ComfyUI worker image that already contains Z-Image Turbo,
# then adds Z-Image Base, Chroma1-HD and Qwen Image Edit 2511 (character reference mode).
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

# Qwen Image Edit 2511 (~31 GB total) for the "Character / scene reference" mode:
# diffusion model, Qwen2.5-VL text encoder, VAE, and the 4-step Lightning LoRA.
RUN comfy model download \
      --url https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_edit_2511_fp8mixed.safetensors \
      --relative-path models/diffusion_models --filename qwen_image_edit_2511_fp8mixed.safetensors
RUN comfy model download \
      --url https://huggingface.co/Comfy-Org/HunyuanVideo_1.5_repackaged/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors \
      --relative-path models/text_encoders --filename qwen_2.5_vl_7b_fp8_scaled.safetensors
RUN comfy model download \
      --url https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors \
      --relative-path models/vae --filename qwen_image_vae.safetensors
RUN comfy model download \
      --url https://huggingface.co/lightx2v/Qwen-Image-Edit-2511-Lightning/resolve/main/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors \
      --relative-path models/loras --filename Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors
