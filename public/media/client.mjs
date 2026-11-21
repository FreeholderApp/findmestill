// Copyright (C) 2026 Tony Aly
// SPDX-License-Identifier: Apache-2.0
import { b64, createPair, derivePair, invitation, readPair, seal } from "./pair.mjs";
import { maxMediaBytes } from "./format.mjs";
import { attachPlayer } from "./player-host.mjs";
import { inbox, readMedia, sendWire, setupPair } from "./relay-client.mjs";
import { access, enqueue } from "./storage.mjs";
import { recordVoice } from "./recorder.mjs";

const element = id => document.getElementById(id);
const status = message => { element("media-status").textContent = message; };
const known = mime => ({ wav: "audio/wav", mp4: "video/mp4", webm: "video/webm" })[mime];
const pairs = new Map();
let pair;
let opened;
let disposePlayer;
let messageAbort;
let refreshBusy = false;
let viewEpoch = 0;
let messageEpoch = 0;
let recorder;
let recording;
const config = fetch("/media/config.json", { cache: "no-store", credentials: "omit" })
  .then(response => response.ok ? response.json() : {}).catch(() => ({}));

function closed() {
  messageEpoch++;
  messageAbort?.abort();
  messageAbort = undefined;
  opened?.message.content.fill(0);
  opened = undefined;
  disposePlayer?.();
  disposePlayer = undefined;
  element("opened").hidden = true;
  element("plain-text").textContent = "";
}

async function act(button, action) {
  if (button.disabled) return;
  button.disabled = true;
  status("Working…");
  try { await action(); }
  catch (error) { if (error.name !== "AbortError") status(error.message || "Operation failed"); }
  finally { button.disabled = false; }
}

function renderPairs() {
  element("conversation").replaceChildren(...[...pairs.values()].map(record => new Option(record.label, record.id)));
  if (pair) element("conversation").value = pair.id;
  const agents = [...pairs.values()].filter(record => record.purpose === "agent" && record.id !== pair?.id);
  element("agent").replaceChildren(new Option("None", ""), ...agents.map(agent => new Option(agent.label, agent.id)));
  element("agent").value = pair?.agent ?? "";
  element("automatic").checked = Boolean(pair?.automaticFrom);
  element("delegate").hidden = !pair || pair.purpose !== "person" || agents.length === 0;
  element("desk").hidden = !pair;
}

async function select(id) {
  viewEpoch++;
  recorder?.stop();
  clearRecording();
  closed();
  pair = pairs.get(id);
  renderPairs();
  element("inbox").replaceChildren();
  if (pair) await refresh();
}

element("pair").addEventListener("submit", event => {
  event.preventDefault();
  const button = event.submitter;
  if (!button) return;
  act(button, async () => {
    let record;
    const label = element("label").value.trim();
    const purpose = element("purpose").value;
    if (!label) throw Error("Enter a conversation name");
    if (button.value === "create") {
      record = createPair(location.origin);
      const admission = element("admission").value.trim();
      element("admission").value = "";
      await setupPair(record, admission);
    } else {
      record = readPair(element("invite").value);
      await inbox(record, (await derivePair(record)).incoming);
      element("invite").value = "";
    }
    const existing = await access("pairs", store => store.get(record.id));
    if (existing && (existing.role !== record.role || existing.secret !== record.secret || existing.origin !== record.origin)) throw Error("This pairing ID is already in use locally");
    record = existing ?? { ...record, label, purpose };
    if (!existing) await access("pairs", store => store.add(record), "readwrite");
    pairs.set(record.id, record);
    if (record.role === 0) {
      element("output").value = invitation(record);
      element("new-pair").hidden = false;
    } else {
      element("setup").open = false;
    }
    await select(record.id);
  });
});
element("hide-code").onclick = () => {
  element("output").value = "";
  element("new-pair").hidden = true;
};
element("conversation").onchange = () => select(element("conversation").value).catch(error => status(error.message));

async function transmit(target, item) {
  if (item.done) return;
  await sendWire(target, (await derivePair(target)).outgoing, item);
  if (item.key.startsWith("forward/")) {
    await access("outbox", store => store.put({ key: item.key, pair: item.pair, done: true }), "readwrite");
  } else {
    await access("outbox", store => store.delete(item.key), "readwrite");
  }
}

