// Copyright (C) 2026 Tony Aly
// SPDX-License-Identifier: Apache-2.0
import { b64, derivePair, maxWireBytes, open, unb64 } from "./pair.mjs";

async function request(origin, mailbox, path, token, options = {}, signal) {
  const deadline = AbortSignal.timeout(15000);
  const response = await fetch(`${origin}/v1/media-relay/${mailbox}${path}`, {
    ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` },
    credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
  if (!response.ok) { await response.body?.cancel(); throw Error(`Relay request failed (${response.status})`); }
  return response;
}
async function bytes(response, bound) {
  const reader = response.body?.getReader();
  if (!reader) throw Error("Missing relay response");
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > bound) throw Error("Relay response exceeds allowed size");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const value of chunks) { output.set(value, offset); offset += value.length; }
  return output;
}
const json = async (response, max) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await bytes(response, max)));
const hash = async buf => b64(new Uint8Array(await crypto.subtle.digest("SHA-256", buf)));
function checkHeader(record) {
  if (!record || !Number.isSafeInteger(record.storedAt) || !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= record.storedAt) throw Error("Invalid relay receipt");
  unb64(record.id, 16); unb64(record.digest, 32);
  return record;
}

export async function setupPair(pair, admission, { signal } = {}) {
  unb64(admission, 32);
  const { incoming, outgoing } = await derivePair(pair);
  for (const lane of [incoming, outgoing]) {
    await request(pair.origin, lane.mailbox, "", admission, { method: "PUT", body: JSON.stringify([lane.read, lane.write]), headers: { "Content-Type": "application/json" } }, signal);
  }
}
export async function sendWire(pair, outgoing, { id, wire }, { signal } = {}) {
  const response = await request(pair.origin, outgoing.mailbox, `/messages/${id}`, outgoing.write, {
    method: "PUT", body: wire, headers: { "Content-Type": "application/octet-stream" },
  }, signal);
  const receipt = checkHeader(await json(response, 1024));
  if (receipt.id !== id || receipt.digest !== await hash(wire)) throw Error("Relay receipt does not match the sent ciphertext");
  return receipt;
}
export async function inbox(pair, incoming, { signal } = {}) {
  const response = await request(pair.origin, incoming.mailbox, "/messages", incoming.read, {}, signal);
  const { messages } = await json(response, 32768);
  if (!Array.isArray(messages) || messages.length > 128) throw Error("Invalid mailbox listing");
  return messages.map(checkHeader);
}
export async function readMedia(pair, incoming, header, { signal } = {}) {
  checkHeader(header);
  const response = await request(pair.origin, incoming.mailbox, `/messages/${header.id}`, incoming.read, {}, signal);
  const wire = await bytes(response, maxWireBytes);
  if (await hash(wire) !== header.digest) throw Error("Relay returned unexpected ciphertext");
  signal?.throwIfAborted();
  const media = await open(incoming, wire, header.id);
  if (signal?.aborted) {
    media.content.fill(0);
    signal.throwIfAborted();
  }
  return media;
}
