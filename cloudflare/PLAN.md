# Work in progress: private server with password login

Status: **paused** (branch `wip-cloudflare-server`). The live site on `main` is unaffected.

## API keys checklist

**Done (2026-11-17).** The user deleted the two exposed RunPod keys, the `claude-setup` and `image-studio-app` R2 tokens, and the deploy token. Its rejection by Cloudflare was confirmed. The temporary "Edit Cloudflare Workers" token used for the 2026-11-17 redeploy was also deleted afterwards, and removed from the cloud environment settings. No Cloudflare API tokens remain. A future redeploy needs a new token from the "Edit Cloudflare Workers" template, added to the cloud environment settings as `CLOUDFLARE_API_TOKEN` (never pasted in chat) and deleted afterwards.

## Goal

Stop typing keys on every device. Instead:

- The app runs from a private Cloudflare Worker address (e.g. `image-studio.<name>.workers.dev`) behind a password.
- Each device signs in once and stays signed in for a year.
- The RunPod key and endpoint IDs are saved once in the app's Settings and stored privately in the R2 bucket (`_config/settings.json`), readable only by the Worker. No keys are kept in any browser, and no R2 key is needed.

## Done

- `cloudflare/worker.js`: the server. It handles:
  - password login (PBKDF2 hash, signed session cookie that lasts 1 year; changing the password signs out other devices)
  - a RunPod proxy at `/api/runpod/<main|edit>/...`
  - file storage on the bound R2 bucket at `/api/files`
  - settings and password-change endpoints
- `cloudflare/login.html`: the sign-in page.
- `cloudflare/build.mjs`: bundles the app files into `cloudflare/dist/worker.js`.
- **App "server mode"** (`app.js`, `cloud.js`, `index.html`): detects `/api/config` at startup, then routes RunPod calls through `/api/runpod/...` and storage through `/api/files`, saves RunPod settings with `PUT /api/config`, hides the browser-key fields, and adds **Change password** and **Sign out**. The GitHub Pages version is unchanged.
- **Tested locally** with Miniflare (mock R2, mocked RunPod) and Playwright: login, proxy, edit-endpoint routing, file API, sync, `_config/` hidden, password change signing out other devices, sign out. All passed.
- **Deployed (2026-11-17)** at https://image-studio.milbathepenguin.workers.dev with the `BUCKET` binding, the `SESSION_SECRET` and `PASSWORD_HASH` secrets, and preview URLs turned off. Checked live: login page, wrong password refused, sign-in, `/api/config`, `/api/files`. To redeploy: `node cloudflare/build.mjs`, then run `wrangler deploy` from a folder holding only the built `worker.js` and a `wrangler.toml` (name `image-studio`, `workers_dev = true`, `preview_urls = false`, `no_bundle = true`, R2 binding `BUCKET` → `image-studio`).
- **Redeployed (2026-11-17)** after the Worker disappeared from the account (Cloudflare error 1042) once the API tokens were deleted. The bucket and its data were unaffected. Built with `node cloudflare/build.mjs` and deployed with `npx wrangler deploy -c cloudflare/wrangler.toml` (119 KB). Fresh secrets were set with `wrangler secret bulk`: a random `SESSION_SECRET` and a `PASSWORD_HASH` (format `pbkdf2$100000$<b64 salt>$<b64 sha256 hash>`) for a newly generated password (given to the user, not stored here; a password changed in Settings is stored in the bucket and overrides it). The secrets file was deleted afterwards. Checked live: login page, wrong password refused, sign-in, `/api/config`, `/api/files`. The user then deleted the token, signed in on their devices and confirmed the RunPod settings in Settings.
- **LoRA add-ons deployed (2026-11-17).** `8c234b5` built with `node cloudflare/build.mjs` (125 KB) and deployed with `npx wrangler deploy -c cloudflare/wrangler.toml` (wrangler 4.164.0, version `6a37b135-1a76-48e4-ac36-0fdb18c4e095`). Existing secrets `PASSWORD_HASH` and `SESSION_SECRET` were kept. Checked live: page loads, `/api/config` refuses without sign-in (401), wrong password refused (401), served `app.js` and `workflows.js` include the LoRA picker.
- **Retries and wake-up fix deployed (2026-11-17, version `79076772`).** RunPod calls and file sync now retry network failures and 429/502/503/504 for about a minute (`fetchRetry` in `cloud.js`), so a spotty Wi-Fi/VPN connection no longer loses a running job or shows "Sync error" straight away. "Wake up GPU" now warms the endpoint and model the current settings use (the edit endpoint for Character / scene reference); before, it always warmed Z-Image Turbo on the main endpoint.

## To do

### Start here next time: get the LoRAs working (this decides whether the project continues)

1. **Safety first:** if not done yet, delete the "Edit Cloudflare Workers" token and remove `CLOUDFLARE_API_TOKEN` from the cloud environment settings. (A new one is only needed for the next deploy.)
2. **Get a Civitai API key** (civitai.com → Account settings → API Keys). Needed for the rope/cleave gag LoRA.
3. **Start a temporary Pod with the network volume:** RunPod → Storage → `image-studio-models` → **Deploy**. It must run in the volume's datacenter (US-TX-3); any cheap GPU will do, since it only downloads files. *This is the step that hasn't worked yet:* if it fails, note the exact error or what the screen shows (e.g. no GPUs available), and bring that to the next session.
4. **In the Pod's web terminal**, run (leading space keeps the key out of history):
   ```bash
    export CIVITAI_TOKEN=your_key_here
   curl -fsSL https://raw.githubusercontent.com/jonathanmlanger/artgenerator/wip-cloudflare-server/worker/download-loras.sh | bash
   ```
   Wait for it to finish (checksums verified), then **terminate the Pod**.
5. **Test in the app** (https://image-studio.milbathepenguin.workers.dev): Z-Image Base, then Turbo, with each LoRA ticked at 0.8. Try a few seeds and strengths (0.6–1.0).
6. **Decide:** if results are realistic enough, continue (more rope-tie LoRAs, no X-rated ones). If not, move on.

### Later
- **Longer RunPod idle timeout** (RunPod → Serverless → each endpoint → Edit → Idle timeout, 3–5 min) so the GPU stays warm between prompts. Idle time is billed.
- **Optional:** connect the GitHub repo to Cloudflare Workers Builds so every push redeploys automatically. Retire the GitHub Pages copy if it's no longer wanted.

## Current setup (for reference)

| Item | Value |
|---|---|
| RunPod main endpoint | `qn0cz6iqt4tzj6` (Z-Image, Chroma; RTX 4090 → L40S) |
| RunPod edit endpoint | `kql1vtdh6u4qhe` (Qwen Image Edit; L40S → RTX 4090) |
| Network volume | `image-studio-models`, 70 GB, US-TX-3, ID `ng9zveug90` |
| R2 bucket | `image-studio`; CORS allows only `https://jonathanmlanger.github.io` |
