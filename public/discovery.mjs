// SPDX-License-Identifier: Apache-2.0
export const profile = "findmestill-card-v0.1";
export const maxRecords = 64;
export const maxDocumentBytes = 262144;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const header = '{"alg":"Ed25519","typ":"findmestill-card-v0.1"}';
const maxLifetime = 366 * 86400;
const maxClockSkew = 300;

export class DiscoveryError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function need(condition, code = "invalid_card") {
  if (!condition) throw new DiscoveryError(code);
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decode(segment, maxLength) {
  need(typeof segment === "string" && segment.length > 0
    && segment.length <= maxLength && !/[^a-zA-Z0-9_-]/.test(segment)
    && segment.length % 4 !== 1);
  const bytes = Uint8Array.from(atob(segment.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
  need(base64url(bytes) === segment);
  return bytes;
}

async function sha256(text) {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}

export function validateContactId(id) {
  need(typeof id === "string" && /^fms1-[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(id) && id.length === 48, "invalid_id");
  return id;
}

export function validateLocator(value) {
  need(typeof value === "string" && value.length <= 768
    && /^https:\/\/[a-z0-9.-]+(?::[0-9]+)?\/[a-zA-Z0-9_~./-]*$/.test(value), "invalid_locator");
  let url;
  try { url = new URL(value); } catch { throw new DiscoveryError("invalid_locator"); }
  need(url && url.href === value && url.port !== "0"
    && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(url.hostname)
    && url.hostname.length <= 253
    && !url.hostname.endsWith(".localhost") && !url.pathname.includes("//"), "invalid_locator");
  return url.href;
}

function parsePayload(bytes) {
  let text;
  let fields;
  try {
    text = decoder.decode(bytes);
    fields = JSON.parse(text);
  } catch {
    throw new DiscoveryError("invalid_card");
  }
  need(Array.isArray(fields) && fields.length === 9 && fields[0] === profile
    && JSON.stringify(fields) === text);
  const [, id, key, revision, previous, issuedAt, expiresAt, primary, backups] = fields;
  validateContactId(id);
  need(Number.isSafeInteger(revision) && revision >= 1);
  need(revision === 1 ? previous === null : decode(previous, 43).length === 32);
  need(Number.isSafeInteger(issuedAt) && issuedAt > 0 && Number.isSafeInteger(expiresAt)
    && expiresAt > issuedAt && expiresAt - issuedAt <= maxLifetime);
  validateLocator(primary);
  need(Array.isArray(backups) && backups.length <= 2
    && new Set([primary, ...backups]).size === backups.length + 1);
  backups.forEach(validateLocator);
  return { id, key, revision, previous, issuedAt, expiresAt, primary, backups };
}

export async function verifyCard(jws, expectedId, now = Math.floor(Date.now() / 1000)) {
  need(Number.isSafeInteger(now) && now >= 0, "invalid_clock");
  validateContactId(expectedId);
  need(typeof jws === "string" && jws.length <= 4090);
  const parts = jws.split(".");
  need(parts.length === 3 && parts[0] === base64url(encoder.encode(header)));
  const [protectedHeader, payload, signature] = parts;
  const card = parsePayload(decode(payload, 3950));
  const rawKey = decode(card.key, 43);
  const sig = decode(signature, 86);
  need(rawKey.length === 32 && sig.length === 64);
  const thumbprint = await sha256(`{"crv":"Ed25519","kty":"OKP","x":"${card.key}"}`);
  need(card.id === expectedId && card.id === `fms1-${thumbprint}`, "identity_mismatch");
  need(card.issuedAt <= now + maxClockSkew, "future_card");
  const key = await crypto.subtle.importKey("raw", rawKey, "Ed25519", false, ["verify"]);
  need(await crypto.subtle.verify("Ed25519", key, sig, encoder.encode(`${protectedHeader}.${payload}`)),
    "invalid_signature");
  return { ...card, jws, digest: await sha256(jws) };
}

async function verifyChain(records, id, now) {
  need(Array.isArray(records) && records.length >= 1 && records.length <= maxRecords, "invalid_chain");
  const chain = [];
  for (const record of records) {
    const card = await verifyCard(record, id, now);
    const prior = chain.at(-1);
    need(card.revision === chain.length + 1, "invalid_chain");
    if (prior) {
      need(card.previous === prior.digest && card.issuedAt >= prior.issuedAt, "invalid_chain");
    }
    chain.push(card);
  }
  return chain;
}

// A pin is the exact compact JWS previously selected and persisted by the client.
async function selectWithEvidence(id, documents, pinned, now) {
  validateContactId(id);
  const results = await Promise.allSettled(documents.map(records => verifyChain(records, id, now)));
  const seen = new Map(pinned ? [[pinned.revision, pinned.digest]] : []);
  if (pinned?.previous) seen.set(pinned.revision - 1, pinned.previous);
  let head = pinned;
  let highestPublished = 0;
  for (const result of results) {
    if (result.status === "rejected") continue;
    for (const card of result.value) {
      need(!seen.has(card.revision) || seen.get(card.revision) === card.digest, "conflicting_cards");
      seen.set(card.revision, card.digest);
    }
    const candidate = result.value.at(-1);
    highestPublished = Math.max(highestPublished, candidate.revision);
    if (!head || candidate.revision > head.revision) head = candidate;
  }
  need(head, "no_verified_card");
  need(head.expiresAt > now, "expired_card");
  return { card: head, confirmed: highestPublished === head.revision };
}

export async function selectCard(id, documents, { pin, now = Math.floor(Date.now() / 1000) } = {}) {
  const pinned = pin === undefined ? undefined : await verifyCard(pin, id, now);
  return (await selectWithEvidence(id, documents, pinned, now)).card;
}

export async function readCardDocument(locator, fetcher = fetch) {
  validateLocator(locator);
  const response = await fetcher(locator, {
    headers: { Accept: "application/json" }, credentials: "omit", redirect: "error",
    referrerPolicy: "no-referrer", cache: "no-store", signal: AbortSignal.timeout(5000),
  });
  if (response.status !== 200 || !response.body
    || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    await response.body?.cancel();
    throw new DiscoveryError("unavailable_document");
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    let next;
    while (!(next = await reader.read()).done) {
      total += next.value.length;
      need(total <= maxDocumentBytes, "document_too_large");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(decoder.decode(bytes));
}

export async function checkContact({ id, locator, pin, fetcher = fetch, now }) {
  validateContactId(id);
  const clock = () => now ?? Math.floor(Date.now() / 1000);
  const saved = pin === undefined ? undefined : await verifyCard(pin, id, clock());
  const locators = saved ? [saved.primary, ...saved.backups] : [validateLocator(locator)];
  // A caller may supply a fresh, explicit introduction for a saved contact.
  if (saved && locator !== undefined) locators.push(validateLocator(locator));
  const responses = await Promise.allSettled([...new Set(locators)].map(url => readCardDocument(url, fetcher)));
  const documents = responses.filter(result => result.status === "fulfilled").map(result => result.value);
  const result = await selectWithEvidence(id, documents, saved, clock());
  need(result.card.expiresAt > clock(), "expired_card");
  return result;
}

export async function resolveContact(options) {
  return (await checkContact(options)).card;
}
