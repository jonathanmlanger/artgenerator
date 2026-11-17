# Work in progress: private server with password login

Status: **paused** (branch `wip-cloudflare-server`). The live site on `main` is unaffected.

## API keys checklist (do before or at the start of the next session)

Two keys were pasted into the chat, so treat them as exposed and delete them. Each one is identified below by its first few characters only.

### RunPod: console.runpod.io → Settings → API Keys

| Key | What it was | Action |
|---|---|---|
| Starts `rpa_QHKC…` | First key pasted in chat. RunPod rejected it for account management (probably Restricted / Read-only). | **Delete** |
| Starts `rpa_BYYS…` | Second key pasted in chat; full access. Used to set up the volume, Pod and endpoints. | **Delete** |
| The key in the app's Settings (the one from Step 1 of the README) | What the app uses to generate images | **Check** it isn't one of the two above. If it is, create a new key (e.g. `image-studio-app`, Restricted to the two endpoints if offered, otherwise Read/Write) and enter it in the app's **Settings** (never in chat). |

**Next session:** once the private server is live, enter the app's RunPod key once in the new app's Settings. It's then stored on the server for every device.

### Cloudflare: dash.cloudflare.com

| Token | Where | Action |
|---|---|---|
| `claude-setup` (R2 token, Admin Read & Write; Access Key ID starts `ec8c5c75…`) | R2 Object Storage → Manage API tokens | **Delete**. It was pasted in chat. |
| `image-studio-app` (R2 token, Object Read & Write), only if you created it | R2 Object Storage → Manage API tokens | Keep for now if the GitHub Pages app uses it for cloud sync. **Delete** after moving to the private server, which doesn't need it. |
| **New for the next session:** an API token from the **"Edit Cloudflare Workers"** template | My Profile (top right) → API Tokens → Create Token | **Create** it, and add it to the cloud environment settings as `CLOUDFLARE_API_TOKEN` rather than pasting it in chat. **Delete** it after deployment. |

### GitHub

**Nothing to change.** No GitHub keys or tokens were created. Claude reaches the repository through the Claude GitHub App connection you set up on claude.ai, and the site contains no secrets.

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
- **Partly deployed (2026-11-17):** a script named `image-studio` with the `BUCKET` binding was uploaded, but it has **no secrets and no address yet**, so it can't be reached. That upload also included some unused files from the build folder; redeploy from a folder holding only `dist/worker.js`.

## To do

3. **Finish deploying.**
   - The account has **no workers.dev subdomain yet**. Either open Workers & Pages in the dashboard once (it creates one automatically), or choose a name and create it via the API. Needs a Cloudflare API token from the user, created from the **"Edit Cloudflare Workers"** template.
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
