// Minimal static server for the exported build in out/ (local review only).
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = join(process.cwd(), "out");
const published = JSON.parse(await readFile("firebase.json", "utf8")).hosting.headers[0].headers;
const headers = Object.fromEntries(published.map((h) => [h.key, h.value]));
const port = Number(process.env.PORT || 3200);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff", ".txt": "text/plain" };

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  // join + startsWith(root) below rejects any path that escapes out/.
  const path = normalize(decodeURIComponent(url.pathname));
  let file = join(root, path);
  if (!file.startsWith(root)) return res.writeHead(403).end();
  // Next's static export writes /page as page.html, next to a page/ data directory.
  const bare = file.replace(/[\\/]+$/, "");
  for (const candidate of [file, join(bare, "index.html"), bare + ".html"]) {
    try {
      if ((await stat(candidate)).isFile()) {
        file = candidate;
        break;
      }
    } catch {
      /* try the next candidate */
    }
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { ...headers, "Content-Type": types[extname(file)] ?? "application/octet-stream", "Cache-Control": file.endsWith("sw.js") ? "no-cache" : "public, max-age=0" });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`Serving out/ on http://127.0.0.1:${port}`));
