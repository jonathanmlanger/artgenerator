// Bundles the app files into one Worker script: cloudflare/dist/worker.js
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const files = {
  "index.html": join(root, "index.html"),
  "app.js": join(root, "app.js"),
  "workflows.js": join(root, "workflows.js"),
  "cloud.js": join(root, "cloud.js"),
  "styles.css": join(root, "styles.css"),
  "login.html": join(here, "login.html"),
};
const assets = Object.fromEntries(Object.entries(files).map(([k, p]) => [k, readFileSync(p, "utf8")]));
const src = readFileSync(join(here, "worker.js"), "utf8")
  // A function replacement, so "$&" / "$$" in the app code are kept as written.
  .replace("/* ASSETS_PLACEHOLDER */", () => `const ASSETS = ${JSON.stringify(assets)};`);
mkdirSync(join(here, "dist"), { recursive: true });
writeFileSync(join(here, "dist", "worker.js"), src);
console.log(`Built cloudflare/dist/worker.js (${(src.length / 1024).toFixed(0)} KB)`);
