// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSite } from "../server.mjs";

const { chromium } = await import(process.env.FMS_PLAYWRIGHT_MODULE ?? "playwright");
const work = await mkdtemp(join(tmpdir(), "findmestill-recovery-browser-"));
const site = join(work, "dist");
const servers = [];
const documents = new Map();
const failures = [];
let browser;
const cli = (...args) => execFileSync(process.execPath, ["client.mjs", ...args], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
});
const status = (page, text) => page.locator("#status").filter({ hasText: text }).waitFor();

async function start() {
  const server = createSite(site).listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  return "http://127.0.0.1:" + server.address().port;
}

async function identity(name) {
  const old = "https://" + name + "-old.test/fms/card.json";
  const backup = "https://" + name + "-backup.test/fms/card.json";
  const current = "https://" + name + "-new.test/fms/card.json";
  const pem = join(work, name + ".pem");
  const first = join(work, name + "-initial.json");
  cli("keygen", pem);
  const initial = JSON.parse(cli("issue", pem, old, "86400", "-", backup));
  await writeFile(first, JSON.stringify(initial));
  const moved = JSON.parse(cli("issue", pem, current, "86400", first, backup));
  const id = JSON.parse(Buffer.from(initial[0].split(".")[1], "base64url"))[1];
  const latest = join(work, name + "-current.json");
  await writeFile(latest, JSON.stringify(moved));
  const pageUrl = current.slice(0, -"/card.json".length);
  const html = cli("publish-page", pageUrl, id, latest, name);
  return { id, old, backup, current, initial, moved, pageUrl, html, pem, latest };
}

async function openApp(origin) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.route(/^https:/, async route => {
    const url = route.request().url();
    const doc = documents.get(url);
    if (!new URL(url).hostname.endsWith(".test")) failures.push("Unexpected origin");
    await route.fulfill(doc ? {
      contentType: typeof doc === "string" ? "text/html" : "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: typeof doc === "string" ? doc : JSON.stringify(doc),
    } : { status: 404, headers: { "Access-Control-Allow-Origin": "*" }, body: "" });
  });
  const page = await context.newPage();
  page.on("pageerror", error => failures.push(error.message));
  page.setDefaultTimeout(10000);
  await page.goto(origin);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  return { page, context };
}

async function saveAndExport(origin, owner, contact) {
  const { page, context } = await openApp(origin);
  await page.locator("#contact").fill(contact.old + "#" + contact.id);
  await page.getByRole("button", { name: "Verify and save" }).click();
  await status(page, "Verified revision 1");
  await page.locator("#book summary").click();
  const download = page.waitForEvent("download");
  await page.locator("#export-book").click();
  const file = join(work, owner + ".fmsbook");
  await (await download).saveAs(file);
  const code = await page.locator("#book-code").inputValue();
  assert.equal(code.length, 52);
  await context.close();
  return { file, code };
}

async function restoreOffline(origin, backup, wrongCode, contact) {
  const { page, context } = await openApp(origin);
  await context.setOffline(true);
  await page.reload();
  await page.locator("#connection").waitFor();
  assert.equal(await page.locator("#saved li").count(), 0);
  await page.locator("#book summary").click();
  async function restore(code, message) {
    await page.locator("#book-file").setInputFiles(backup.file);
    await page.locator("#recovery-code").fill(code);
    await page.getByRole("button", { name: "Restore contacts" }).click();
    await status(page, message);
  }
  await restore(wrongCode, "Could not verify this backup");
  assert.equal(await page.locator("#saved li").count(), 0);
  await restore(backup.code, "Restored 1 and kept 0 existing");
  await restore(backup.code, "Restored 0 and kept 1 existing");
  assert.equal(await page.locator("#saved li").count(), 1);
  assert.ok((await page.locator("#saved li").innerText()).includes(contact.id));
  return { page, context };
}

