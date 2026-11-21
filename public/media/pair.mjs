// Copyright (C) 2026 Tony Aly
// SPDX-License-Identifier: Apache-2.0
import { checkMedia, maxMediaBytes, supported } from "./format.mjs";

export const maxWireBytes = maxMediaBytes + 1024;
export const wirePrefixBytes = 29;
const label = "findmestill.media-pair.v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export function b64(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function unb64(value, length) {
  if (typeof value !== "string" || value.length !== Math.ceil(length * 4 / 3) || /[^A-Za-z0-9_-]/.test(value)) throw Error("Invalid binary identifier");
  const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
  if (bytes.length !== length || b64(bytes) !== value) throw Error("Noncanonical binary identifier");
  return bytes;
}

export function relayOrigin(input) {
  const u = new URL(input);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if ((u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) || u.username || u.password
      || u.pathname !== "/" || u.search || u.hash || u.origin === "null") throw Error("Use an HTTPS relay origin");
  return u.origin;
}

export function createPair(origin) {
  return {
    origin: relayOrigin(origin), id: b64(crypto.getRandomValues(new Uint8Array(16))),
    secret: b64(crypto.getRandomValues(new Uint8Array(32))), role: 0,
  };
}
export function invitation(pair) {
  return `${label} ${pair.origin} ${pair.id} ${pair.secret}`;
}
export function readPair(value, role = 1) {
  if (typeof value !== "string" || value.length > 360 || ![0, 1].includes(role)) throw Error("Invalid pairing code");
  const [profile, origin, id, secret, rest] = value.trim().split(" ");
  if (profile !== label || rest !== undefined || relayOrigin(origin) !== origin) throw Error("Invalid pairing code");
  unb64(id, 16); unb64(secret, 32);
  return { origin, id, secret, role };
}
export async function derivePair(pair) {
  const secret = await crypto.subtle.importKey("raw", unb64(pair.secret, 32), "HKDF", false, ["deriveBits", "deriveKey"]);
  const lanes = await Promise.all([0, 1].map(async direction => {
    const salt = unb64(pair.id, 16);
    const forUse = use => ({ name: "HKDF", hash: "SHA-256", salt, info: encoder.encode(`${label}/${direction}/${use}`) });
    const bits = async (use, bytes) => b64(new Uint8Array(await crypto.subtle.deriveBits(forUse(use), secret, bytes * 8)));
    const [mailbox, read, write, key] = await Promise.all([
      bits("mailbox", 16), bits("read", 32), bits("write", 32),
      crypto.subtle.deriveKey(forUse("encryption"), secret, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
    ]);
    return { mailbox, read, write, key };
  }));
  return { outgoing: lanes[pair.role], incoming: lanes[1 - pair.role] };
}

function validate(mime, name, content) {
  if (typeof name !== "string" || name.length > 120 || /[\u0000-\u001f\u007f/\\\u202a-\u202e\u2066-\u2069]/u.test(name)) throw Error("Invalid attachment name");
  if (mime === "text/plain") {
    if (content.length < 1 || content.length > 16384 || name) throw Error("Text is outside the supported size");
    decoder.decode(content);
    return;
  }
  if (!name || !supported.includes(mime)) throw Error("Unsupported media type");
  checkMedia(mime, content);
}

function aad(lane, prefix) {
  const bytes = new Uint8Array(16 + prefix.length);
  bytes.set(unb64(lane.mailbox, 16));
  bytes.set(prefix, 16);
  return bytes;
}

export async function seal(lane, { mime, name = "", content, id = b64(crypto.getRandomValues(new Uint8Array(16))) }) {
  validate(mime, name, content);
  const header = encoder.encode(JSON.stringify([mime, name]));
  if (header.length > 768) throw Error("Attachment header too large");
  const data = new Uint8Array(2 + header.length + content.length);
  new DataView(data.buffer).setUint16(0, header.length);
  data.set(header, 2); data.set(content, 2 + header.length);
  const wire = new Uint8Array(wirePrefixBytes + data.length + 16);
  wire[0] = 1; wire.set(unb64(id, 16), 1);
  const iv = crypto.getRandomValues(wire.subarray(17, wirePrefixBytes));
  const additionalData = aad(lane, wire.subarray(0, wirePrefixBytes));
  wire.set(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, lane.key, data)), wirePrefixBytes);
  return { id, wire };
}

export function wireId(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < wirePrefixBytes + 18 || bytes.length > maxWireBytes || bytes[0] !== 1) throw Error("Invalid encrypted message");
  return b64(bytes.subarray(1, 17));
}

export async function open(lane, wire, expectedId) {
  if (wireId(wire) !== expectedId) throw Error("Message ID mismatch");
  const iv = wire.subarray(17, wirePrefixBytes);
  const additionalData = aad(lane, wire.subarray(0, wirePrefixBytes));
  const data = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData }, lane.key, wire.subarray(wirePrefixBytes)));
  const size = new DataView(data.buffer).getUint16(0);
  if (size < 2 || size > 768 || data.length <= 2 + size) throw Error("Invalid encrypted header");
  const raw = decoder.decode(data.subarray(2, 2 + size));
  const header = JSON.parse(raw);
  if (!Array.isArray(header) || header.length !== 2 || JSON.stringify(header) !== raw) throw Error("Invalid encrypted header");
  const [mime, name] = header;
  const content = data.subarray(2 + size);
  validate(mime, name, content);
  return { mime, name, content, text: mime === "text/plain" ? decoder.decode(content) : undefined };
}
