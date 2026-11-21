// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readCardDocument, resolveContact, selectCard } from "../public/discovery.mjs";
import { createSite } from "../server.mjs";

const fixtureUrl = new URL("../public/fixtures/discovery-v0.1.json", import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl));
const hosts = [fixture.primary, fixture.backup, fixture.movedPrimary].map(value => new URL(value).hostname);

test("Python issuer and HTTPS backup interoperate with the Node client and reference host", { timeout: 15000 }, async t => {
  const work = await mkdtemp(path.join(os.tmpdir(), "findmestill-interop-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const key = path.join(work, "key.pem");
  const cert = path.join(work, "test.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "ed25519", "-noenc", "-days", "1",
    "-subj", "/CN=findmestill-local-conformance",
    "-addext", `subjectAltName=${hosts.map(host => "DNS:" + host).join(",")}`,
    "-keyout", key, "-out", cert,
  ], { stdio: "ignore" });
  const ca = await readFile(cert);
  await mkdir(path.join(work, "contact"));
  await writeFile(path.join(work, new URL(fixture.primary).pathname), JSON.stringify(fixture.initial));
  const reference = createSite(work, { key: await readFile(key), cert: ca });
  reference.listen(0, "127.0.0.1");
  await once(reference, "listening");
  t.after(() => { reference.closeAllConnections(); reference.close(); });
  const referencePort = reference.address().port;

  const backup = spawn("python3", [fileURLToPath(new URL("./backup_site.py", import.meta.url)), cert, key, fileURLToPath(fixtureUrl)],
    { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { backup.kill(); });
  const [startup] = await once(backup.stdout, "data", { signal: AbortSignal.timeout(4000) });
  const backupPort = Number(String(startup).trim());
  assert.ok(Number.isInteger(backupPort) && backupPort > 0);

  const contacted = [];
  // Test-only address mapping. TLS still validates the real hostname and test CA.
  const fetcher = (input, options) => new Promise((resolve, reject) => {
    const url = new URL(input);
    contacted.push(url.hostname);
    const request = https.request({
      hostname: "127.0.0.1", servername: url.hostname, ca, path: url.pathname,
      port: url.hostname === hosts[0] ? referencePort : backupPort,
      headers: { ...options.headers, Host: url.hostname }, signal: options.signal,
    }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      assert.equal(response.headers["access-control-allow-origin"], "*");
      resolve(new Response(Readable.toWeb(response), { headers: response.headers }));
    });
    request.on("error", reject);
    request.end();
  });

  const initial = await resolveContact({
    id: fixture.contactId, locator: fixture.primary, now: fixture.initialTime, fetcher,
  });
  assert.deepEqual(contacted.splice(0), [hosts[0]]);
  assert.equal(initial.revision, 1);

  await new Promise((resolve, reject) => reference.close(error => error ? reject(error) : resolve()));
  const moved = await resolveContact({
    id: fixture.contactId, pin: initial.jws, now: fixture.movedTime, fetcher,
  });
  assert.deepEqual(contacted, [hosts[0], hosts[1]]);
  assert.equal(moved.primary, fixture.movedPrimary);
  assert.equal(moved.id, initial.id);
  const published = await readCardDocument(moved.primary, fetcher);
  assert.equal((await selectCard(initial.id, [published], { pin: moved.jws, now: fixture.movedTime })).digest, moved.digest);
});
