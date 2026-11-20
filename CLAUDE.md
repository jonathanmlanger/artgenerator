# Image Studio: notes for Claude

A private image generator for the owner's own use: realistic, adult-only bondage pictures of AI-made characters. The live app is https://image-studio.milbathepenguin.workers.dev (password login). Work happens on the **`wip-cloudflare-server`** branch; `main` holds an older GitHub Pages copy.

**Read `cloudflare/PLAN.md` first.** It is the full history: what was tried, what worked, IDs, and the reasons behind each choice. Add a short dated note there after every change that matters, and push.

## How it works

- `index.html`, `app.js`, `styles.css`, `cloud.js`: the app (plain JavaScript, no build step except bundling for the Worker).
- `workflows.js`: ComfyUI workflows (`MODELS`), add-ons (`LORAS`, `autoLoras`, `loraPromptHints`), sizes. Everything uses **Qwen-Image 2.1 Turbo** (`qwen-image-21`); older models are kept but hidden.
- `cloudflare/worker.js`: the Cloudflare Worker (login, RunPod proxy, R2 file storage). `node cloudflare/build.mjs` bundles the app into `cloudflare/dist/worker.js`.
- RunPod serverless endpoint **`kql1vtdh6u4qhe`** runs the custom image `ghcr.io/jonathanmlanger/image-studio-worker:comfyui-v0.46.0` (`worker/Dockerfile`, built by `.github/workflows/worker-image.yml`). Idle timeout 300 s. Models live on network volume `ng9zveug90` (100 GB, US-TX-3) in `unet/`, `clip/`, `vae/`, `loras/`. Endpoint `qn0cz6iqt4tzj6` (old Z-Image) is unused.
- Bondage add-on: "Bondage & Gags Megapack" for Qwen 2.1 at 1.0. Automatic mode adds pose/gag wording, uses landscape for hogties, and names clothes when the prompt has none.

## Keys and safety

- Keys come only from the cloud environment settings: `RUNPOD_API`, `CIVITAI_API`, `CLOUDFLARE_API_TOKEN`. Never print, log or commit any part of them; never ask for them in chat. Remind the owner to delete keys they no longer need.
- RunPod management API: `https://api.runpod.io/graphql` (worker logs: `https://api.runpod.io/v2/serverless/<endpoint>/workers/<pod>/logs?follow=true`). `rest.runpod.io` is not reachable from the container. Jobs: `https://api.runpod.ai/v2/<endpoint>/run`.
- Before changing a RunPod template or endpoint, save its current settings to the scratchpad and verify afterwards that only the intended fields changed. Anything that costs money (volumes, idle time, GPUs) needs the owner's OK first.
- Only adult characters; the app refuses prompts that mention minors. The owner's rule from the start is "no X-rated"; keep defaults and add-on suggestions within it unless the owner says otherwise. Reference photos should be AI-made characters or people who agreed.

## Deploy

`node cloudflare/build.mjs && npx --yes wrangler@4.164.0 deploy -c cloudflare/wrangler.toml` (needs `CLOUDFLARE_API_TOKEN`; never change the `PASSWORD_HASH` / `SESSION_SECRET` secrets). Then check: login page 200, `/api/config` 401 when signed out, and the served `app.js` / `workflows.js` / `styles.css` identical to the source (the edge can take a few seconds to update).

## Testing

Use Playwright against a local `python3 -m http.server` for UI changes (desktop and iPhone sizes), and real jobs on the endpoint for anything that affects pictures (a pair costs about a cent when warm). Look at the images before reporting.

## Working with the owner

- Plain language, no jargon in the app or in replies; the owner prefers a clean, chat-first screen with few settings.
- Keep on-screen text neutral (no bondage terms in labels, hints or messages) so the app can be shown to others; such terms belong only in the code (keyword matching, prompt hints).
- Show test pictures when reporting image changes.
- The owner is in US Central time. A weekly "Weekly image model check" scheduled task (Tuesdays 9:40 AM Central) reports new models and add-ons; it never changes anything.
- Ideas on hold: a cheaper 30 GB volume (~$2/month instead of ~$7), the QMA camera-angle add-on for "from above"-style edits, and a "more variety" option using the full (non-Turbo) model.
