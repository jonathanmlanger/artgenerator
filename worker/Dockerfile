# Image Studio worker: RunPod's worker-comfyui with a ComfyUI new enough for Qwen-Image 2.1 (0.37+).
# Models stay on the network volume (see worker/start-qwen21.sh for the files and folders).
# Built and published by .github/workflows/worker-image.yml to ghcr.io/jonathanmlanger/image-studio-worker.
FROM runpod/worker-comfyui:5.10.0-base

ARG COMFYUI_VERSION=v0.46.0

# Replace the ComfyUI code (keeping the image's models/, custom_nodes/ and extra_model_paths.yaml), then
# install its dependencies with the same pins as the base image: torch 2.11 cu128 stays, transformers < 5.
RUN git clone -q --depth 1 --branch "${COMFYUI_VERSION}" https://github.com/comfyanonymous/ComfyUI /tmp/comfyui \
    && (cd /tmp/comfyui && tar --exclude=./models --exclude=./custom_nodes --exclude=./.git -cf - .) | (cd /comfyui && tar -xf -) \
    && rm -rf /tmp/comfyui \
    && uv pip install --python /opt/venv/bin/python -r /comfyui/requirements.txt "transformers>=4.50.3,<5" "huggingface-hub<1.0" \
    && uv cache clean

# Same smoke test as the base image: ComfyUI must start and load all its nodes.
RUN cd /comfyui && timeout 300 python main.py --quick-test-for-ci --cpu \
    && grep -rq QwenImage21Cache /comfyui/comfy_extras /comfyui/comfy_api_nodes
