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
SUMMARY=/runpod-volume/cache/start-qwen21-summary.log
WORKER="${RUNPOD_POD_ID:-$(hostname)}"
log() { echo "start-qwen21: $*"; echo "$(date -u '+%m-%d %H:%M:%S') [$WORKER] $*" >> "$SUMMARY" 2>/dev/null || true; }

if [ ! -d "$VOL" ]; then
  log "no network volume at $VOL; starting without changes"
  exec /start.sh
fi
mkdir -p "$VOL/cache" "$VOL/models"
# Keep a copy of this script's output; at the end it is also rendered into an image in ComfyUI's input
# folder (startup_log.png), so a job with LoadImage → SaveImage can show it when RunPod's logs aren't at hand.
LOG="$VOL/cache/start-qwen21-$WORKER.log"
exec > >(tee "$LOG") 2>&1
log "---- start"

# Several workers can start at once (e.g. while RunPod rolls out a settings change) and they share this
# volume. Only one may download and fetch at a time, or they overwrite each other's partial files.
LOCK="$VOL/cache/start-qwen21.lock"
for i in $(seq 1 45); do
  if mkdir "$LOCK" 2>/dev/null; then
    echo "$WORKER" > "$LOCK/owner"
    trap 'rm -rf "$LOCK"' EXIT
    break
  fi
  age=$(( $(date +%s) - $(stat -c %Y "$LOCK" 2>/dev/null || date +%s) ))
  # Our own lock means RunPod stopped this worker mid-setup earlier; one older than 15 minutes is stale too.
  if [ "$(cat "$LOCK/owner" 2>/dev/null)" = "$WORKER" ] || [ "$age" -gt 900 ]; then
    log "taking over a leftover setup lock (${age}s old)"; rm -rf "$LOCK"; continue
  fi
  [ "$i" = 1 ] && log "worker $(cat "$LOCK/owner" 2>/dev/null) is setting up; waiting for it"
  sleep 20
done
log "volume space before: $(df -h "$VOL" | awk 'NR==2 {print $4 " free of " $2}')"

# ---------- 1. Qwen-Image 2.1 model files ----------
HF="https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main"
# path under models/ | bytes | sha256 (checked once, after the download)
# The image's extra_model_paths.yaml maps the volume's unet/ and clip/ folders (not diffusion_models/ or
# text_encoders/), so the files go there.
FILES=(
  "unet/qwen_image_2.1_turbo_int8_convrot.safetensors|7256787829|8144a0182964aa8403ad6dbc011db837304167d235161b9aabaa8532e967314c"
  "clip/qwen3vl_8b_int8_convrot.safetensors|9350798360|8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f"
  "vae/qwen_image_2.1_vae_bf16.safetensors|675509688|bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9"
)
# Files downloaded by an earlier version of this script into folders ComfyUI doesn't read.
for old in diffusion_models/qwen_image_2.1_turbo_int8_convrot.safetensors:unet text_encoders/qwen3vl_8b_int8_convrot.safetensors:clip; do
  src="$VOL/models/${old%%:*}"; dst="$VOL/models/${old##*:}/$(basename "${old%%:*}")"
  if [ -f "$src" ] && [ ! -f "$dst" ]; then mkdir -p "$(dirname "$dst")" && mv "$src" "$dst" && log "moved ${old%%:*} to ${old##*:}/"; fi
done
need=0
for e in "${FILES[@]}"; do
  IFS="|" read -r path bytes sum <<< "$e"
  f="$VOL/models/$path"
  have=$(stat -c %s "$f" 2>/dev/null || echo 0)
  [ "$have" = "$bytes" ] || need=$((need + bytes - $(stat -c %s "$f.part" 2>/dev/null || echo 0)))
done
free=$(df -B1 --output=avail "$VOL" | tail -1)
# RunPod stops a worker that isn't ready after about 8 minutes, so downloads get at most DOWNLOAD_SECONDS
# per start; partial files resume on the next start.
DEADLINE=$(( $(date +%s) + ${DOWNLOAD_SECONDS:-300} ))
if [ "$need" -gt 0 ] && [ "$free" -lt $((need + 2000000000)) ]; then
  log "NOT downloading Qwen-Image 2.1: needs $((need / 1000000000)) GB, only $((free / 1000000000)) GB free. Enlarge the network volume."
else
  for e in "${FILES[@]}"; do
    IFS="|" read -r path bytes sum <<< "$e"
    f="$VOL/models/$path"
    [ "$(stat -c %s "$f" 2>/dev/null || echo 0)" = "$bytes" ] && { log "have $path"; continue; }
    mkdir -p "$(dirname "$f")"
    # A partial file larger than the real one is damaged (e.g. by writes while the volume was full).
    if [ "$(stat -c %s "$f.part" 2>/dev/null || echo 0)" -gt "$bytes" ]; then log "removing damaged partial $path"; rm -f "$f.part"; fi
    left=$(( DEADLINE - $(date +%s) ))
    if [ "$left" -lt 15 ]; then log "no time left this start for $path; it downloads on the next start"; continue; fi
    log "downloading $path ($((bytes / 1000000)) MB, up to ${left}s this start)"
    err=$(timeout "$left" wget -nv -c --tries=5 --waitretry=5 -O "$f.part" "$HF/$path" 2>&1 | tail -3)
    got=$(stat -c %s "$f.part" 2>/dev/null || echo 0)
    if [ "$got" != "$bytes" ]; then
      log "ERROR: $path is $got of $bytes bytes after the download; it resumes on the next start. wget: $err"
    elif [ "$(sha256sum "$f.part" | cut -d" " -f1)" != "$sum" ]; then
      log "ERROR: $path has the wrong checksum; deleted, it downloads again on the next start"; rm -f "$f.part"
    else
      mv "$f.part" "$f" && log "downloaded $path"
    fi
  done
