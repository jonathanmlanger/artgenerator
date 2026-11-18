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

### Start here next time: test the LoRAs (this decides whether the project continues)

1. **Token check (done 2026-11-18):** Cloudflare rejects the old token ("Invalid API Token"), so it is deleted. Its value may still sit in the cloud environment settings as `CLOUDFLARE_API_TOKEN`; remove it when convenient (harmless, it no longer works).
2. **Get a Civitai API key** (civitai.com → Account settings → API Keys). Needed for the rope/cleave gag LoRA.
3. **Done 2026-11-18 (LoRAs installed on the volume).** Pods have had no capacity (2026-11-17 and 18), but serverless has.** So install the LoRAs from the serverless worker itself, as it starts up. (RunPod's S3 upload API isn't available in US-TX-3, so that route is out.)
   - RunPod → Serverless → main endpoint (`qn0cz6iqt4tzj6`) → **Manage → Edit Endpoint**.
   - Add an environment variable `CIVITAI_TOKEN` = the Civitai key (or a RunPod Secret referenced as `{{ RUNPOD_SECRET_<name> }}`).
   - Set **Container Start Command** to (uses `wget`: the `runpod/worker-comfyui` image has no `curl`, checked 2026-11-18):
     `bash -c "wget -qO- https://raw.githubusercontent.com/jonathanmlanger/artgenerator/wip-cloudflare-server/worker/download-loras.sh | bash -s /runpod-volume; exec /start.sh"`
   - Save, then press **Wake up GPU** in the app (Z-Image Turbo selected). The new worker downloads the two LoRAs onto the volume, then starts normally. The endpoint's **Logs** show the script output ("already downloaded" / checksum errors).
   - Afterwards **clear the start command and remove `CIVITAI_TOKEN`** (otherwise every cold start re-checks the files, which is slower).
   - If the worker fails to start, clear the start command. `/start.sh` is confirmed as the image's default command (image config on Docker Hub: `Cmd ["/start.sh"]`, entrypoint `/opt/nvidia/nvidia_entrypoint.sh`).
   - **Done 2026-11-18 (Claude, via the RunPod API).** The main endpoint has its own template `0nfkdoufjg` (the edit endpoint uses `eatck9qj3p`), so only the main endpoint was touched. Its original settings were an empty start command and no environment variables. The image has no `curl` (NVIDIA's base image removes it), so `download-loras.sh` now falls back to `wget`, and the start command used `wget`, pinned to commit `2e3baa8`. A warm-up job started a fresh worker that ran the script, then a Z-Image Turbo job with each LoRA at 0.8 (`ball_gag_zit.safetensors`, `rope_cleave_gag_zib.safetensors`) completed with no `lora_name` error, so both files are on the volume. The template was then restored (empty start command, no env) and checked field by field. One stopped worker (`874t4q403v6tlo`) still showed the temporary start command and `CIVITAI_TOKEN` afterwards; RunPod had replaced the others with the restored config. If it starts again it only re-checks the files ("already downloaded"), and the token stops working once the Civitai key is deleted.
   - **Claude can do this step itself** with keys in the cloud environment settings (never pasted in chat). As of 2026-11-18 they are set as `RUNPOD_API` and `CIVITAI_API`. The Civitai key works (both LoRA downloads authorized). The RunPod key only works for running jobs (`api.runpod.ai` 200) and is refused by the management API (`api.runpod.io/graphql` 401), so it can't edit the endpoint. **Replace it with a RunPod key that has Read/Write ("All") permission**, start a new session, and ask it to "do step 3 in cloudflare/PLAN.md". Delete both keys afterwards. This container reaches `api.runpod.io` (GraphQL) and `civitai.com`; `rest.runpod.io` did not answer.
   - Fallback: a Pod in US-TX-3 (GPU, or a CPU Pod if the deploy page offers one with the volume) running the script as in the README.
   - **Hogtie added 2026-11-18** the same way (script commit `f72471a`): zkrd's "Hogtied (with and without heels)" LoRA, Turbo version as `hogtie_zit.safetensors` (Civitai version 2552105) and Base version as `hogtie_zib.safetensors` (2650092). Test jobs at 0.8 on Turbo and Base both completed and gave a convincing hogtie. Template restored and checked again. `workflows.js` now lets a LoRA name a different file per model (`files: { modelId: file }`); the hogtie entry is in the app code but **not deployed yet** (needs a Cloudflare token, see "To deploy app changes" below).
4. **Bondage by default: built and deployed 2026-11-18.** The add-ons panel now has an **Automatic** switch, on by default (`autoLoras` in `workflows.js`, saved as `_auto` in the browser's `ui_loras`). It picks add-ons from the prompt: "hogtie/hogtied/hog-tied" → hogtie, "ballgag/ball gag/ball-gagged" → ball gag, "cleave gag/shibari" → rope + cleave gag. General words ("rope", "tied", "bound", "bondage", "restrained") add the rope + cleave gag LoRA only when no pose LoRA (hogtie) was picked. If nothing matches, rope + cleave gag is used, so every image leans towards bondage. Strength is 0.8 for one add-on, 0.65 each for two, 0.55 for three or more. A live line under the switch shows what will be used. Turning Automatic off brings back the checkboxes. Images reopened from the gallery restore the mode they were made with. Tested in a browser (Playwright) and with real jobs ("hogtied … ballgag" gives a hogtie with a normal-sized ball gag).
   - **Deployed (2026-11-18)** together with the hogtie LoRA: built with `node cloudflare/build.mjs` (130 KB) and deployed with `npx wrangler deploy -c cloudflare/wrangler.toml` (wrangler 4.164.0, version `fe1eb90f-b7a9-4b58-aa2c-7511392ea978`). Existing secrets `PASSWORD_HASH` and `SESSION_SECRET` were kept. Checked live: login page loads, `/api/config` refuses without sign-in (401), wrong password refused (401), served `app.js` and `workflows.js` contain `autoLoras` and `hogtie_zit.safetensors` and are byte-identical to the source.
   - **Build fix in the same deploy:** `build.mjs` inserted the app files with a string replacement, so `$&` and `$$` in the code were rewritten (the live `escapeRe` turned into `"\\/* ASSETS_PLACEHOLDER */"`, and the storage-cost warning lost its `$`). It now uses a function replacement. A first deploy of the unfixed build (version `4e3e30a4-a200-4212-a9be-c05ad8199db0`) was live for a few minutes before being replaced.
   - Other LoRAs found on Civitai (Z-Image, not nudity-focused), for later: zkrd's Rope bound (ZIT 2552801 / ZIB 2692406), Tape bound (ZIT 2483725), Over-the-mouth cloth gag (ZIT 2549960 / ZIB 2659817), Knotted cleave gag (ZIB 2666104); Joschek's Chairtied (ZIT 2540815), Takate Kote (ZIT 2530839), Ballgags (ZIT 2537559, smaller and more natural than the current "Large Ball Gag"); Harness panel gag (ZIT 2525128). All need a Civitai key.
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
