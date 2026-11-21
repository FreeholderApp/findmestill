// Copyright (C) 2026 Tony Aly
// SPDX-License-Identifier: Apache-2.0
const database = new Promise((resolve, reject) => {
  const request = indexedDB.open("findmestill-private-media-v1", 3);
  request.onupgradeneeded = ({ oldVersion }) => {
    if (oldVersion === 0) {
      request.result.createObjectStore("pairs", { keyPath: "id" });
      request.result.createObjectStore("outbox", { keyPath: "key" });
    }
    if (oldVersion < 2) request.transaction.objectStore("outbox").createIndex("pair", "pair");
    request.result.createObjectStore("downloadChunks", { keyPath: ["key", "offset"] }).createIndex("expiry", "expiresAt");
  };
  request.onsuccess = () => {
    request.result.onversionchange = () => request.result.close();
    resolve(request.result);
  };
  request.onerror = () => reject(request.error);
});

export async function access(store, operation, mode = "readonly") {
  const db = await database;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = operation(tx.objectStore(store));
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(tx.error ?? Error("Private storage operation failed"));
  });
}

export function downloadCheckpoints(pair, header) {
  const key = `${pair.origin}/${pair.id}/${pair.role}/${header.id}/${header.digest}`;
  const range = IDBKeyRange.bound([key, 0], [key, Number.MAX_SAFE_INTEGER]);
  return {
    async load() {
      await reapDownloads();
      return await access("downloadChunks", store => store.getAll(range)).catch(() => []);
    },
    async save(part) {
      if (header.expiresAt <= Date.now()) return;
      const db = await database;
      await new Promise(resolve => {
        const tx = db.transaction("downloadChunks", "readwrite");
        const store = tx.objectStore("downloadChunks");
        const count = store.count();
        count.onsuccess = () => {
          // At most 64 MiB of encrypted range checkpoints per app origin.
          if (count.result < 256) store.put({ ...part, key, expiresAt: header.expiresAt });
        };
        tx.oncomplete = tx.onabort = resolve;
      }).catch(() => {});
    },
    clear: () => access("downloadChunks", store => store.delete(range), "readwrite").catch(() => {}),
  };
}

export async function reapDownloads() {
  try {
    const db = await database;
    await new Promise(resolve => {
      const tx = db.transaction("downloadChunks", "readwrite");
      const cursor = tx.objectStore("downloadChunks").index("expiry").openCursor(IDBKeyRange.upperBound(Date.now()));
      cursor.onsuccess = () => { if (cursor.result) { cursor.result.delete(); cursor.result.continue(); } };
      tx.oncomplete = tx.onabort = resolve;
    });
  } catch { /* A storage error does not prevent an online download. */ }
}

export async function enqueue(pair, item, key = pair.id + "/" + item.id) {
  const db = await database;
  return new Promise((resolve, reject) => {
    const tx = db.transaction("outbox", "readwrite");
    const store = tx.objectStore("outbox");
    let stored;
    const lookup = store.get(key);
    lookup.onsuccess = () => {
      stored = lookup.result;
      if (!stored) {
        stored = { key, pair: pair.id, id: item.id, wire: item.wire, source: item.source, automaticFrom: item.automaticFrom };
        store.add(stored);
      }
    };
    tx.oncomplete = () => resolve(stored);
    tx.onabort = () => reject(tx.error ?? Error("Could not store outgoing ciphertext"));
  });
}
