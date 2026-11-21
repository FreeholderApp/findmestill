// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readCardDocument, selectCard, validateLocator, verifyCard } from "../public/discovery.mjs";

const fixture = JSON.parse(await readFile(new URL("../public/fixtures/discovery-v0.1.json", import.meta.url)));
const id = fixture.contactId;
const now = fixture.initialTime;

test("independent JWS vectors verify and advance from an expired pin", async () => {
  const initial = await selectCard(id, [fixture.initial], { now });
  assert.equal(initial.primary, fixture.primary);
  assert.deepEqual(initial.backups, [fixture.backup]);
  assert.equal(initial.digest, "Mi6mAtIeVjkv29s9BuBGlSbHQn7InugkSvfLV8VIP68");
  const moved = await selectCard(id, [fixture.initial, fixture.moved], { pin: initial.jws, now: fixture.movedTime });
  assert.equal(moved.previous, initial.digest);
  assert.equal(moved.primary, fixture.movedPrimary);
  assert.equal(moved.id, initial.id);
});

test("known live pin resists stale replicas and unavailable hosts", async () => {
  for (const documents of [[], [fixture.initial]]) {
    const head = await selectCard(id, documents, { pin: fixture.moved[1], now: fixture.movedTime });
    assert.equal(head.revision, 2);
  }
});

test("competing signed moves fail closed in both fetch orders and when pinned", async () => {
  for (const documents of [[fixture.conflict, fixture.moved], [fixture.moved, fixture.conflict]]) {
    await assert.rejects(selectCard(id, documents, { now }), { code: "conflicting_cards" });
  }
  await assert.rejects(selectCard(id, [fixture.conflict], { pin: fixture.moved[1], now }),
    { code: "conflicting_cards" });
});

test("rejects expiry at the boundary and will not select an older live route", async () => {
  await assert.rejects(selectCard(id, [fixture.initial], { now: fixture.movedTime }), { code: "expired_card" });
  await assert.rejects(selectCard(id, [fixture.initial, fixture.expired], { now: now + 10 }), { code: "expired_card" });
});

for (const name of ["skipped", "forged", "wrongKey", "future"]) {
  test(`rejects ${name} updates without altering the pin`, async () => {
    await assert.rejects(selectCard(id, [fixture[name]], { now }), { code: "no_verified_card" });
    const card = await selectCard(id, [fixture[name]], { now, pin: fixture.initial[0] });
    assert.equal(card.jws, fixture.initial[0]);
  });
}

test("rejects JWS padding, alternate headers, non-canonical base64url and foreign IDs", async () => {
  const [header, payload, sig] = fixture.initial[0].split(".");
  const altHeader = Buffer.from('{"typ":"findmestill-card-v0.1","alg":"Ed25519"}').toString("base64url");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const badTail = alphabet[alphabet.indexOf(sig.at(-1)) + 1];
  for (const record of [`${header}.${payload}.${sig}=`, `${altHeader}.${payload}.${sig}`,
    `${header}.${payload}.${sig.slice(0, -1)}${badTail}`]) {
    await assert.rejects(verifyCard(record, id, now));
  }
  await assert.rejects(verifyCard(fixture.initial[0], "fms1-" + "A".repeat(43), now),
    { code: "identity_mismatch" });
});

test("locators reject ambiguous or credential-bearing addresses", () => {
  for (const url of [
    "http://example.com/", "https://user@example.com/", "https://127.0.0.1/",
    "https://a.localhost/", "https://example.com-/", "https://example.com/?x", "https://example.com/a#id",
    "https://EXAMPLE.com/", "https://example.com/a/../a", "https://example.com/a//b",
    "https://example.com:0443/", "https://example.com:0/", "https://example.com/%2e",
  ]) assert.throws(() => validateLocator(url), { code: "invalid_locator" });
});

test("card reads enforce streaming size, content type and no redirect or credentials", async () => {
  const result = await readCardDocument(fixture.primary, (url, options) => {
    assert.equal(url, fixture.primary);
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.equal(options.referrerPolicy, "no-referrer");
    return new Response(JSON.stringify(fixture.initial), { headers: { "Content-Type": "application/json" } });
  });
  assert.deepEqual(result, fixture.initial);
  await assert.rejects(readCardDocument(fixture.primary, () => new Response("[]", {
    status: 206, headers: { "Content-Type": "application/json" },
  })), { code: "unavailable_document" });
  await assert.rejects(readCardDocument(fixture.primary, () => new Response("[]")), { code: "unavailable_document" });
  await assert.rejects(readCardDocument(fixture.primary, () => new Response("x".repeat(262145), {
    headers: { "Content-Type": "application/json" },
  })), { code: "document_too_large" });
});
