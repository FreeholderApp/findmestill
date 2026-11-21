// Copyright (C) 2026 Tony Aly
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSite } from "../server.mjs";
import { createMediaRelay } from "../media-relay.mjs";
import { createPlayerServer } from "../player-server.mjs";
import { checkMedia, maxMediaBytes, wav16, wavInfo } from "../public/media/format.mjs";
import { b64, createPair, derivePair, invitation, open, readPair, seal, unb64, wireId } from "../public/media/pair.mjs";
import { inbox, readMedia, sendWire, setupPair } from "../public/media/relay-client.mjs";

const content = wav16(new Uint8Array(3200));
const media = { mime: "audio/wav", name: "Voice note.wav", content };

test("protected media admits bounded PCM and rejects malformed WAV, SVG and mismatched types", () => {
  assert.deepEqual(wavInfo(content), { channels: 1, rate: 16000, seconds: 0.1 });
  const wrong = content.slice();
  new DataView(wrong.buffer).setUint32(40, 6000, true);
  assert.throws(() => wavInfo(wrong));
  assert.throws(() => checkMedia("image/svg+xml", content));
  assert.throws(() => checkMedia("video/mp4", content));
  assert.throws(() => checkMedia("video/webm", new Uint8Array(maxMediaBytes + 1)));
});

test("the pair authenticates each direction, message ID and encrypted metadata", async () => {
  const initiator = createPair("https://example.test");
  const recipient = readPair(invitation(initiator));
  assert.equal(recipient.role, 1);
  assert.throws(() => readPair(invitation(initiator).replace("https:", "http:")));
  const a = await derivePair(initiator);
  const b = await derivePair(recipient);
  assert.equal(a.outgoing.mailbox, b.incoming.mailbox);
  assert.notEqual(a.outgoing.mailbox, a.incoming.mailbox);
  assert.notEqual(a.outgoing.read, a.outgoing.write);
  const envelope = await seal(a.outgoing, media);
  assert.equal(wireId(envelope.wire), envelope.id);
  assert.equal(Buffer.from(envelope.wire).includes("Voice note.wav"), false);
  assert.deepEqual((await open(b.incoming, envelope.wire, envelope.id)).content, content);
  await assert.rejects(open(b.outgoing, envelope.wire, envelope.id));
  await assert.rejects(open(b.incoming, envelope.wire, b64(new Uint8Array(16))));
  const modified = envelope.wire.slice();
  modified[modified.length - 1] ^= 1;
  await assert.rejects(open(b.incoming, modified, envelope.id));
  await assert.rejects(seal(a.outgoing, { ...media, name: "../payload.wav" }));
});

test("independently issued Python HKDF and binary AES-GCM fixture opens in the client", async () => {
  const v = JSON.parse(await readFile(new URL("../public/fixtures/media-pair-v1.json", import.meta.url)));
  const { incoming } = await derivePair(readPair(v.invitation));
  assert.equal(incoming.mailbox, v.mailbox);
  assert.equal(incoming.read, v.read);
  assert.equal(incoming.write, v.write);
  const { text } = await open(incoming, new Uint8Array(Buffer.from(v.wire, "base64url")), v.id);
  assert.equal(text, v.plaintext);
});

