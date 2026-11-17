# Work in progress: private server with password login

Status: **paused** (branch `wip-cloudflare-server`). The live site on `main` is unaffected.

## API keys checklist

**Done (2026-11-17).** The user deleted the two exposed RunPod keys, the `claude-setup` and `image-studio-app` R2 tokens, and the deploy token. Its rejection by Cloudflare was confirmed. No Cloudflare API tokens remain. A future redeploy needs a new token from the "Edit Cloudflare Workers" template, added to the cloud environment settings as `CLOUDFLARE_API_TOKEN` (never pasted in chat) and deleted afterwards.

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

## To do

0. **Redeploy (urgent).** On 2026-11-17, after the API tokens were deleted, the `image-studio` Worker disappeared from the account and the site returns Cloudflare error 1042. The bucket and its data are unaffected. A new "Edit Cloudflare Workers" token is in the environment as `CLOUDFLARE_API_TOKEN`. Steps:
   - `node cloudflare/build.mjs`, then `npx wrangler deploy -c cloudflare/wrangler.toml`. Only `dist/worker.js` is uploaded, about 120 KB.
   - Create fresh secrets with `wrangler secret bulk`. `SESSION_SECRET` is random. `PASSWORD_HASH` uses the format `pbkdf2$100000$<b64 salt>$<b64 sha256 hash>` for a newly generated password. Keep the secrets file in the scratchpad and delete it afterwards. If the user changed the password in Settings, that one is stored in the bucket and still applies, and the new `PASSWORD_HASH` is ignored.
   - Check that the live site shows the login page and that sign-in works. Give the user the password and remind them to delete the token.

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