try {
  await cp("dist", site, { recursive: true });
  const original = await start();
  const replacement = await start();
  const alice = await identity("alice");
  const bob = await identity("bob");
  for (const person of [alice, bob]) {
    documents.set(person.old, person.initial);
    documents.set(person.backup, person.initial);
  }
  browser = await chromium.launch({ channel: "chrome" });
  const a = await saveAndExport(original, "alice", bob);
  const b = await saveAndExport(original, "bob", alice);

  documents.clear();
  documents.set(bob.backup, bob.moved);
  for (const person of [alice, bob]) {
    documents.set(person.current, person.moved);
    documents.set(person.pageUrl, person.html);
  }
  const recoveredA = await restoreOffline(replacement, a, b.code, bob);
  const recoveredB = await restoreOffline(replacement, b, a.code, alice);
  await recoveredA.context.setOffline(false);
  await recoveredB.context.setOffline(false);
  await recoveredA.page.locator("#saved li").filter({ hasText: "bob-new.test · revision 2" }).waitFor();
  const page = recoveredB.page;
  await status(page, "Some saved contacts need attention");
  await page.getByRole("button", { name: "Check for a move" }).click();
  await status(page, "No host confirmed this revision");
  await page.getByText("Find this contact again", { exact: true }).click();
  for (const name of ["Google", "Bing", "DuckDuckGo"]) {
    const link = page.getByRole("link", { name, exact: true });
    const url = new URL(await link.getAttribute("href"));
    assert.equal(url.searchParams.get("q"), '"' + alice.id + '"');
    assert.match(await link.getAttribute("rel"), /noreferrer/);
  }
  const candidate = page.getByLabel("Candidate card link for this contact");
  const verify = page.getByRole("button", { name: "Verify new location" });
  await candidate.fill(bob.current + "#" + bob.id);
  await verify.click();
  await status(page, "different contact");
  const publisher = recoveredA.page;
  await publisher.locator("#publish summary").click();
  await publisher.getByLabel("Public display name").fill("alice");
  await publisher.getByLabel("My signed contact link").fill(alice.current + "#" + alice.id);
  await publisher.getByLabel("Public page URL").fill(alice.pageUrl);
  await publisher.getByRole("button", { name: "Prepare public block" }).click();
  await publisher.locator("#publication").waitFor();
  assert.ok((await publisher.locator("#public-text").inputValue()).includes(alice.current + "#" + alice.id));
  const prepared = publisher.waitForEvent("download");
  await publisher.getByRole("button", { name: "Download HTML page" }).click();
  const copy = join(work, "public.html");
  await (await prepared).saveAs(copy);
  assert.equal(await readFile(copy, "utf8"), alice.html);
  const publicPage = await recoveredB.context.newPage();
  await publicPage.goto(alice.pageUrl);
  assert.equal(await publicPage.locator("main code").innerText(), alice.id);
  const cardLink = await publicPage.locator("main a").getAttribute("href");
  assert.equal(cardLink, alice.current + "#" + alice.id);
  await candidate.fill(cardLink);
  await verify.click();
  await status(page, "Verified revision 2");
  assert.equal(await page.locator("#saved li").count(), 1);
  assert.ok((await page.locator("#saved li").innerText()).includes(alice.id));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  // Two tabs see different, authentic publication snapshots for Bob.
  const third = "https://bob-third.test/fms/card.json";
  const fourth = "https://bob-fourth.test/fms/card.json";
  const revision3 = JSON.parse(cli("issue", bob.pem, third, "86400", bob.latest, bob.backup));
  const prior = join(work, "third.json");
  await writeFile(prior, JSON.stringify(revision3));
  const revision4 = JSON.parse(cli("issue", bob.pem, fourth, "86400", prior, bob.backup));
  documents.set(fourth, revision4);
  const requested = Promise.withResolvers();
  const release = Promise.withResolvers();
  await publisher.route(third, async route => {
    requested.resolve();
    await release.promise;
    await route.fulfill({ json: revision3, headers: { "Access-Control-Allow-Origin": "*" } });
  });
  const secondTab = await recoveredA.context.newPage();
  await secondTab.goto(replacement);
  for (const [tab, url] of [[publisher, third], [secondTab, fourth]]) {
    await tab.locator("#contact").fill(url + "#" + bob.id);
    await tab.getByRole("button", { name: "Verify and save" }).click();
    if (tab === publisher) await requested.promise;
  }
  try {
    await secondTab.waitForFunction(async () => (await navigator.locks.query()).pending.length > 0);
  } finally { release.resolve(); }
  await status(secondTab, "Verified revision 4");
  for (const tab of [publisher, secondTab]) {
    await tab.locator("#saved li").filter({ hasText: "bob-fourth.test · revision 4" }).waitFor();
    assert.equal(await tab.locator("#saved li").count(), 1);
  }

  // After eviction, a different file at a pinned shell path must fail integrity.
  const css = await readFile(join(site, "style.css"));
  const evicted = await page.evaluate(async () => {
    const [name] = await caches.keys();
    return (await caches.open(name)).delete("/style.css");
  });
  assert.equal(evicted, true);
  await writeFile(join(site, "style.css"), Buffer.concat([css, Buffer.from("\n/* changed */")]));
  assert.equal(await page.evaluate(() => fetch("/style.css").then(() => true, () => false)), false);
  await writeFile(join(site, "style.css"), css);
  assert.equal(await page.evaluate(() => fetch("/style.css").then(r => r.ok)), true);
  assert.deepEqual(failures, []);
  console.log("Chrome " + browser.version() + " passed two-person domain loss, encrypted export and offline restore across origins, backup and search-guided signed recovery, copyable website block, identical CLI/browser HTML, wrong identity refusal, serialized two-tab moves, and evicted shell integrity.");
} finally {
  await browser?.close();
  for (const server of servers) { server.closeAllConnections(); server.close(); }
  await rm(work, { recursive: true, force: true });
}
