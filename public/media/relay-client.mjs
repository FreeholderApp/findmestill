// Copyright (C) 2026 Tony Aly
// SPDX-License-Identifier: Apache-2.0
import { b64, derivePair, maxWireBytes, open, unb64 } from "./pair.mjs";

const chunkBytes = 256 * 1024;
class RelayResponseError extends Error {
  constructor(status) { super(`Relay request failed (${status})`); this.status = status; }
}
async function request(origin, mailbox, path, token, options = {}, signal) {
  const deadline = AbortSignal.timeout(15000);
  const response = await fetch(`${origin}/v1/media-relay/${mailbox}${path}`, {
    ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` },
    credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
  if (!response.ok) { await response.body?.cancel(); throw new RelayResponseError(response.status); }
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

function appendRange(wire, chunk, offset, total) {
  if (!Number.isSafeInteger(total) || total <= offset || total > maxWireBytes || (wire && wire.length !== total)
    || !(chunk instanceof Uint8Array) || chunk.length !== Math.min(chunkBytes, total - offset)) return null;
  const output = wire ?? new Uint8Array(total);
  output.set(chunk, offset);
  return output;
}

async function downloadRanges(get, header, checkpoints, progress, signal) {
  const etag = `"${header.digest}"`;
  let offset = 0;
  let wire;
  for (const saved of await checkpoints.load()) {
    if (saved.offset !== offset || !(wire = appendRange(wire, saved.chunk, offset, saved.total))) {
      await checkpoints.clear();
      offset = 0;
      wire = undefined;
      break;
    }
    offset += saved.chunk.length;
  }
  if (wire) progress?.(offset, wire.length);
  while (!wire || offset < wire.length) {
    signal?.throwIfAborted();
    const end = Math.min(offset + chunkBytes, wire?.length ?? maxWireBytes) - 1;
    const reply = await get({ Range: `bytes=${offset}-${end}`, "If-Match": etag });
    if (reply.status === 200) {
      await checkpoints.clear();
      return bytes(reply, maxWireBytes);
    }
    const match = /^bytes (\d{1,8})-(\d{1,8})\/(\d{1,8})$/.exec(reply.headers.get("Content-Range"));
    const total = Number(match?.[3]);
    if (reply.status !== 206 || reply.headers.get("ETag") !== etag || Number(match?.[1]) !== offset
      || Number(match?.[2]) !== Math.min(end, total - 1)) {
      await reply.body?.cancel();
      await checkpoints.clear();
      throw Error("Relay returned a mismatched ciphertext range");
    }
    const chunk = await bytes(reply, chunkBytes);
    wire = appendRange(wire, chunk, offset, total);
    if (!wire) {
      await checkpoints.clear();
      throw Error("Relay returned an invalid ciphertext range");
    }
    await checkpoints.save({ offset, chunk, total });
    offset += chunk.length;
    progress?.(offset, total);
  }
  return wire;
}

export async function readMedia(pair, incoming, header, { signal, checkpoints, progress } = {}) {
  checkHeader(header);
  const get = headers => request(pair.origin, incoming.mailbox, `/messages/${header.id}`, incoming.read, { headers }, signal);
  let wire;
  try {
    wire = checkpoints ? await downloadRanges(get, header, checkpoints, progress, signal) : await bytes(await get(), maxWireBytes);
  } catch (error) {
    if ([404, 410, 412, 416].includes(error.status)) await checkpoints?.clear();
    throw error;
  }
  if (await hash(wire) !== header.digest) {
    await checkpoints?.clear();
    throw Error("Relay returned unexpected ciphertext");
  }
  signal?.throwIfAborted();
  await checkpoints?.clear();
  signal?.throwIfAborted();
  const media = await open(incoming, wire, header.id);
  if (signal?.aborted) {
    media.content.fill(0);
    signal.throwIfAborted();
  }
  return media;
}
