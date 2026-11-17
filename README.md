# Image Studio

A private web app for generating images with open-weight models running in ComfyUI on **RunPod Serverless**. The website is hosted for free on **GitHub Pages**, and your browser talks directly to your own RunPod endpoint.

**How it fits together**

```
Your browser (GitHub Pages site)  ──►  RunPod Serverless endpoint  ──►  ComfyUI + model on a GPU
        ▲                                                                       │
        └──────────────────────── finished image (PNG) ◄────────────────────────┘
```

- **The website** holds no secrets. Your RunPod API key is entered in the app's Settings and stored only in your browser.
- **Images** are saved only in your browser (IndexedDB). They are not uploaded anywhere else. Use **Download** to keep copies.
- **You pay RunPod only while a GPU is working.** With "active workers" set to 0, an idle endpoint costs nothing.

**Models**

| Model | Best for | Speed | Available |
|---|---|---|---|
| Z-Image Turbo | Photorealism, fast iteration | 8 steps | Right away (Step 2) |
| Z-Image Base | Maximum detail, negative prompts | 25 steps | After Step 6 |
| Chroma1-HD | Any style (illustration, painting, photo); trained without content filtering | 26 steps | After Step 6 |
| Qwen Image Edit 2511 | Character / scene reference mode (uses your uploaded images directly) | 4 steps | After Step 6 |

**Reference image modes**

| Mode | What it does | Available |
|---|---|---|
| Copy pose & composition | Traces the outlines of your image (bodies, poses, props, framing) and builds a new image on them | Right away |
| Start from this image | Repaints your image; the Strength slider sets how much changes | Right away (any model) |
| Character / scene reference | Up to 3 images, e.g. your character + a pose/setting; refer to them as "image 1", "image 2" in the prompt | After Step 6 |

The app refuses prompts that reference minors. It is meant for adults and fictional adult characters only. Don't create sexual images of real, identifiable people. That is illegal in many places even when the image is fake.

---

## Step 1: Create a RunPod API key

