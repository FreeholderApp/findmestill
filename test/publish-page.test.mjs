// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishPage } from "../public/publish-page.mjs";
import { createSite } from "../server.mjs";

const sample = JSON.parse(await readFile(new URL("../public/fixtures/discovery-v0.1.json", import.meta.url)));
const pageUrl = "https://studio-moved.example/fms";

test("searchable HTML has a visible stable ID, distinct canonical and signed card, and an escaped opt-in label", async () => {
  const { html, text } = await publishPage(pageUrl, sample.contactId, sample.moved, 'Studio <East> & "West"', sample.movedTime);
  assert.equal(text.split("\n")[1], "FindMeStill ID: " + sample.contactId);
  assert.ok(html.includes("<code>" + sample.contactId + "</code>"));
  assert.ok(html.includes('<link rel="canonical" href="' + pageUrl + '">'));
  assert.ok(html.includes('<link rel="alternate" type="application/json" href="' + sample.movedPrimary + '">'));
  const contact = sample.movedPrimary + "#" + sample.contactId;
  assert.ok(html.includes('<a href="' + contact + '">' + contact + "</a>"));
  assert.ok(html.includes("<h1>Studio &lt;East&gt; &amp; &quot;West&quot;</h1>"));
  assert.doesNotMatch(html, /<script|noindex/i);
  assert.ok(!html.includes(sample.backup));
});

test("a publication requires a matching signed live chain and a distinct page URL", async () => {
  await assert.rejects(publishPage(pageUrl, sample.contactId, sample.moved, "Two\u2028lines", sample.movedTime));
  for (const [page, chain, now] of [
    [pageUrl, sample.wrongKey, sample.movedTime],
    [pageUrl, sample.initial, sample.movedTime],
    [sample.movedPrimary, sample.moved, sample.movedTime],
  ]) await assert.rejects(publishPage(page, sample.contactId, chain, "Studio", now));
});

test("the optional reference publication returns public HTML and CORS-readable JSON only after installation", async t => {
  const root = await mkdtemp(join(tmpdir(), "findmestill-publication-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = createSite(root).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = "http://127.0.0.1:" + server.address().port;
  assert.equal((await fetch(origin + "/fms")).status, 404);
  await mkdir(join(root, "fms"));
  const { html: page } = await publishPage(pageUrl, sample.contactId, sample.moved, "Studio", sample.movedTime);
  await writeFile(join(root, "fms/index.html"), page);
  await writeFile(join(root, "fms/card.json"), JSON.stringify(sample.moved));
  const response = await fetch(origin + "/fms");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/html/);
  assert.equal(await response.text(), page);
  const head = await fetch(origin + "/fms", { method: "HEAD" });
  assert.equal(head.headers.get("content-length"), String(Buffer.byteLength(page)));
  assert.equal(await head.text(), "");
  const json = await fetch(origin + "/fms/card.json");
  assert.equal(json.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(await json.json(), sample.moved);
  assert.equal((await fetch(origin + "/fms/private")).status, 404);
});
