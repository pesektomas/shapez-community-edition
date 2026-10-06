// Minimal static file server for the Playwright tests (no dependencies)
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "build_output/web-dev");
const port = Number(process.argv[3] ?? 3010);

const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".mp3": "audio/mpeg",
    ".webm": "video/webm",
    ".ico": "image/x-icon",
};

createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    let file = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root)) {
        res.writeHead(403).end();
        return;
    }
    try {
        if (statSync(file).isDirectory()) {
            file = join(file, "index.html");
        }
        const size = statSync(file).size;
        res.writeHead(200, {
            "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
            "Content-Length": size,
        });
        createReadStream(file).pipe(res);
    } catch {
        res.writeHead(404).end("Not found");
    }
}).listen(port, () => console.log(`Serving ${root} on http://localhost:${port}`));
