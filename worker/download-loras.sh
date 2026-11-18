#!/usr/bin/env bash
# Downloads the LoRA add-ons listed in the app (LORAS in workflows.js) onto a RunPod network volume.
#
# Run this in the web terminal of a temporary Pod that has your network volume attached.
# Some Civitai files need a free Civitai account: create an API key at civitai.com → Account settings →
# API Keys, then run (replace the key, keep the space at the start so it isn't saved in shell history):
#    export CIVITAI_TOKEN=your_key_here
#   curl -fsSL https://raw.githubusercontent.com/jonathanmlanger/artgenerator/wip-cloudflare-server/worker/download-loras.sh | bash
# (or wget -qO- <same URL> | bash where curl isn't installed)
#
# Files go to models/loras (/workspace on a Pod, /runpod-volume for serverless workers).
# Safe to re-run: files that are already complete are skipped.
set -euo pipefail

ROOT="${1:-/workspace}"
DEST="$ROOT/models/loras"

if [ ! -d "$ROOT" ]; then
  echo "ERROR: $ROOT doesn't exist. Is the network volume attached to this Pod?" >&2
  exit 1
fi
mkdir -p "$DEST"

# filename | Civitai model version ID | SHA-256 | needs a Civitai key
FILES=(
  "rope_cleave_gag_zib.safetensors|2846501|20356AA0B94E69E03B73714BACCEE3BE94D3FDB5727C8CEEE93F6AB5A968F8CE|yes"
  "ball_gag_zit.safetensors|2731175|65720566E017FEBAD5D5FC5511852A5173B02474031FF92BF3B0FE3CE6870D78|no"
)

sha() { sha256sum "$1" | awk '{print toupper($1)}'; }

# curl if available, else wget (the runpod/worker-comfyui image has no curl).
download() {
  if command -v curl >/dev/null 2>&1; then
    local auth=()
    [ -n "${CIVITAI_TOKEN:-}" ] && auth=(-H "Authorization: Bearer $CIVITAI_TOKEN")
    curl -fL --retry 5 --retry-delay 5 --progress-bar "${auth[@]}" -o "$2" "$1"
  else
    # Token as a query parameter: wget would resend an Authorization header to the storage host after the redirect.
    local url="$1"
    [ -n "${CIVITAI_TOKEN:-}" ] && url="$url?token=$CIVITAI_TOKEN"
    wget -q --tries=5 --waitretry=5 -O "$2" "$url"
  fi
}

failed=0
i=0
for entry in "${FILES[@]}"; do
  i=$((i + 1))
  IFS="|" read -r name version hash needs_key <<< "$entry"
  dest="$DEST/$name"
  if [ -f "$dest" ] && [ "$(sha "$dest")" = "$hash" ]; then
    echo "[$i/${#FILES[@]}] $name already downloaded, skipping"
    continue
  fi
  if [ "$needs_key" = "yes" ] && [ -z "${CIVITAI_TOKEN:-}" ]; then
    echo "[$i/${#FILES[@]}] SKIPPED $name: it needs a Civitai API key. Set CIVITAI_TOKEN (see the top of this script) and run again." >&2
    failed=1
    continue
  fi
  echo "[$i/${#FILES[@]}] Downloading $name -> models/loras/"
  url="https://civitai.com/api/download/models/$version"
  if ! download "$url" "$dest.part"; then
    echo "ERROR: download of $name failed. If it says 401/403, check your Civitai API key." >&2
    rm -f "$dest.part"; failed=1; continue
  fi
  if [ "$(sha "$dest.part")" != "$hash" ]; then
    echo "ERROR: $name doesn't match the expected checksum; not installed. Run the command again." >&2
    rm -f "$dest.part"; failed=1; continue
  fi
  mv "$dest.part" "$dest"
done

echo
ls -lh "$DEST"
echo
if [ "$failed" = 1 ]; then
  echo "Some files were not downloaded (see above). Fix the problem and run the same command again."
  exit 1
fi
echo "Done. You can now TERMINATE this Pod (the files stay on the network volume)."
