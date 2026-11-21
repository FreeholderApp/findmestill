// Copyright (C) 2026 Tony Aly
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { createMediaRelay } from "../media-relay.mjs";
import { createPlayerServer } from "../player-server.mjs";
import { createSite } from "../server.mjs";
import { b64 } from "../public/media/pair.mjs";
import { wav16 } from "../public/media/format.mjs";

const { chromium } = await import(process.env.FMS_PLAYWRIGHT_MODULE ?? "playwright");
const servers = [];
async function start(server, port = 0) {
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  return server.address().port;
}

const admission = b64(crypto.getRandomValues(new Uint8Array(32)));
const relay = createMediaRelay({ database: ":memory:", admission });
let browser;
try {
  const relayUpstream = `http://127.0.0.1:${await start(createSite("dist", undefined, { relay }))}`;
  const lease = createServer().listen(0, "127.0.0.1");
  await once(lease, "listening");
  const bobPort = lease.address().port;
  await new Promise(resolve => lease.close(resolve));
  const bobOrigin = `http://localhost:${bobPort}`;
  const playerOrigin = `http://127.0.0.1:${await start(createPlayerServer({ appOrigin: bobOrigin }))}`;
  await start(createSite("dist", undefined, { relayUpstream, playerOrigin }), bobPort);
  const aliceOrigin = `http://localhost:${await start(createSite("dist", undefined, { relayUpstream }))}`;
  browser = await chromium.launch({ channel: "chrome" });
  const alice = await browser.newPage();
  const bob = await browser.newPage();
  const unexpected = [];
  for (const [page, origin] of [[alice, aliceOrigin], [bob, bobOrigin]]) {
    page.on("request", req => { if (req.url().includes("/v1/media-relay/") && new URL(req.url()).origin !== origin) unexpected.push(req.url()); });
    page.on("pageerror", error => unexpected.push(error.message));
    page.setDefaultTimeout(10000);
  }
  const status = text => bob.locator("#media-status").filter({ hasText: text }).waitFor();
  await alice.goto(aliceOrigin + "/media/");
  await alice.locator("#label").fill("Bob");
  await alice.locator("#admission").fill(admission);
  await alice.getByRole("button", { name: "Create pair" }).click();
  await alice.locator("#new-pair").waitFor();
  const code = await alice.locator("#output").inputValue();
  assert.equal(code.split(" ")[1], relayUpstream);
  await alice.locator("#file").setInputFiles({ name: "long.wav", mimeType: "audio/wav", buffer: Buffer.from(wav16(new Uint8Array(900000))) });
  await alice.getByRole("button", { name: "Send encrypted" }).click();
  await alice.locator("#media-status").filter({ hasText: "stored by the relay" }).waitFor();
  await bob.goto(bobOrigin + "/media/");
  await bob.locator("#label").fill("Alice");
  await bob.locator("#invite").fill(code);
  await bob.getByRole("button", { name: "Join pair" }).click();
  const open = () => bob.getByRole("button", { name: /Open message 1/ }).click();
  const ranges = [];
  const interrupted = new Set([262144, 524288]);
  await bob.route("**/v1/media-relay/*/messages/*", async route => {
    const range = route.request().headers().range;
    const offset = Number(/^bytes=(\d+)-/.exec(range)?.[1]);
    ranges.push(offset);
    if (interrupted.delete(offset)) return route.abort("connectionreset");
    return route.continue();
  });
  for (let i = 0; i < 2; i++) {
    await open();
    await status("Connection interrupted");
    assert.equal(await bob.locator("#opened").isVisible(), false);
    assert.equal(await bob.locator("#player iframe").count(), 0);
    await bob.reload();
  }
  await open();
  await status("Message authenticated and opened");
  assert.deepEqual(ranges, [0, 262144, 262144, 524288, 524288, 786432]);
  assert.deepEqual(unexpected, []);
  await bob.getByRole("button", { name: "Open protected player" }).click();
  const frame = bob.frameLocator("#player iframe");
  await frame.getByRole("button", { name: /play/i }).click();
  await frame.locator("audio").evaluate(audio => new Promise((resolve, reject) => {
    if (!audio.paused) return resolve();
    audio.addEventListener("playing", resolve, { once: true });
    audio.addEventListener("error", reject, { once: true });
  }));
  console.log("Two browser origins used their own gateways with upstream CORS disabled. Two interrupted connections and reloads resumed at 262144 and 524288 ciphertext bytes. Playback succeeded only after full authentication.");
} finally {
  await browser?.close();
  await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); })));
  relay.close();
}
