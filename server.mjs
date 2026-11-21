// SPDX-License-Identifier: Apache-2.0
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const files = new Set([
  "/index.html", "/style.css", "/app.mjs", "/discovery.mjs", "/release.json",
  "/spec/discovery-v0.1.md", "/fixtures/discovery-v0.1.json", "/source.tar.gz", "/LICENSE",
  "/robots.txt", "/sitemap.xml", "/interop.json", "/sw.js", "/manifest.webmanifest",
  "/icons/findmestill-192.png", "/icons/findmestill-512.png",
]);
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".md": "text/plain; charset=utf-8",
  ".gz": "application/gzip",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
};

export function createSite(root, tls) {
  const handle = async (request, response) => {
    const pathname = request.url === "/" ? "/index.html" : request.url;
    const isCard = /^\/(?:cards|contact)\/[A-Za-z0-9_~.-]+\.json$/.test(pathname);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; worker-src 'self'; manifest-src 'self'; connect-src 'self' https:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "HEAD" && request.method !== "GET") {
      response.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    if (!isCard && !files.has(pathname)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(resolve(root, "." + pathname));
      if (isCard) response.setHeader("Access-Control-Allow-Origin", "*");
      response.writeHead(200, {
        "Content-Type": contentTypes[extname(pathname)] ?? contentTypes[".txt"],
        "Content-Length": body.length,
      }).end(request.method === "HEAD" ? "" : body);
    } catch (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500).end();
    }
  };
  return tls ? createHttpsServer(tls, handle) : createHttpServer(handle);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8080);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) throw new Error("Invalid port");
  createSite(process.argv[2] ?? "dist").listen(port, "127.0.0.1");
}
