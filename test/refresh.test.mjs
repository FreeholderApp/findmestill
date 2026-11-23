// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { generateKeyPairSync, createHash, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { checkContact, selectCard } from "../public/discovery.mjs";

const read = async name => JSON.parse(await readFile(new URL("../public/fixtures/" + name, import.meta.url)));
const v = await read("discovery-predecessor-v0.1.json");
const base = await read("discovery-v0.1.json");
const options = { id: v.contactId, pin: v.pin, now: v.now };
const document = chain => new Response(JSON.stringify(chain), { headers: { "Content-Type": "application/json" } });

test("a retained pin and a corroborated pin have distinct refresh outcomes", async () => {
  for (const chain of [[], v.predecessor, v.current]) {
    const outcome = await checkContact({ ...options, fetcher: () => document(chain) });
    assert.equal(outcome.card.jws, v.pin);
    assert.equal(outcome.confirmed, chain === v.current);
  }
  const offline = await checkContact({ ...options, fetcher: async () => { throw Error("unreachable"); } });
  assert.equal(offline.confirmed, false);
  assert.equal(offline.card.jws, v.pin);
});

test("a saved revision authenticates its predecessor even when a replica ends there", async () => {
  for (const shorter of [v.conflicting, v.expiredConflict]) {
    for (const documents of [[shorter], [v.predecessor, shorter], [shorter, v.current]]) {
      await assert.rejects(selectCard(v.contactId, documents, { now: v.now, pin: v.pin }), { code: "conflicting_cards" });
    }
  }
});

test("an explicit fresh introduction can recover a pinned identity when all old locators are gone", async () => {
  const contacted = [];
  const result = await checkContact({ id: v.contactId, pin: base.initial[0], now: v.now,
    locator: base.movedPrimary, fetcher: url => {
      contacted.push(url);
      return url === base.movedPrimary ? document(v.current) : new Response(null, { status: 404 });
    } });
  assert.deepEqual(contacted.sort(), [base.primary, base.backup, base.movedPrimary].sort());
  assert.equal(result.card.jws, v.pin);
  assert.equal(result.confirmed, true);
  const refused = await checkContact({ ...options, locator: base.primary, fetcher: () => document(base.wrongKey) });
  assert.equal(refused.card.jws, v.pin);
  assert.equal(refused.confirmed, false);
});

test("expiry during a refresh is evaluated at completion", async t => {
  let now = base.initialTime;
  t.mock.method(Date, "now", () => now * 1000);
  await assert.rejects(checkContact({ id: v.contactId, locator: base.primary, fetcher: () => {
    now = base.initialTime + 60;
    return document(base.initial);
  } }), { code: "expired_card" });
});

test("every legal revision verifies and history ends at the profile limit", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const { x } = publicKey.export({ format: "jwk" });
  const hash = text => createHash("sha256").update(text).digest("base64url");
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const id = "fms1-" + hash(JSON.stringify({ crv: "Ed25519", kty: "OKP", x }));
  const type = "findmestill-card-v0.1";
  const header = encode({ alg: "Ed25519", typ: type });
  const chain = [];
  for (let revision = 1; revision <= 65; revision++) {
    const previous = revision > 1 ? hash(chain.at(-1)) : null;
    const payload = encode([type, id, x, revision, previous, v.now, v.now + 60, base.primary, []]);
    const data = header + "." + payload;
    chain.push(data + "." + sign(null, Buffer.from(data), privateKey).toString("base64url"));
    if (revision <= 64) {
      const head = await selectCard(id, [chain], { now: v.now, pin: chain.at(-2) });
      assert.equal(head.revision, revision);
    }
  }
  await assert.rejects(selectCard(id, [chain], { now: v.now }), { code: "no_verified_card" });
});
