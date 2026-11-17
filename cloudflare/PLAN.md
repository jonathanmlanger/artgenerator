# Work in progress: private server with password login

Status: **paused** (branch `wip-cloudflare-server`). The live site on `main` is unaffected.

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

## To do

1. **App "server mode"** (`app.js`, `cloud.js`, `index.html`):
   - At startup, detect `/api/config`.
   - When it's present:
     - route RunPod calls through `/api/runpod/...` and storage through `/api/files`
     - hide the browser-key fields in Settings
     - add **Change password** and **Sign out**
     - save RunPod settings with `PUT /api/config`
   - The GitHub Pages version keeps working as it does now.
2. **Test locally** with miniflare, using a mock R2 bucket.
3. **Deploy.** Needs a Cloudflare API token from the user, created from the **"Edit Cloudflare Workers"** template.
   - Upload the script with the R2 binding `BUCKET` = `image-studio`, plus the secrets `SESSION_SECRET` and `PASSWORD_HASH`.
   - Enable the workers.dev address.
   - Give the user the generated password.
4. **User:** sign in, then enter the RunPod key and both endpoint IDs once in Settings:
   - main: `qn0cz6iqt4tzj6`
   - character reference: `kql1vtdh6u4qhe`
5. **Optional:** connect the GitHub repo to Cloudflare Workers Builds so every push redeploys automatically. Retire the GitHub Pages copy if it's no longer wanted.

## Current setup (for reference)

| Item | Value |
|---|---|
| RunPod main endpoint | `qn0cz6iqt4tzj6` (Z-Image, Chroma; RTX 4090 → L40S) |
| RunPod edit endpoint | `kql1vtdh6u4qhe` (Qwen Image Edit; L40S → RTX 4090) |
| Network volume | `image-studio-models`, 70 GB, US-TX-3, ID `ng9zveug90` |
| R2 bucket | `image-studio`; CORS allows only `https://jonathanmlanger.github.io` |
