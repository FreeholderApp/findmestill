#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { open, readFile, writeFile } from "node:fs/promises";
import { checkContact, maxDocumentBytes, maxRecords, profile, resolveContact, selectCard } from "./public/discovery.mjs";

import { publishPage } from "./public/publish-page.mjs";

async function readDocument(path) {
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(maxDocumentBytes + 1);
    let size = 0;
    while (size <= maxDocumentBytes) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxDocumentBytes) throw Error("Document exceeds the discovery byte limit");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size)));
  } finally { await file.close(); }
}

const hash = input => createHash("sha256").update(input).digest("base64url");
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const output = value => process.stdout.write(JSON.stringify(value, null, 2) + "\n");
const [command, ...args] = process.argv.slice(2);

async function issue([rootPath, primary, duration, priorPath, ...backups]) {
  const lifetime = Number(duration);
  if (!Number.isSafeInteger(lifetime) || lifetime < 1) throw new Error("Expected a lifetime in seconds");
  const privateKey = createPrivateKey(await readFile(rootPath));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Expected an Ed25519 root");
  const { x } = createPublicKey(privateKey).export({ format: "jwk" });
  const id = `fms1-${hash(JSON.stringify({ crv: "Ed25519", kty: "OKP", x }))}`;
  const now = Math.floor(Date.now() / 1000);
  const prior = priorPath === "-" ? [] : await readDocument(priorPath);
  if (!Array.isArray(prior) || prior.length >= maxRecords || (priorPath !== "-" && prior.length === 0)) {
    throw new Error("Invalid prior document");
  }
  const previous = prior.length ? hash(prior.at(-1)) : null;
  const header = encode({ alg: "Ed25519", typ: profile });
  const payload = encode([profile, id, x, prior.length + 1, previous, now, now + lifetime, primary, backups]);
  const signed = `${header}.${payload}`;
  const jws = `${signed}.${sign(null, Buffer.from(signed), privateKey).toString("base64url")}`;
  const document = [...prior, jws];
  await selectCard(id, [document], { now });
  console.error(`${primary}#${id}`);
  output(document);
}

try {
  if (command === "keygen" && args.length === 1) {
    const { privateKey } = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    await writeFile(args[0], privateKey, { mode: 0o600, flag: "wx" });
  } else if (command === "issue" && args.length >= 4 && args.length <= 6) {
    await issue(args);
  } else if (command === "verify" && (args.length === 2 || args.length === 3)) {
    const [id, document, when] = args;
    const now = when === undefined ? undefined : Number(when);
    if (now !== undefined && (!Number.isSafeInteger(now) || now <= 0)) throw new Error("Invalid clock");
    output(await selectCard(id, [await readDocument(document)], { now }));
  } else if (command === "publish-page" && (args.length === 3 || args.length === 4)) {
    const [pageUrl, id, file, label] = args;
    const { html } = await publishPage(pageUrl, id, await readDocument(file), label);
    process.stdout.write(html);
  } else if (command === "resolve" && args.length === 1) {
    const [locator, id, extra] = args[0].split("#");
    if (extra !== undefined) throw new Error("Expected a single contact ID fragment");
    output(await resolveContact({ id, locator }));
  } else if (command === "refresh" && args.length === 1) {
    const { id, jws } = await readDocument(args[0]);
    const { card, confirmed } = await checkContact({ id, pin: jws });
    if (!confirmed) console.error("Using the saved card. No host confirmed its revision.");
    output(card);
  } else {
    throw new Error([
      "node client.mjs keygen ROOT.pem",
      "node client.mjs issue ROOT.pem PRIMARY TTL_SECONDS PRIOR.json|- [BACKUP ...]",
      "node client.mjs verify CONTACT_ID DOCUMENT.json [UTC_SECONDS]",
      "node client.mjs publish-page PAGE_URL CONTACT_ID DOCUMENT.json [PUBLIC_NAME]",
      "node client.mjs resolve 'https://host/path#fms1-ID'",
      "node client.mjs refresh SAVED_CARD.json",
    ].join("\n"));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
