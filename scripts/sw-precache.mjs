// After `next build`, writes the app-shell file list and a content-hash version into out/sw.js,
// so the app opens offline from the very first visit and every new build replaces the old cache.
// Usage: node scripts/sw-precache.mjs [outDir]
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Files the offline shell needs: the start page, scripts, styles, woff2 fonts, manifest and icons. */
const wanted = (rel) =>
  rel === "index.html" ||
  rel === "manifest.webmanifest" ||
  /^icon[\w-]*\.(svg|png)$/.test(rel) ||
  (rel.startsWith("_next/static/") && !rel.endsWith(".woff") && !rel.endsWith(".map"));

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

export function precacheList(outDir) {
  const hash = createHash("sha256");
  const urls = [];
  for (const file of walk(outDir).sort()) {
    const rel = relative(outDir, file).split(sep).join("/");
    if (!wanted(rel)) continue;
    urls.push(rel === "index.html" ? "/" : "/" + rel);
    hash.update(rel).update(readFileSync(file));
  }
  return { urls, version: "nsalek-" + hash.digest("hex").slice(0, 12) };
}

export function renderServiceWorker(template, outDir) {
  const { urls, version } = precacheList(outDir);
  const out = template.replace(/const VERSION = "[^"]*";/, `const VERSION = "${version}";`).replace(/const PRECACHE = \[[^\]]*\];/, `const PRECACHE = ${JSON.stringify(urls)};`);
  if (out === template) throw new Error("sw.js template is missing the VERSION/PRECACHE lines");
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = resolve(process.argv[2] ?? "out");
  const swPath = join(outDir, "sw.js");
  const sw = renderServiceWorker(readFileSync(swPath, "utf8"), outDir);
  writeFileSync(swPath, sw);
  console.log(`sw.js: ${precacheList(outDir).urls.length} files pre-cached, ${sw.match(/VERSION = "([^"]+)"/)[1]}`);
}
