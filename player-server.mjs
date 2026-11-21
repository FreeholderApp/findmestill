// Copyright (C) 2026 Tony Aly
// SPDX-License-Identifier: Apache-2.0
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { relayOrigin } from "./public/media/pair.mjs";

export function createPlayerServer({ appOrigin, root = "." }) {
  const allowed = relayOrigin(appOrigin);
  const files = new Map([
    ["/", ["player/index.html", "text/html; charset=utf-8"]],
    ["/player.css", ["player/player.css", "text/css; charset=utf-8"]],
    ["/player.mjs", ["player/player.mjs", "text/javascript; charset=utf-8"]],
    ["/media/format.mjs", ["public/media/format.mjs", "text/javascript; charset=utf-8"]],
  ]);
  return createServer(async (req, res) => {
    res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'self'; style-src 'self'; media-src blob:; connect-src 'none'; frame-ancestors ${allowed}; base-uri 'none'; form-action 'none'`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    if (req.method !== "GET") return res.writeHead(405).end();
    if (req.headers["sec-fetch-dest"] === "iframe" && ["same-origin", "same-site"].includes(req.headers["sec-fetch-site"])) {
      return res.writeHead(403).end();
    }
    if (req.url === "/player-config.mjs") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" })
        .end(`export const appOrigin = ${JSON.stringify(allowed)};\n`);
    }
    const file = files.get(req.url);
    if (!file) return res.writeHead(404).end();
    try {
      const bytes = await readFile(resolve(root, file[0]));
      if (file[1].startsWith("text/javascript")) res.setHeader("Access-Control-Allow-Origin", "*");
      res.writeHead(200, { "Content-Type": file[1] }).end(bytes);
    } catch {
      res.writeHead(500).end();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createPlayerServer({ appOrigin: process.env.FMS_APP_ORIGIN }).listen(Number(process.env.PORT ?? 8081), "127.0.0.1");
}