function clearRecording() {
  recording?.fill(0);
  recording = undefined;
  element("discard").hidden = true;
  element("recording-status").textContent = "";
}

element("discard").onclick = clearRecording;
element("record").onclick = () => act(element("record"), async () => {
  if (recorder) {
    await recorder.stop();
    return;
  }
  clearRecording();
  const epoch = viewEpoch;
  const session = await recordVoice();
  if (epoch !== viewEpoch) { await session.stop(); return; }
  recorder = session;
  element("record").textContent = "Stop recording";
  element("recording-status").textContent = "Recording voice note";
  session.done.then(bytes => {
    recorder = undefined;
    element("record").textContent = "Record voice note";
    if (epoch !== viewEpoch) { bytes?.fill(0); return; }
    recording = bytes ?? undefined;
    element("discard").hidden = !recording;
    element("recording-status").textContent = recording ? "Voice note ready to send" : "No voice note was captured";
  });
});

element("compose").addEventListener("submit", event => {
  event.preventDefault();
  const target = pair;
  act(event.submitter, async () => {
    const file = element("file").files[0];
    const input = element("message").value;
    const note = recording;
    if (recorder) throw Error("Stop recording before sending");
    if (note && (file || input.trim())) throw Error("Choose the recording, an attachment, or text");
    if (!target || (!file && !note && !input.trim()) || (file && input.trim())) throw Error("Choose one text message or one attachment");
    if (file?.size > maxMediaBytes) throw Error("Attachments can be up to 8 MB");
    const mime = note ? "audio/wav" : file ? known(file.name.split(".").at(-1).toLowerCase()) : "text/plain";
    const content = note?.slice() ?? (file ? new Uint8Array(await file.arrayBuffer()) : new TextEncoder().encode(input));
    const item = await enqueue(target, await seal((await derivePair(target)).outgoing, { mime, name: note ? "Voice note.wav" : file?.name ?? "", content }));
    content.fill(0);
    if (target.id === pair?.id) { element("compose").reset(); clearRecording(); }
    try { await transmit(target, item); }
    catch { throw Error("Encrypted message queued on this device. Retry when the relay is reachable."); }
    status("Encrypted message stored by the relay");
  });
});

element("retry").onclick = () => act(element("retry"), async () => {
  const target = pair;
  const keys = await access("outbox", store => store.index("pair").getAllKeys(target.id));
  for (const key of keys) {
    const item = await access("outbox", store => store.get(key));
    if (!item || item.done) continue;
    if (item.source) {
      await agentLock(item.source, async () => {
        const scope = await access("pairs", store => store.get(item.source));
        if (scope?.agent === target.id && (!item.automaticFrom || scope.automaticFrom === item.automaticFrom)) await transmit(target, item);
        else await access("outbox", store => store.delete(item.key), "readwrite");
      });
      continue;
    }
    await transmit(target, item);
  }
  status("Pending sends checked");
});

element("save-agent").onclick = () => act(element("save-agent"), async () => {
  const selected = pair;
  const agent = element("agent").value;
  const automatic = element("automatic").checked;
  if (selected?.purpose !== "person" || (agent && pairs.get(agent)?.purpose !== "agent") || (automatic && !agent)) {
    throw Error("Select a paired listening agent before enabling automatic access");
  }
  const record = await agentLock(selected.id, async () => {
    const current = await access("pairs", store => store.get(selected.id));
    const updated = {
      ...current, agent, automaticFrom: automatic ? (current.agent === agent && current.automaticFrom || Date.now()) : null,
    };
    await access("pairs", store => store.put(updated), "readwrite");
    return updated;
  });
  pairs.set(record.id, record);
  if (pair?.id === record.id) pair = record;
  closed();
  status(agent ? "Agent access saved" : "Removed agent access for future messages");
});

function agentLock(id, callback) {
  if (!navigator.locks) throw Error("This browser cannot serialize agent permissions");
  return navigator.locks.request("findmestill-agent/" + id, callback);
}

function forwardClip(source, header, media, automaticFrom = null) {
  return agentLock(source.id, () => forwardAuthorized(source, header, media, automaticFrom));
}

