// Copyright (C) 2026 Tony Aly
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSite } from "../server.mjs";
import { createMediaRelay } from "../media-relay.mjs";
import { createPlayerServer } from "../player-server.mjs";
import { b64, derivePair, readPair } from "../public/media/pair.mjs";
import { inbox } from "../public/media/relay-client.mjs";
import { wav16 } from "../public/media/format.mjs";

const { chromium } = await import(process.env.FMS_PLAYWRIGHT_MODULE ?? "playwright");
const directory = await mkdtemp(join(tmpdir(), "fms-media-browser-"));
const ffmpeg = args => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args]);
const speech = ffmpeg(["-f", "lavfi", "-i", "flite=text=please call me in the morning:voice=slt",
  "-ar", "16000", "-ac", "1", "-f", "s16le", "pipe:1"]);
const speechFile = join(directory, "voice.wav");
await writeFile(speechFile, wav16(speech));
const videoFile = join(directory, "video.mp4");
ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=160x120:r=8:d=2", "-i", speechFile, "-c:v", "libx264",
  "-pix_fmt", "yuv420p", "-c:a", "aac", "-t", "2", videoFile]);

const reserve = createServer().listen(0, "127.0.0.1");
await once(reserve, "listening");
const appPort = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const appOrigin = `http://localhost:${appPort}`;
const player = createPlayerServer({ appOrigin }).listen(0, "127.0.0.1");
await once(player, "listening");
const playerOrigin = `http://127.0.0.1:${player.address().port}`;
const admission = b64(crypto.getRandomValues(new Uint8Array(32)));
const relay = createMediaRelay({ database: join(directory, "relay.sqlite"), admission, corsOrigins: [appOrigin] });
const app = createSite("dist", undefined, { relay, playerOrigin }).listen(appPort, "127.0.0.1");
await once(app, "listening");

let browser;
const status = page => page.locator("#media-status");
async function pair(page, name, purpose = "person") {
  if (!(await page.locator("#setup").evaluate(node => node.open))) await page.locator("#setup summary").click();
  await page.locator("#label").fill(name);
  await page.locator("#purpose").selectOption(purpose);
  await page.locator("#admission").fill(admission);
  await page.getByRole("button", { name: "Create pair" }).click();
  await page.locator("#new-pair").waitFor();
  const code = await page.locator("#output").inputValue();
  await page.getByRole("button", { name: "Hide code" }).click();
  return code;
}
async function send(page, file) {
  await page.locator("#file").setInputFiles(file);
  await page.getByRole("button", { name: "Send encrypted" }).click();
  await status(page).filter({ hasText: "stored by the relay" }).waitFor();
}
const messages = page => page.locator("#inbox button");
async function waitCount(page, count) {
  await page.waitForFunction(count => document.querySelectorAll("#inbox button").length === count, count);
}

