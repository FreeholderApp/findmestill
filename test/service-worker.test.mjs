// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");
const origin = "https://preview.example";
const cachePrefix = "findmestill-public-discovery-";

function worker() {
  const calls = [];
  const events = {};
  const cache = {
    addAll: async requests => calls.push(...requests),
    match: async path => "cached " + path,
  };
  vm.runInNewContext(source, {
    shellVersion: "test",
    shellAssets: { "/": "sha256-test", "/app.mjs": "sha256-app" },
    self: {
      addEventListener: (type, cb) => { events[type] = cb; },
      location: { origin },
      clients: { claim: async () => calls.push("claimed") },
    },
    URL,
    Request: function (path, options) {
      this.path = path;
      this.options = options;
    },
    caches: {
      open: async () => cache,
      keys: async () => ["unrelated", cachePrefix + "old", cachePrefix + "test"],
      delete: async key => calls.push(key),
    },
  });
  return { calls, events };
}

test("install preloads only public shell bytes, without credentials or redirects", async () => {
  const { calls, events } = worker();
  let completion;
  events.install({ waitUntil: promise => { completion = promise; } });
  await completion;
  assert.equal(calls.map(entry => entry.path).join(","), "/,/app.mjs");
  assert.equal(calls[1].options.integrity, "sha256-app");
  assert.equal(calls[1].options.credentials, "omit");
  assert.equal(calls[1].options.redirect, "error");
});

test("worker ignores remote, dynamic, authenticated query and private inbox requests", async () => {
  const { events } = worker();
  for (const [method, url] of [
    ["POST", origin + "/"],
    ["GET", origin + "/app.mjs?token=fixture"],
    ["GET", origin + "/cards/desk.json"],
    ["GET", origin + "/api/inbox"],
    ["GET", "https://remote.example/app.mjs"],
  ]) {
    events.fetch({ request: { method, url }, respondWith: () => assert.fail("request was intercepted") });
  }
  let result;
  events.fetch({ request: { method: "GET", url: origin + "/app.mjs" }, respondWith: promise => { result = promise; } });
  assert.equal(await result, "cached /app.mjs");
});

test("activation clears only older FindMeStill shell caches", async () => {
  const { calls, events } = worker();
  let completion;
  events.activate({ waitUntil: promise => { completion = promise; } });
  await completion;
  assert.deepEqual(calls, [cachePrefix + "old", "claimed"]);
});