async function forwardAuthorized(source, header, media, automaticFrom) {
  const current = await access("pairs", store => store.get(source.id));
  const target = pairs.get(source.agent);
  if (target?.purpose !== "agent" || !media || media.mime === "text/plain" || current?.agent !== target.id
    || (automaticFrom && current.automaticFrom !== automaticFrom)) throw Error("Agent access changed");
  const key = `forward/${target.id}/${source.id}/${header.id}`;
  let item = await access("outbox", store => store.get(key));
  if (!item) {
    const bytes = new TextEncoder().encode(`findmestill.media-forward.v1/${key}`);
    const id = b64(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).subarray(0, 16));
    const packed = await seal((await derivePair(target)).outgoing, { ...media, id });
    item = await enqueue(target, { ...packed, source: source.id, automaticFrom }, key);
  }
  await transmit(target, item);
}

function messageRow(header, incoming, selected, epoch, sequence) {
  const row = document.createElement("li");
  const button = document.createElement("button");
  button.textContent = `Open message ${sequence} · ${new Date(header.storedAt).toLocaleString()}`;
  button.onclick = () => act(button, async () => {
    closed();
    const currentMessage = messageEpoch;
    messageAbort = new AbortController();
    const message = await readMedia(selected, incoming, header, { signal: messageAbort.signal });
    if (epoch !== viewEpoch || currentMessage !== messageEpoch) { message.content.fill(0); return; }
    opened = { selected, header, message };
    element("plain-text").textContent = message.text ?? message.name;
    element("open-player").hidden = message.mime === "text/plain";
    element("forward").hidden = message.mime === "text/plain" || !selected.agent;
    element("opened").hidden = false;
    status("Message authenticated and opened");
  });
  row.append(button);
  return row;
}

async function refresh() {
  if (refreshBusy || !pair) return;
  refreshBusy = true;
  const selected = pair;
  const epoch = viewEpoch;
  try {
    const { incoming } = await derivePair(selected);
    const headers = await inbox(selected, incoming);
    if (epoch !== viewEpoch) return;
    element("inbox").replaceChildren(...headers.map((header, index) => messageRow(header, incoming, selected, epoch, index + 1)));
    if (!headers.length) status("Inbox is empty");
    if (selected.automaticFrom && selected.agent) {
      for (const header of headers) {
        if (epoch !== viewEpoch) return;
        if (header.storedAt < selected.automaticFrom) continue;
        const key = `forward/${selected.agent}/${selected.id}/${header.id}`;
        if ((await access("outbox", store => store.get(key)))?.done) continue;
        const message = await readMedia(selected, incoming, header);
        try { if (message.mime !== "text/plain") await forwardClip(selected, header, message, selected.automaticFrom); }
        finally { message.content.fill(0); }
      }
    }
  } finally {
    refreshBusy = false;
    if (epoch !== viewEpoch && pair) refresh().catch(error => status(error.message));
  }
}
element("refresh").onclick = () => act(element("refresh"), refresh);
element("close-message").onclick = closed;
element("open-player").onclick = () => act(element("open-player"), async () => {
  const chosen = opened;
  const { playerOrigin } = await config;
  if (!playerOrigin) throw Error("The protected player requires a separate configured site");
  if (!chosen || chosen !== opened) return;
  disposePlayer?.();
  disposePlayer = attachPlayer(element("player"), playerOrigin, chosen.message, status);
});
element("forward").onclick = () => act(element("forward"), async () => {
  if (!opened) return;
  const { selected, header, message } = opened;
  const copy = { ...message, content: message.content.slice() };
  try { await forwardClip(selected, header, copy); } finally { copy.content.fill(0); }
  status("Encrypted media shared with the selected agent");
});

const timer = setInterval(() => {
  if (pair && navigator.onLine && !document.hidden) refresh().catch(error => status(error.message));
}, 15000);
window.addEventListener("pagehide", () => { clearInterval(timer); recorder?.stop(); clearRecording(); closed(); }, { once: true });
for (const record of await access("pairs", store => store.getAll())) pairs.set(record.id, record);
await select(pairs.keys().next().value).catch(error => status(error.message));
