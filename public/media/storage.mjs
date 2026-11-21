// Copyright (C) 2026 Tony Aly
// SPDX-License-Identifier: Apache-2.0
const database = new Promise((resolve, reject) => {
  const request = indexedDB.open("findmestill-private-media-v1", 2);
  request.onupgradeneeded = ({ oldVersion }) => {
    if (oldVersion === 0) {
      request.result.createObjectStore("pairs", { keyPath: "id" });
      request.result.createObjectStore("outbox", { keyPath: "key" });
    }
    request.transaction.objectStore("outbox").createIndex("pair", "pair");
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