test("encrypted wire retains a single offline message and rejects mismatched admission, capabilities and retries", async t => {
  const temp = await mkdtemp(join(tmpdir(), "fms-media-relay-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const admission = b64(crypto.getRandomValues(new Uint8Array(32)));
  let time = 1000;
  const config = { database: join(temp, "mailbox.sqlite"), admission, now: () => time, retentionMs: 2000, corsOrigins: ["https://client.example"] };
  let relay = createMediaRelay(config);
  let app = createSite("public", undefined, { relay });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => { if (app.listening) app.close(); relay.close(); });

  const origin = `http://127.0.0.1:${app.address().port}`;
  const alice = createPair(origin);
  const bob = readPair(invitation(alice));
  const a = await derivePair(alice);
  const b = await derivePair(bob);
  await assert.rejects(setupPair(alice, b64(new Uint8Array(32))), /403/);
  await setupPair(alice, admission);
  await setupPair(alice, admission);
  const envelope = await seal(a.outgoing, media);
  const stored = await sendWire(alice, a.outgoing, envelope);
  assert.deepEqual(stored, await sendWire(alice, a.outgoing, envelope));
  await assert.rejects(sendWire(alice, a.outgoing, await seal(a.outgoing, { ...media, id: envelope.id })), /409/);
  const rawUrl = `${origin}/v1/media-relay/${a.outgoing.mailbox}/messages/${envelope.id}`;
  const unauthorized = await fetch(rawUrl, { headers: { Authorization: `Bearer ${a.outgoing.write}` } });
  assert.equal(unauthorized.status, 403);
  const readerWrite = await fetch(rawUrl, {
    method: "PUT", body: envelope.wire,
    headers: { Authorization: `Bearer ${a.outgoing.read}`, "Content-Type": "application/octet-stream" },
  });
  assert.equal(readerWrite.status, 403);
  const refusedOrigin = await fetch(rawUrl, { headers: { Origin: "https://foreign.example", Authorization: `Bearer ${a.outgoing.read}` } });
  assert.equal(refusedOrigin.status, 403);
  const accepted = await fetch(rawUrl, { headers: { Origin: "https://client.example", Authorization: `Bearer ${a.outgoing.read}` } });
  assert.equal(accepted.headers.get("Access-Control-Allow-Origin"), "https://client.example");
  assert.equal(accepted.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(new Uint8Array(await accepted.arrayBuffer()), envelope.wire);
  const database = await readFile(config.database + "-wal");
  assert.equal(database.includes(unb64(alice.secret, 32)), false);
  assert.equal(database.includes("Voice note.wav"), false);

  await new Promise(resolve => app.close(resolve));
  relay.close();
  relay = createMediaRelay(config);
  app = createSite("public", undefined, { relay });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  alice.origin = bob.origin = `http://127.0.0.1:${app.address().port}`;
  await assert.rejects(inbox(bob, b.incoming, { signal: AbortSignal.abort() }), { name: "AbortError" });
  const headers = await inbox(bob, b.incoming);
  assert.deepEqual(headers, [stored]);
  assert.deepEqual((await readMedia(bob, b.incoming, headers[0])).content, content);
  const reply = await seal(b.outgoing, { mime: "text/plain", content: new TextEncoder().encode("<script>example</script>") });
  await sendWire(bob, b.outgoing, reply);
  assert.equal((await readMedia(alice, a.incoming, (await inbox(alice, a.incoming))[0])).text, "<script>example</script>");
  time = 3000;
  assert.deepEqual(await inbox(bob, b.incoming), []);
});

test("dedicated player serves only its kit, pins its parent and denies network and credentials", async t => {
  const player = createPlayerServer({ appOrigin: "https://client.example" });
  player.listen(0, "127.0.0.1");
  await once(player, "listening");
  t.after(() => player.close());
  const origin = `http://127.0.0.1:${player.address().port}`;
  const response = await fetch(origin);
  assert.equal(response.status, 200);
  const csp = response.headers.get("Content-Security-Policy");
  assert.match(csp, /frame-ancestors https:\/\/client\.example/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /media-src blob:/);
  assert.equal(response.headers.get("Set-Cookie"), null);
  assert.equal((await fetch(origin + "/v1/media-relay/private")).status, 404);
  assert.equal((await fetch(origin, { headers: { "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Site": "same-site" } })).status, 403);
  assert.equal((await fetch(origin + "/player.mjs")).headers.get("Access-Control-Allow-Origin"), "*");
});

test("gateway resumes authenticated ciphertext ranges, retains no cookies and refuses redirects", async t => {
  const admission = b64(crypto.getRandomValues(new Uint8Array(32)));
  const relay = createMediaRelay({ database: ":memory:", admission });
  const ranges = [];
  let drop = true;
  let redirect = false;
  let corrupt = false;
  let legacy = false;
  let reachedRedirect = false;
  const start = async server => {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return `http://127.0.0.1:${server.address().port}`;
  };
  const upstream = createServer((req, res) => {
    if (req.url === "/outside") { reachedRedirect = true; return res.writeHead(200).end(); }
    assert.equal(req.headers.origin, undefined);
    assert.equal(req.headers.cookie, undefined);
    res.setHeader("Set-Cookie", "discard=yes");
    if (redirect) return res.writeHead(302, { Location: "/outside" }).end();
    if (req.headers.range) {
      ranges.push(req.headers.range);
      if (drop && ranges.length === 2) return res.writeHead(503).end();
      if (corrupt) return res.writeHead(206, { ETag: '"wrong"', "Content-Range": "bytes 0-5/6" }).end("wrong!");
      if (legacy) delete req.headers.range;
    }
    return relay.request(req, res);
  });
  const upstreamOrigin = await start(upstream);
  const gateway = createSite("public", undefined, { relayUpstream: upstreamOrigin });
  t.after(() => { gateway.close(); upstream.close(); relay.close(); });
  const origin = await start(gateway);
  const a = createPair(upstreamOrigin);
  const b = readPair(invitation(a));
  const { outgoing } = await derivePair(a);
  const { incoming } = await derivePair(b);
  await setupPair({ ...a, origin }, admission);
  const long = wav16(new Uint8Array(600000));
  const item = await seal(outgoing, { ...media, content: long });
  const header = await sendWire({ ...a, origin }, outgoing, item);
  const path = `/v1/media-relay/${incoming.mailbox}/messages/${header.id}`;
  const bearer = `Bearer ${incoming.read}`;
  const first = await fetch(origin + path, { headers: { Authorization: bearer, Cookie: "app=yes", Origin: origin } });
  assert.equal(first.headers.get("Set-Cookie"), null);
  assert.equal(first.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(first.headers.get("ETag"), `"${header.digest}"`);
  assert.deepEqual(new Uint8Array(await first.arrayBuffer()), item.wire);
  assert.equal((await fetch(origin + path + "?target=/outside", { headers: { Authorization: bearer } })).status, 404);
  assert.equal((await fetch(origin + path, { headers: { Authorization: bearer, "If-Match": '"wrong"' } })).status, 412);
  drop = false;
  const badRange = await fetch(origin + path, { headers: { Authorization: bearer, Range: "bytes=999999-1000000" } });
  assert.equal(badRange.status, 416);
  assert.equal(badRange.headers.get("Content-Range"), `bytes */${item.wire.length}`);
  ranges.length = 0;
  drop = true;
  const parts = new Map();
  const checkpoints = { load: async () => [...parts.values()], save: async part => parts.set(part.offset, part), clear: async () => parts.clear() };
  await assert.rejects(readMedia({ ...b, origin }, incoming, header, { checkpoints }), /503/);
  assert.deepEqual([...parts.keys()], [0]);
  const { content: received } = await readMedia({ ...b, origin }, incoming, header, { checkpoints });
  assert.deepEqual(received, long);
  assert.deepEqual(ranges, ["bytes=0-262143", "bytes=262144-524287", "bytes=262144-524287", `bytes=524288-${item.wire.length - 1}`]);
  assert.equal(parts.size, 0);
  const damaged = item.wire.slice(0, 262144);
  damaged[damaged.length - 1] ^= 1;
  parts.set(0, { offset: 0, chunk: damaged, total: item.wire.length });
  await assert.rejects(readMedia({ ...b, origin }, incoming, header, { checkpoints }), /unexpected ciphertext/);
  assert.equal(parts.size, 0);
  legacy = true;
  parts.set(0, { offset: 0, chunk: damaged, total: item.wire.length });
  assert.deepEqual((await readMedia({ ...b, origin }, incoming, header, { checkpoints })).content, long);
  assert.equal(parts.size, 0);
  legacy = false;
  corrupt = true;
  await assert.rejects(readMedia({ ...b, origin }, incoming, header, { checkpoints }), /mismatched ciphertext range/);
  redirect = true;
  assert.equal((await fetch(origin + path, { headers: { Authorization: bearer } })).status, 502);
  assert.equal(reachedRedirect, false);
});
