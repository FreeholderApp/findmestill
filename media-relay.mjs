// Copyright (C) 2026 Tony Aly
// SPDX-License-Identifier: Apache-2.0
import { createHash, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { maxWireBytes, relayOrigin, wireId } from "./public/media/pair.mjs";
import { boundedBody, json, prefix, relayHeaders, RequestError, route, token, valid } from "./media-relay-http.mjs";

const digest = input => createHash("sha256").update(input).digest("base64url");
const equal = (a, b) => typeof a === "string" && typeof b === "string"
  && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const body = (req, limit) => boundedBody(req.iterator({ destroyOnReturn: false }), limit, req.headers["content-length"]);

function replyWire(req, res, { wire, digest }) {
  const etag = `"${digest}"`;
  const match = req.headers["if-match"];
  if (match && match !== "*" && !match.split(",").some(tag => tag.trim() === etag)) throw new RequestError(412);
  const headers = { "Content-Type": "application/octet-stream", "Accept-Ranges": "bytes", ETag: etag };
  const range = req.headers.range;
  if (!range || (req.headers["if-range"] && req.headers["if-range"] !== etag)) {
    return res.writeHead(200, { ...headers, "Content-Length": wire.length }).end(wire);
  }
  const bounds = /^bytes=(\d{0,15})-(\d{0,15})$/i.exec(range);
  const start = bounds?.[1] ? Number(bounds[1]) : Math.max(0, wire.length - Number(bounds?.[2]));
  const end = bounds?.[1] && bounds[2] ? Math.min(Number(bounds[2]), wire.length - 1) : wire.length - 1;
  if (!bounds || !Number.isSafeInteger(start) || start > end) {
    res.setHeader("Content-Range", `bytes */${wire.length}`);
    throw new RequestError(416);
  }
  return res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${wire.length}`, "Content-Length": end - start + 1 }).end(wire.subarray(start, end + 1));
}

export function createMediaRelay({ database, admission, corsOrigins = [], retentionMs = 86400000, now = Date.now }) {
  if (!valid(admission, 32) || !database || !Number.isSafeInteger(retentionMs) || retentionMs < 1000) throw Error("Set a relay database and a 32-byte base64url admission key");
  const allowOrigins = new Set(corsOrigins.map(relayOrigin));
  const db = new DatabaseSync(database);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS mailbox(id TEXT PRIMARY KEY, reader TEXT NOT NULL, writer TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS message (
      mailbox TEXT NOT NULL REFERENCES mailbox(id), id TEXT NOT NULL, wire BLOB NOT NULL,
      digest TEXT NOT NULL, stored_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      PRIMARY KEY(mailbox, id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS message_expiry ON message(expires_at);
  `);
  const getMailbox = db.prepare("SELECT reader, writer FROM mailbox WHERE id=?");
  const insertMailbox = db.prepare("INSERT INTO mailbox VALUES(?,?,?)");
  const mailboxCount = db.prepare("SELECT count(*) AS n FROM mailbox");
  const purge = db.prepare("DELETE FROM message WHERE expires_at <= ?");
  const get = db.prepare("SELECT wire, digest, stored_at AS storedAt, expires_at AS expiresAt FROM message WHERE mailbox=? AND id=? AND expires_at>?");
  const list = db.prepare("SELECT id, digest, stored_at AS storedAt, expires_at AS expiresAt FROM message WHERE mailbox=? AND expires_at>? ORDER BY stored_at,id LIMIT 128");
  const add = db.prepare("INSERT INTO message VALUES(?,?,?,?,?,?)");
  const mailboxQuota = db.prepare("SELECT count(*) AS n, coalesce(sum(length(wire)),0) AS bytes FROM message WHERE mailbox=?");
  const globalQuota = db.prepare("SELECT coalesce(sum(length(wire)),0) AS bytes FROM message");
  const timer = setInterval(() => { try { purge.run(now()); } catch { /* Requests also enforce expiry. */ } }, 60000).unref();
  const admitted = digest(admission);
  let uploading = 0;

  function transaction(operation) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  async function handle(req, res) {
    relayHeaders(res);
    const origin = req.headers.origin;
    if (typeof origin === "string") {
      if (!allowOrigins.has(origin)) throw new RequestError(403);
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Expose-Headers", "ETag,Content-Range,Accept-Ranges");
      res.setHeader("Vary", "Origin");
    }
    const { mailbox, id, setup } = route(req.url);
    if (req.method === "OPTIONS") {
      return res.writeHead(204, { "Access-Control-Allow-Methods": "GET,PUT,OPTIONS", "Access-Control-Allow-Headers": "Authorization,Content-Type,Range,If-Match,If-Range" }).end();
    }
    const accessToken = token(req.headers.authorization);
    if (!valid(accessToken, 32)) throw new RequestError(401);
    const tokenHash = digest(accessToken);
    if (setup && req.method === "PUT") {
      if (!equal(admitted, tokenHash)) throw new RequestError(403);
      let keys;
      try { keys = JSON.parse((await body(req, 256)).toString("utf8")); }
      catch (e) { if (e instanceof RequestError) throw e; throw new RequestError(400); }
      if (!Array.isArray(keys) || keys.length !== 2 || keys[0] === keys[1] || keys.some(s => !valid(s, 32))) throw new RequestError(400);
      const [reader, writer] = keys.map(digest);
      transaction(() => {
        const existing = getMailbox.get(mailbox);
        if (existing) {
          if (!equal(reader, existing.reader) || !equal(writer, existing.writer)) throw new RequestError(409);
          return;
        }
        if (mailboxCount.get().n >= 256) throw new RequestError(507);
        insertMailbox.run(mailbox, reader, writer);
      });
      return res.writeHead(204).end();
    }
    if (setup) throw new RequestError(405);
    const access = getMailbox.get(mailbox);
    if (!access) throw new RequestError(404);
    if (req.method === "GET") {
      if (!equal(access.reader, tokenHash)) throw new RequestError(403);
      if (!id) return json(res, 200, { messages: list.all(mailbox, now()) });
      const record = get.get(mailbox, id, now());
      if (!record) throw new RequestError(404);
      return replyWire(req, res, record);
    }
    if (req.method !== "PUT" || !id) throw new RequestError(405);
    if (!equal(access.writer, tokenHash)) throw new RequestError(403);
    if (req.headers["content-type"] !== "application/octet-stream") throw new RequestError(415);
    if (uploading >= 6) throw new RequestError(503);
    uploading++;
    let wire;
    try { wire = await body(req, maxWireBytes); } finally { uploading--; }
    try { if (wireId(wire) !== id) throw Error(); } catch { throw new RequestError(400); }
    const stored = transaction(() => {
      const time = now();
      const hash = digest(wire);
      purge.run(time);
      const existing = get.get(mailbox, id, time);
      if (existing) {
        if (!equal(existing.digest, hash)) throw new RequestError(409);
        return { id, digest: hash, storedAt: existing.storedAt, expiresAt: existing.expiresAt };
      }
      const used = mailboxQuota.get(mailbox);
      if (used.n >= 128 || used.bytes + wire.length > 32 * 1024 * 1024 || globalQuota.get().bytes + wire.length > 256 * 1024 * 1024) throw new RequestError(507);
      const expiresAt = time + retentionMs;
      add.run(mailbox, id, wire, hash, time, expiresAt);
      return { id, digest: hash, storedAt: time, expiresAt };
    });
    return json(res, 200, stored);
  }

  return {
    handles: url => url?.startsWith(prefix),
    request: async (req, res) => {
      try { await handle(req, res); }
      catch (error) {
        if (res.headersSent || res.destroyed) return;
        if (!req.complete) res.setHeader("Connection", "close");
        json(res, error.status ?? 500, { error: error.status === 409 ? "message_or_mailbox_conflict" : "relay_request_failed" });
      }
    },
    close: () => { clearInterval(timer); db.close(); },
  };
}