try {
  browser = await chromium.launch({
    channel: "chrome", headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  const first = await browser.newContext();
  const alice = await first.newPage();
  alice.setDefaultTimeout(12000);
  const second = await browser.newContext();
  const bob = await second.newPage();
  bob.setDefaultTimeout(12000);
  const errors = [];
  alice.on("pageerror", e => errors.push(e.message));
  bob.on("pageerror", e => errors.push(e.message));
  await alice.goto(appOrigin + "/media/");
  const invite = await pair(alice, "Bob");
  await send(alice, speechFile);
  await send(alice, videoFile);
  await alice.locator("#message").fill("<img src='https://invalid.example/steal' onerror='alert(1)'>");
  await alice.getByRole("button", { name: "Send encrypted" }).click();
  await status(alice).filter({ hasText: "stored by the relay" }).waitFor();

  const playerRequests = [];
  second.on("request", req => { if (req.url().startsWith(playerOrigin)) playerRequests.push(req.url()); });
  await bob.goto(appOrigin + "/media/");
  await bob.locator("#label").fill("Alice");
  await bob.locator("#invite").fill(invite);
  await bob.getByRole("button", { name: "Join pair" }).click();
  await waitCount(bob, 3);
  assert.equal(playerRequests.length, 0);
  await messages(bob).nth(0).click();
  await bob.getByText("voice.wav", { exact: true }).waitFor();
  assert.equal(playerRequests.length, 0);

  async function play(kind) {
    await bob.getByRole("button", { name: "Open protected player" }).click();
    const frame = bob.frameLocator("iframe");
    const media = frame.locator(kind);
    await frame.getByRole("button", { name: "Play", exact: true }).waitFor();
    assert.equal(await bob.locator("iframe").getAttribute("sandbox"), "allow-scripts");
    assert.equal(await media.evaluate(node => node.paused), true);
    assert.equal(await media.evaluate(() => self.origin), "null");
    assert.equal(await media.evaluate(async () => {
      try { await fetch("https://invalid.example/probe"); return true; } catch { return false; }
    }), false);
    await frame.getByRole("button", { name: "Play", exact: true }).click();
    await frame.locator("#status").filter({ hasText: "Playing" }).waitFor();
    await bob.getByRole("button", { name: "Close message" }).click();
    assert.equal(await bob.locator("iframe").count(), 0);
  }
  await play("audio");
  await messages(bob).nth(1).click();
  await bob.getByText("video.mp4", { exact: true }).waitFor();
  await play("video");
  await messages(bob).nth(2).click();
  const message = bob.locator("#plain-text");
  await message.filter({ hasText: "<img" }).waitFor();
  assert.match(await message.textContent(), /^<img/);
  assert.equal(await message.locator("img").count(), 0);
  await bob.getByRole("button", { name: "Close message" }).click();
  console.log("Two independent browser profiles exchanged encrypted binary while the recipient was absent. Actual protected audio and video playback passed.");

  const agentInvite = await pair(bob, "Local agent", "agent");
  const ownerFile = join(directory, "agent.pair");
  const agentPair = readPair(agentInvite);
  const { incoming } = await derivePair(agentPair);
  // Using asynchronous spawn avoids blocking the loopback servers.
  const { promisify } = await import("node:util");
  const { execFile } = await import("node:child_process");
  const runAgent = promisify(execFile);
  const provision = runAgent(process.execPath, ["media-agent.mjs", "pair", ownerFile], {
    env: { ...process.env, FMS_AGENT_RELAY: appOrigin },
  });
  provision.child.stdin.end(agentInvite);
  await provision;
  const aliceId = await bob.getByRole("option", { name: "Alice", exact: true }).getAttribute("value");
  const agentId = await bob.locator("#conversation option").filter({ hasText: "Local agent" }).getAttribute("value");
  await bob.locator("#conversation").selectOption(aliceId);
  await waitCount(bob, 3);
  assert.equal(await bob.locator("#automatic").isChecked(), false);
  await bob.locator("#agent").selectOption(agentId);
  await bob.getByRole("button", { name: "Save agent access" }).click();
  await status(bob).filter({ hasText: "Agent access saved" }).waitFor();
  assert.deepEqual(await inbox(agentPair, incoming), []);
  await bob.getByRole("button", { name: "Check inbox" }).click();
  await messages(bob).nth(0).click();
  await bob.getByRole("button", { name: "Share with selected agent" }).click();
  await status(bob).filter({ hasText: "shared with the selected agent" }).waitFor();
  const [shared] = await inbox(agentPair, incoming);
  assert.ok(shared);
  const { stdout } = await runAgent(process.execPath, ["media-agent.mjs", "listen", ownerFile, shared.id], {
    env: { ...process.env, FMS_AGENT_RELAY: appOrigin },
  });
  assert.match(JSON.parse(stdout).transcript, /call|morning/i);
  await messages(bob).nth(1).click();
  await bob.getByText("video.mp4", { exact: true }).waitFor();
  await bob.getByRole("button", { name: "Share with selected agent" }).click();
  await status(bob).filter({ hasText: "shared with the selected agent" }).waitFor();
  const sharedVideo = (await inbox(agentPair, incoming)).find(item => item.id !== shared.id);
  assert.ok(sharedVideo);
  const videoSpeech = await runAgent(process.execPath, ["media-agent.mjs", "listen", ownerFile, sharedVideo.id], {
    env: { ...process.env, FMS_AGENT_RELAY: appOrigin },
  });
  assert.match(JSON.parse(videoSpeech.stdout).transcript, /call|morning/i);


  await bob.locator("#automatic").check();
  await bob.getByRole("button", { name: "Save agent access" }).click();
  await status(bob).filter({ hasText: "Agent access saved" }).waitFor();
  await send(alice, speechFile);
  await bob.getByRole("button", { name: "Check inbox" }).click();
  await waitCount(bob, 4);
  await bob.waitForFunction(() => !document.querySelector("#refresh").disabled);
  assert.equal((await inbox(agentPair, incoming)).length, 3);
  await bob.getByRole("button", { name: "Check inbox" }).click();
  await bob.waitForFunction(() => !document.querySelector("#refresh").disabled);
  assert.equal((await inbox(agentPair, incoming)).length, 3);

  const deferred = `**/v1/media-relay/${incoming.mailbox}/messages/*`;
  await second.route(deferred, route => route.request().method() === "PUT" ? route.fulfill({ status: 503 }) : route.continue());
  await send(alice, speechFile);
  await bob.getByRole("button", { name: "Check inbox" }).click();
  await waitCount(bob, 5);
  await status(bob).filter({ hasText: "Relay request failed (503)" }).waitFor();
  await second.unroute(deferred);
  await bob.locator("#automatic").uncheck();
  await bob.locator("#agent").selectOption("");
  await bob.getByRole("button", { name: "Save agent access" }).click();
  await status(bob).filter({ hasText: "Removed agent access" }).waitFor();
  await bob.locator("#conversation").selectOption(agentId);
  await bob.getByRole("button", { name: "Retry pending sends" }).click();
  await status(bob).filter({ hasText: "Pending sends checked" }).waitFor();
  assert.equal((await inbox(agentPair, incoming)).length, 3);
  await bob.locator("#conversation").selectOption(aliceId);
  await waitCount(bob, 5);
  await first.grantPermissions(["microphone"], { origin: appOrigin });
  await alice.getByRole("button", { name: "Record voice note" }).click();
  await alice.getByRole("button", { name: "Stop recording" }).waitFor();
  await new Promise(resolve => setTimeout(resolve, 400));
  await alice.getByRole("button", { name: "Stop recording" }).click();
  await alice.getByText("Voice note ready to send").waitFor();
  await alice.getByRole("button", { name: "Send encrypted" }).click();
  await status(alice).filter({ hasText: "stored by the relay" }).waitFor();
  await bob.getByRole("button", { name: "Check inbox" }).click();
  await waitCount(bob, 6);
  assert.equal((await inbox(agentPair, incoming)).length, 3);
  assert.deepEqual(errors, []);
  console.log("Agent transcribed a voice note and a video audio track offline. Explicit and automatic grants passed, including deduplication and revoke. Browser voice recording passed.");
} finally {
  await browser?.close();
  app.closeAllConnections();
  player.closeAllConnections();
  await Promise.all([new Promise(resolve => app.close(resolve)), new Promise(resolve => player.close(resolve))]);
  relay.close();
  await rm(directory, { recursive: true, force: true });
}
