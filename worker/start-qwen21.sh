#!/usr/bin/env bash
# Container start command for a runpod/worker-comfyui 5.10.0 endpoint that should also run Qwen-Image 2.1.
#
# The image ships ComfyUI 0.34; Qwen-Image 2.1 needs 0.37 or newer. On every start this script:
#   1. downloads the Qwen-Image 2.1 files onto the network volume (once; skipped when present),
#   2. downloads the LoRA add-ons (worker/download-loras.sh; needs CIVITAI_TOKEN only for new files),
#   3. upgrades ComfyUI to $COMFY_VERSION, with the source and the Python package cache kept on the volume
#      so later starts are quick,
#   4. starts the worker as usual (/start.sh).
# Any failure in steps 1–3 is logged and the worker still starts (with the old ComfyUI if step 3 failed).
#
# RunPod → Serverless → endpoint → Edit → Container Start Command:
#   bash -c "wget -qO- https://raw.githubusercontent.com/jonathanmlanger/artgenerator/wip-cloudflare-server/worker/start-qwen21.sh | bash"
set -uo pipefail

VOL=/runpod-volume
COMFY_VERSION="${COMFY_VERSION:-v0.46.0}"
REPO_RAW="https://raw.githubusercontent.com/jonathanmlanger/artgenerator/${SCRIPT_REF:-wip-cloudflare-server}"
log() { echo "start-qwen21: $*"; }

if [ ! -d "$VOL" ]; then
  log "no network volume at $VOL; starting without changes"
  exec /start.sh
fi
mkdir -p "$VOL/cache" "$VOL/models"
# Keep a copy of this script's output; at the end it is also rendered into an image in ComfyUI's input
# folder (startup_log.png), so a job with LoadImage → SaveImage can show it when RunPod's logs aren't at hand.
LOG="$VOL/cache/start-qwen21.log"
exec > >(tee "$LOG") 2>&1
log "volume space before: $(df -h "$VOL" | awk 'NR==2 {print $4 " free of " $2}')"

# ---------- 1. Qwen-Image 2.1 model files ----------
HF="https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main"
# path under models/ | bytes
FILES=(
  "diffusion_models/qwen_image_2.1_turbo_int8_convrot.safetensors|7256787829"
  "text_encoders/qwen3vl_8b_int8_convrot.safetensors|9350798360"
  "vae/qwen_image_2.1_vae_bf16.safetensors|675509688"
)
need=0
for e in "${FILES[@]}"; do
  IFS="|" read -r path bytes <<< "$e"
  f="$VOL/models/$path"
  have=$(stat -c %s "$f" 2>/dev/null || echo 0)
  [ "$have" = "$bytes" ] || need=$((need + bytes - $(stat -c %s "$f.part" 2>/dev/null || echo 0)))
done
free=$(df -B1 --output=avail "$VOL" | tail -1)
if [ "$need" -gt 0 ] && [ "$free" -lt $((need + 2000000000)) ]; then
  log "NOT downloading Qwen-Image 2.1: needs $((need / 1000000000)) GB, only $((free / 1000000000)) GB free. Enlarge the network volume."
else
  for e in "${FILES[@]}"; do
    IFS="|" read -r path bytes <<< "$e"
    f="$VOL/models/$path"
    [ "$(stat -c %s "$f" 2>/dev/null || echo 0)" = "$bytes" ] && { log "have $path"; continue; }
    mkdir -p "$(dirname "$f")"
    log "downloading $path ($((bytes / 1000000)) MB)"
    if wget -q -c --tries=5 --waitretry=5 -O "$f.part" "$HF/$path" && [ "$(stat -c %s "$f.part")" = "$bytes" ]; then
      mv "$f.part" "$f"
    else
      log "ERROR: download of $path failed or is the wrong size; it resumes on the next start"
    fi
  done
fi

# ---------- 2. LoRA add-ons ----------
if wget -qO "$VOL/cache/download-loras.sh" "$REPO_RAW/worker/download-loras.sh"; then
  bash "$VOL/cache/download-loras.sh" "$VOL" 2>&1 | sed 's/^/start-qwen21: loras: /' || log "some LoRAs were not downloaded"
else
  log "could not fetch download-loras.sh"
fi

# ---------- 3. Upgrade ComfyUI ----------
SRC="$VOL/cache/comfyui-$COMFY_VERSION"
if [ ! -f "$SRC/main.py" ]; then
  log "fetching ComfyUI $COMFY_VERSION"
  rm -rf "$SRC.tmp"
  git clone -q --depth 1 --branch "$COMFY_VERSION" https://github.com/comfyanonymous/ComfyUI "$SRC.tmp" && mv "$SRC.tmp" "$SRC"
fi
if [ -f "$SRC/main.py" ]; then
  # Dependencies first (same pins as the image's Dockerfile; torch 2.11 cu128 is already installed and kept).
  # Only replace the code once they installed, so a failure leaves the old, working ComfyUI in place.
  if UV_CACHE_DIR="$VOL/cache/uv" UV_LINK_MODE=copy uv pip install --python /opt/venv/bin/python \
       -r "$SRC/requirements.txt" "transformers>=4.50.3,<5" "huggingface-hub<1.0"; then
    (cd "$SRC" && tar --exclude=./models --exclude=./custom_nodes --exclude=./.git -cf - .) | (cd /comfyui && tar -xf -) \
      && log "ComfyUI is now $(python3 -c 'import sys; sys.path.insert(0, "/comfyui"); import comfyui_version; print(comfyui_version.__version__)' 2>/dev/null)" \
      || log "ERROR: copying ComfyUI $COMFY_VERSION failed"
  else
    log "ERROR: installing ComfyUI $COMFY_VERSION dependencies failed; keeping the image's ComfyUI"
  fi
else
  log "ERROR: could not fetch ComfyUI $COMFY_VERSION; keeping the image's ComfyUI"
fi

log "volume space after: $(df -h "$VOL" | awk 'NR==2 {print $4 " free of " $2}')"
mkdir -p /comfyui/input
/opt/venv/bin/python - "$LOG" /comfyui/input/startup_log.png <<'PY' || log "could not render the log image"
import sys, textwrap
from PIL import Image, ImageDraw
lines = [l for l in open(sys.argv[1], errors="replace").read().splitlines() if "%|" not in l][-150:]
lines = [w for l in lines for w in (textwrap.wrap(l, 160) or [""])][-150:]
img = Image.new("RGB", (1300, 14 * len(lines) + 20), "white")
d = ImageDraw.Draw(img)
for i, l in enumerate(lines):
    d.text((10, 10 + 14 * i), l, fill="black")
img.save(sys.argv[2])
PY
exec /start.sh
