// Copyright (C) 2026 Tony Aly
// SPDX-License-Identifier: Apache-2.0
import { maxWireBytes, relayOrigin, unb64 } from "./public/media/pair.mjs";

export const prefix = "/v1/media-relay/";
const pathRule = /^\/v1\/media-relay\/([A-Za-z0-9_-]{22})(?:(\/messages)(?:\/([A-Za-z0-9_-]{22}))?)?$/;
export const valid = (value, length) => { try { return !!unb64(value, length); } catch { return false; } };
export const token = header => /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header ?? "")?.[1];
export function route(path) {
  const match = pathRule.exec(path);
  if (!match || !valid(match[1], 16) || (match[3] && !valid(match[3], 16))) throw new RequestError(404);
  return { mailbox: match[1], setup: !match[2], id: match[3] };
}
export const json = (res, status, value) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
export class RequestError extends Error {
  constructor(status) { super(); this.status = status; }
}
export async function boundedBody(chunks, limit, contentLength, status = 413) {
  if (Number(contentLength) > limit) {
    await chunks.cancel?.();
    throw new RequestError(status);
  }
  const parts = [];
  let length = 0;
  for await (const chunk of chunks) {
    length += chunk.length;
    if (length > limit) throw new RequestError(status);
    parts.push(chunk);
  }
  return Buffer.concat(parts, length);
}
export function relayHeaders(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

const responseHeaders = ["Content-Type", "ETag", "Accept-Ranges", "Content-Range"];

export function createMediaGateway(upstream) {
  const origin = relayOrigin(upstream);
  let active = 0;
  return {
    handles: path => path?.startsWith(prefix),
    async request(req, res) {
      relayHeaders(res);
      let acquired = false;
      const disconnected = new AbortController();
      const abort = () => disconnected.abort();
      res.once("close", abort);
      try {
        const { setup, id } = route(req.url);
        const upload = req.method === "PUT" && (setup || id);
        if (!upload && (req.method !== "GET" || setup)) throw new RequestError(405);
        if (!valid(token(req.headers.authorization), 32)) throw new RequestError(401);
        if (active >= 12) throw new RequestError(503);
        active++;
        acquired = true;
        const headers = { Authorization: req.headers.authorization, "Accept-Encoding": "identity" };
        let body;
        if (upload) {
          const type = setup ? "application/json" : "application/octet-stream";
          if (req.headers["content-type"] !== type) throw new RequestError(415);
          headers["Content-Type"] = type;
          body = await boundedBody(req.iterator({ destroyOnReturn: false }), setup ? 256 : maxWireBytes, req.headers["content-length"]);
        } else {
          for (const name of ["range", "if-match", "if-range"]) if (typeof req.headers[name] === "string") headers[name] = req.headers[name];
        }
        const reply = await fetch(origin + req.url, {
          method: req.method, headers, body, redirect: "error", credentials: "omit",
          signal: AbortSignal.any([AbortSignal.timeout(12000), disconnected.signal]),
        });
        if (reply.headers.has("content-encoding")) { await reply.body?.cancel(); throw new RequestError(502); }
        const size = req.method === "GET" && id && reply.ok ? maxWireBytes : 32768;
        const data = reply.body ? await boundedBody(reply.body, size, reply.headers.get("content-length"), 502) : Buffer.alloc(0);
        const selected = {};
        for (const name of responseHeaders) if (reply.headers.has(name)) selected[name] = reply.headers.get(name);
        if (reply.status !== 204 && reply.status !== 304) selected["Content-Length"] = data.length;
        res.writeHead(reply.status, selected).end(data);
      } catch (error) {
        if (res.headersSent || res.destroyed) return;
        if (!req.complete) res.setHeader("Connection", "close");
        json(res, error.status ?? 502, { error: "relay_gateway_failed" });
      } finally {
        res.off("close", abort);
        if (acquired) active--;
      }
    },
  };
}
