#!/usr/bin/env bash
# Downloads the extra Image Studio models onto a RunPod network volume.
#
# Run this in the web terminal of a temporary Pod that has your network volume attached:
#   curl -fsSL https://raw.githubusercontent.com/jonathanmlanger/artgenerator/main/worker/download-models.sh | bash
#
# Pods mount the volume at /workspace; serverless workers see the same files at /runpod-volume.
# Folder names follow the worker's extra_model_paths.yaml: "unet" = diffusion models, "clip" = text encoders.
# Safe to re-run: finished files are skipped and partial downloads resume.
set -euo pipefail

ROOT="${1:-/workspace}"
M="$ROOT/models"
HF="https://huggingface.co"

if [ ! -d "$ROOT" ]; then
  echo "ERROR: $ROOT doesn't exist. Is the network volume attached to this Pod?" >&2
  exit 1
fi
mkdir -p "$M/unet" "$M/clip" "$M/vae" "$M/loras"

# folder | filename | url | expected bytes
FILES=(
  "unet|z_image_bf16.safetensors|$HF/Comfy-Org/z_image/resolve/main/split_files/diffusion_models/z_image_bf16.safetensors|12309866400"
  "unet|Chroma1-HD-fp8mixed.safetensors|$HF/Comfy-Org/Chroma1-HD_repackaged/resolve/main/split_files/diffusion_models/Chroma1-HD-fp8mixed.safetensors|9193379316"
  "clip|t5xxl_fp8_e4m3fn_scaled.safetensors|$HF/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn_scaled.safetensors|5157348688"
  "unet|qwen_image_edit_2511_fp8mixed.safetensors|$HF/Comfy-Org/Qwen-Image-Edit_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_edit_2511_fp8mixed.safetensors|0"
  "clip|qwen_2.5_vl_7b_fp8_scaled.safetensors|$HF/Comfy-Org/HunyuanVideo_1.5_repackaged/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors|0"
  "vae|qwen_image_vae.safetensors|$HF/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors|0"
  "loras|Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors|$HF/lightx2v/Qwen-Image-Edit-2511-Lightning/resolve/main/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors|0"
)

free_gb=$(df -Pk "$ROOT" | awk 'NR==2 {print int($4/1024/1024)}')
echo "Free space on volume: ${free_gb} GB (about 58 GB needed for a fresh download)"

remote_size() { curl -sIL "$1" | tr -d '\r' | awk 'tolower($1)=="x-linked-size:"{s=$2} tolower($1)=="content-length:"{c=$2} END{print (s?s:c)}'; }

i=0
for entry in "${FILES[@]}"; do
  i=$((i + 1))
  IFS="|" read -r dir name url expected <<< "$entry"
  dest="$M/$dir/$name"
  [ "$expected" = "0" ] && expected="$(remote_size "$url")"
  have=$( [ -f "$dest" ] && stat -c %s "$dest" || echo 0 )
  if [ -n "$expected" ] && [ "$have" = "$expected" ]; then
    echo "[$i/${#FILES[@]}] $name already downloaded, skipping"
    continue
  fi
  echo "[$i/${#FILES[@]}] Downloading $name ($(( ${expected:-0} / 1000000 )) MB) -> models/$dir/"
  curl -fL --retry 5 --retry-delay 5 -C - --progress-bar -o "$dest" "$url"
  have=$(stat -c %s "$dest")
  if [ -n "$expected" ] && [ "$have" != "$expected" ]; then
    echo "ERROR: $name is $have bytes, expected $expected. Run the command again to resume." >&2
    exit 1
  fi
done

echo
echo "All models downloaded:"
du -sh "$M"/* 2>/dev/null
echo
echo "Done. You can now TERMINATE this Pod (the files stay on the network volume)."
