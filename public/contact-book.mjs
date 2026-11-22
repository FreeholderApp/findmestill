// SPDX-License-Identifier: Apache-2.0
import { maxRecords, verifyCard } from "./discovery.mjs";

const encoder = new TextEncoder();
const magic = encoder.encode("findmestill.contact-book.v1\n");
export const maxBookBytes = 8 * 1024 * 1024;
const maxContacts = 2048;
const ivBytes = 12;
const tagBytes = 16;

function codeFor(bytes) {
  return "fmsbook1-" + btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function keyFrom(code, usage) {
  if (typeof code !== "string" || code.length !== 52 || !/^fmsbook1-[A-Za-z0-9_-]{43}$/.test(code)) {
    throw Error("Invalid recovery code");
  }
  const raw = Uint8Array.from(atob(code.slice(9).replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
  try {
    if (codeFor(raw) !== code) throw Error("Invalid recovery code");
    return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [usage]);
  } finally { raw.fill(0); }
}

async function checkRecords(records, now) {
  if (!Array.isArray(records) || records.length === 0 || records.length > maxContacts) throw Error("Invalid contact count");
  const seen = new Set();
  for (const record of records) {
    if (!Array.isArray(record) || record.length !== 2 || seen.has(record[0])) throw Error("Invalid contact entry");
    const [id, jws] = record;
    const card = await verifyCard(jws, id, now); // Expired pins can authenticate successors.
    if (card.revision > maxRecords) throw Error("Revision exceeds the discovery history limit");
    seen.add(id);
  }
  return records;
}

export async function exportBook(records, now) {
  await checkRecords(records, now);
  const plain = encoder.encode(JSON.stringify(records));
  try {
    if (plain.length + magic.length + ivBytes + tagBytes > maxBookBytes) throw Error("Contact book is too large");
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const code = codeFor(raw);
    raw.fill(0);
    const key = await keyFrom(code, "encrypt");
    const iv = crypto.getRandomValues(new Uint8Array(ivBytes));
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: magic }, key, plain);
    const file = new Uint8Array(magic.length + iv.length + encrypted.byteLength);
    file.set(magic);
    file.set(iv, magic.length);
    file.set(new Uint8Array(encrypted), magic.length + iv.length);
    return { file, code };
  } finally { plain.fill(0); }
}

export async function importBook(file, code, now) {
  if (!(file instanceof Uint8Array) || file.length > maxBookBytes || file.length <= magic.length + ivBytes + tagBytes
    || !magic.every((byte, i) => byte === file[i])) throw Error("Invalid contact book");
  const key = await keyFrom(code, "decrypt");
  const offset = magic.length + ivBytes;
  const plain = new Uint8Array(await crypto.subtle.decrypt({
    name: "AES-GCM", additionalData: magic, iv: file.subarray(magic.length, offset),
  }, key, file.subarray(offset)));
  try {
    const records = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain));
    return await checkRecords(records, now);
  } finally { plain.fill(0); }
}
