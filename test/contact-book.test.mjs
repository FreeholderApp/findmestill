// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { exportBook, importBook, maxBookBytes } from "../public/contact-book.mjs";

const v = JSON.parse(await readFile(new URL("../public/fixtures/discovery-predecessor-v0.1.json", import.meta.url)));
const records = [[v.contactId, v.pin]];

test("a contact book can restore an expired identity pin using its separate recovery code", async () => {
  const { file, code } = await exportBook(records, v.now);
  assert.deepEqual(await importBook(file, code, v.now + 86400), records);
  const stored = Buffer.from(file);
  for (const text of [code, v.pin, v.contactId, "studio.example"]) assert.equal(stored.includes(text), false);
});

test("each export has a distinct random key and rejects a mismatched code or changed file", async () => {
  const first = await exportBook(records, v.now);
  const second = await exportBook(records, v.now);
  assert.notEqual(first.code, second.code);
  assert.notDeepEqual(first.file, second.file);
  await assert.rejects(importBook(first.file, second.code, v.now));
  const changed = first.file.slice();
  changed[changed.length - 1] ^= 1;
  await assert.rejects(importBook(changed, first.code, v.now));
  await assert.rejects(importBook(first.file.slice(0, -1), first.code, v.now));
});

test("rejects oversized files, empty or duplicate lists, and unverified records", async () => {
  await assert.rejects(importBook(new Uint8Array(maxBookBytes + 1), "", v.now));
  for (const list of [[], [...records, ...records], [[v.contactId, "invalid"]]]) {
    await assert.rejects(exportBook(list, v.now));
  }
});

test("independent Python AES-GCM fixture opens with the published bytes and recovery code", async () => {
  const vector = JSON.parse(await readFile(new URL("../public/fixtures/contact-book-v1.json", import.meta.url)));
  assert.deepEqual(await importBook(Buffer.from(vector.base64, "base64"), vector.code, v.now), records);
});