1. Go to RunPod → **Settings → API Keys** → **Create API Key**.
2. If RunPod offers a **Restricted** permission option, choose it and give the key access to only your image endpoint (you'll create it in Step 2, so you can edit the key afterwards). Otherwise, choose read/write.
3. Copy the key (it starts with `rpa_`) and keep it somewhere private, like a password manager. **Never paste it into any file in this repository.**

## Step 2: Create the serverless endpoint (no building needed)

RunPod publishes a ready-made ComfyUI image with Z-Image Turbo already inside.

1. RunPod → **Serverless** → **New Endpoint**.
2. Choose **Import from Docker Registry** (also labeled "Custom/Docker image").
3. Container image: `runpod/worker-comfyui:5.10.0-z-image-turbo`
4. Settings:
   - **GPU:** pick 24 GB (e.g. RTX 4090 / L4 / A5000) and 48 GB as a backup choice. Selecting two or three GPU types helps you get a worker quickly.
   - **Active workers:** `0` (so you pay nothing while idle).
   - **Max workers:** `1` or `2`.
   - **Idle timeout:** about `60` seconds. Keeping a worker warm briefly makes your next image fast.
   - **Container disk:** at least `50 GB`.
   - Turn on **FlashBoot** if offered.
5. Click **Create/Deploy**. The first start downloads a ~33 GB image, which can take 10–20 minutes. Later starts are much faster.
6. Copy the **Endpoint ID** from the endpoint's page. It's the short code in the URL, like `https://api.runpod.ai/v2/abc123xyz/run`.

## Step 3: Publish the website with GitHub Pages

1. Go to this repository on GitHub → **Settings → Pages**.
2. Under **Build and deployment**, set Source to **Deploy from a branch**, Branch to **`main`**, and folder to **`/ (root)`**, then click **Save**.
3. After a minute or two, your site is live at **`https://jonathanmlanger.github.io/artgenerator/`**.

The site's code is public, but it contains no keys or images, and it tells search engines not to index it. Anyone who visits sees an empty app that can't do anything without your key.

## Step 4: Connect the app

1. Open your site and click **Settings**.
2. Paste the **Endpoint ID** and **API key** and click **Test connection**. You should see "Connected."
3. Click **Save**. Keep "Remember on this device" checked only on your own devices.

## Step 5: Generate

1. Click **Wake up GPU** when you sit down. It sends a tiny throwaway job so a worker starts while you write your prompt.
2. Keep **Z-Image Turbo** selected, write a prompt, and click **Generate** (or press Ctrl/Cmd + Enter).
3. **The very first image ever will be slow (10–20 minutes)** while RunPod downloads the worker image. After that, a start from cold takes about 30 seconds to 2 minutes, and each image takes a few seconds while the worker is warm.
4. Click an image to view it full size, **Download** it, **Reuse settings** to recreate or vary it, or **Use as reference** to build on it.

**Chat (the default view):** works like a chat with a multimodal assistant. Paste (Ctrl/Cmd + V), drop, or attach (**+**) an image, type what you want, and press **Enter** (Shift + Enter for a new line). A menu above the message box picks what to do with the image (copy pose, start from it, or character reference). Click **Edit** under any result to attach it to your next message and keep refining. The left panel still controls the model, aspect ratio, number of images and strength. **New chat** clears the conversation; images stay in the Gallery.

**Gallery tab:** shows every image, plus the classic prompt box and reference uploader.

**Reference images (Gallery tab):** choose a mode under **Reference image**, then add an image (button, drag & drop, or paste). Reference images stay saved in your browser until you remove them, so a character you've developed is there next time. They are resized to at most 1536 px before upload.

**Prompt tips:** these models understand full sentences. Describe the subject, pose, clothing, setting, lighting, camera/lens or art medium, and mood. Keep the same **seed** and change one phrase at a time to refine an image.

## Step 6 (optional upgrade): Add Z-Image Base and Chroma1-HD

The `worker/Dockerfile` in this repo starts from the image you used in Step 2 and adds Z-Image Base, Chroma1-HD and Qwen Image Edit 2511 (about 57 GB more, ~90 GB total).

1. RunPod → **Settings → Connections → GitHub** → connect your GitHub account and allow access to this repository.
2. Open your endpoint → **Manage → Edit Endpoint** (or create a new endpoint and choose **GitHub Repo**).
3. Repository: `jonathanmlanger/artgenerator`, Branch: `main`, **Dockerfile path: `worker/Dockerfile`**, Build context: `worker`.
4. Raise **Container disk** to `120 GB`. Add a **48 GB GPU** type (e.g. L40S / A6000) as your first choice: the character reference mode needs it to run well. Then deploy. RunPod builds the image itself, which can take 30–60 minutes. The **Builds** tab shows progress.
5. If you created a new endpoint, put its new Endpoint ID in the app's Settings.

RunPod may rebuild when this repository changes, depending on how the GitHub integration is set up. Check the **Builds** tab after pushing website-only changes. If unwanted rebuilds happen, move `worker/` into its own repository.

---

## Costs (rough guide)

RunPod bills per second while a worker runs, including startup and idle-timeout time. On a 24 GB GPU, a warm Z-Image Turbo image is typically a fraction of a cent. Startups and idle time are the main costs. Check prices on your endpoint's page, and set a spending limit/alert in RunPod billing.

## Troubleshooting

| What you see | What to do |
|---|---|
| "RunPod rejected the API key (401)" | Re-copy the key into Settings, and make sure it has access to this endpoint. |
| "Endpoint not found (404)" | Check the Endpoint ID (just the ID, not the full URL). |
| Waiting for a GPU worker for many minutes | The first start downloads the image. Check the endpoint's **Workers/Logs** tabs. Add more GPU types if none are available. |
| "The worker doesn't have this model installed" | You chose Z-Image Base or Chroma before finishing Step 6. |
| "The GPU ran out of memory" | Generate fewer images at once, or add a 48 GB GPU type. |
| "Request too large" when using references | Use fewer or smaller reference images. RunPod limits a job to 10 MB. |
| Pose mode copies too much detail (clothing, background) | Lower Strength to 0.5–0.7, or crop the reference to just the figures. |
| Images vanished | They're stored per browser. Clearing site data or using private browsing removes them. Download images you want to keep. |

## Files

- `index.html`, `styles.css`, `app.js` — the web app
- `workflows.js` — the ComfyUI workflows for each model (based on ComfyUI's official templates)
- `worker/Dockerfile` — the RunPod worker image for the Step 6 upgrade