fi

# ---------- 2. LoRA add-ons ----------
if wget -qO "$VOL/cache/download-loras.sh" "$REPO_RAW/worker/download-loras.sh"; then
  bash "$VOL/cache/download-loras.sh" "$VOL" 2>&1 | tr '\r' '\n' | grep -v '^ *$' | grep -viE '^#|%' | while IFS= read -r l; do log "loras: $l"; done
else
  log "could not fetch download-loras.sh"
fi

# ---------- 3. Upgrade ComfyUI ----------
SRC="$VOL/cache/comfyui-$COMFY_VERSION"
if [ ! -f "$SRC/main.py" ]; then
  log "fetching ComfyUI $COMFY_VERSION"
  rm -rf "$SRC.tmp"
  git -c advice.detachedHead=false clone -q --depth 1 --branch "$COMFY_VERSION" https://github.com/comfyanonymous/ComfyUI "$SRC.tmp" \
    && mv "$SRC.tmp" "$SRC" || log "ERROR: git clone of ComfyUI $COMFY_VERSION failed"
fi
# The shared part is done; the rest only touches this container.
rm -rf "$LOCK"; trap - EXIT
if [ -f "$SRC/main.py" ]; then
  # Dependencies first (same pins as the image's Dockerfile; torch 2.11 cu128 is already installed and kept).
  # Only replace the code once they installed, so a failure leaves the old, working ComfyUI in place.
  if UV_CACHE_DIR="$VOL/cache/uv" UV_LINK_MODE=copy NO_COLOR=1 uv pip install --no-progress --python /opt/venv/bin/python \
       -r "$SRC/requirements.txt" "transformers>=4.50.3,<5" "huggingface-hub<1.0" > "$VOL/cache/uv-install.log" 2>&1; then
    (cd "$SRC" && tar --exclude=./models --exclude=./custom_nodes --exclude=./.git -cf - .) | (cd /comfyui && tar -xf -) \
      && log "ComfyUI is now $(python3 -c 'import sys; sys.path.insert(0, "/comfyui"); import comfyui_version; print(comfyui_version.__version__)' 2>/dev/null)" \
      || log "ERROR: copying ComfyUI $COMFY_VERSION failed"
  else
    log "ERROR: installing ComfyUI $COMFY_VERSION dependencies failed; keeping the image's ComfyUI. uv said:"
    tail -25 "$VOL/cache/uv-install.log" | while IFS= read -r l; do log "  uv: $l"; done
  fi
else
  log "ERROR: could not fetch ComfyUI $COMFY_VERSION; keeping the image's ComfyUI"
fi

log "volume space after: $(df -h "$VOL" | awk 'NR==2 {print $4 " free of " $2}')"
mkdir -p /comfyui/input
/opt/venv/bin/python - "$VOL" "$COMFY_VERSION" /comfyui/input/startup_log.png <<'PY' || log "could not render the log image"
# A status report rendered as an image (see the top of this script).
import os, re, sys, glob, textwrap, subprocess
from PIL import Image, ImageDraw
vol, ver, out = sys.argv[1:4]
def read(p, n=None):
    try:
        t = open(p, "rb").read().decode("utf-8", "replace")
    except OSError as e:
        return [f"({p}: {e.strerror})"]
    t = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", t)
    ls = [re.sub(r"[^\x20-\x7e]", "?", l) for l in re.split(r"[\r\n]+", t) if l.strip()]
    return ls[-n:] if n else ls
L = []
L.append("ComfyUI in /comfyui: " + " ".join(read("/comfyui/comfyui_version.py")[-1:]))
L.append(f"cached source {ver}: " + ("present" if os.path.isfile(f"{vol}/cache/comfyui-{ver}/main.py") else "MISSING"))
L.append("QwenImage21 nodes in /comfyui: " + str(bool(subprocess.run(["grep", "-rl", "QwenImage21Cache", "/comfyui/comfy_extras", "/comfyui/comfy_api_nodes"], capture_output=True).stdout)))
L.append("disk: " + subprocess.run(["df", "-h", vol], capture_output=True, text=True).stdout.replace("\n", " | "))
for f in sorted(glob.glob(f"{vol}/models/*/*qwen_image_2.1*") + glob.glob(f"{vol}/models/*/qwen3vl*") + glob.glob(f"{vol}/models/loras/*qwen21*")):
    L.append(f"  {f} {os.path.getsize(f)}")
L.append("--- summary ---"); L += read(f"{vol}/cache/start-qwen21-summary.log", 60)
L.append("--- uv install (last 40) ---"); L += read(f"{vol}/cache/uv-install.log", 40)
L = [w for l in L for w in (textwrap.wrap(l, 160) or [""])][-160:]
img = Image.new("RGB", (1300, 14 * len(L) + 20), "white")
d = ImageDraw.Draw(img)
for i, l in enumerate(L):
    d.text((10, 10 + 14 * i), l, fill="black")
img.save(out)
PY
exec /start.sh
