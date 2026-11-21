// Copyright (C) 2026 Tony Aly
// SPDX-License-Identifier: Apache-2.0
import { constants } from "node:fs";
import { open as openFile, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { derivePair, invitation, readPair, relayOrigin } from "./public/media/pair.mjs";
import { inbox, readMedia } from "./public/media/relay-client.mjs";
import { normalizeAudio, transcribeOffline } from "./agent-audio.mjs";

const [action, file, id] = process.argv.slice(2);
async function provision() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 400) throw Error("Pairing code exceeds the allowed length");
    chunks.push(chunk);
  }
  const pair = readPair(Buffer.concat(chunks).toString("utf8"));
  if (pair.origin !== relayOrigin(process.env.FMS_AGENT_RELAY)) throw Error("Pairing code does not match the configured relay");
  await inbox(pair, (await derivePair(pair)).incoming);
  await writeFile(file, invitation(pair), { flag: "wx", mode: 0o600 });
  console.log("Listening agent paired");
}

async function load() {
  const handle = await openFile(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let pair;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid() || stat.size > 400) throw Error("Use an owner-only agent pairing file");
    pair = readPair(await handle.readFile("utf8"));
  } finally { await handle.close(); }
  if (pair.origin !== relayOrigin(process.env.FMS_AGENT_RELAY)) throw Error("Pairing file does not match the configured relay");
  return pair;
}

async function main() {
  if (!file || !["pair", "list", "listen", "audio", "watch"].includes(action) || (["listen", "audio"].includes(action) && !id)) {
    throw Error("Usage: FMS_AGENT_RELAY=<origin> node media-agent.mjs pair|list|listen|audio|watch <owner-only pairing file> [message ID]");
  }
  if (action === "pair") return provision();
  const pair = await load();
  const { incoming } = await derivePair(pair);
  const headers = () => inbox(pair, incoming);
  const media = header => readMedia(pair, incoming, header);
  const output = entry => console.log(JSON.stringify(entry));
  if (action === "list") return output(await headers());
  if (action === "watch") {
    const observed = new Map();
    while (true) {
      try {
        for (const header of await headers()) {
          if (observed.has(header.id)) continue;
          let clip;
          try {
            clip = await media(header);
            if (clip.mime !== "text/plain") {
              output({ id: header.id, transcript: await transcribeOffline(await normalizeAudio(clip)), engine: "offline-en-us" });
            }
          } catch { output({ id: header.id, error: "Authorized media processing failed" }); }
          observed.set(header.id, header.expiresAt);
        }
        for (const [key, expiry] of observed) if (expiry <= Date.now()) observed.delete(key);
      } catch { console.error("Agent relay is temporarily unavailable"); }
      await setTimeout(15000);
    }
  }
  const header = (await headers()).find(record => record.id === id);
  if (!header) throw Error("Message unavailable in the agent inbox");
  const clip = await media(header);
  if (clip.mime === "text/plain") throw Error("This message contains text");
  const wav = await normalizeAudio(clip);
  if (action === "audio") return process.stdout.write(wav);
  output({ id, transcript: await transcribeOffline(wav), engine: "offline-en-us" });
}

try { await main(); }
catch (error) { console.error(error.message || "Agent operation failed"); process.exitCode = 1; }
