// SPDX-License-Identifier: Apache-2.0
// The build prepends the shell digests and cache name.
const prefix = "findmestill-public-discovery-";
const cacheName = prefix + shellVersion;

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const requests = Object.entries(shellAssets).map(([path, integrity]) => new Request(path, {
      cache: "reload", credentials: "omit", redirect: "error", integrity,
    }));
    await (await caches.open(cacheName)).addAll(requests);
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(prefix) && key !== cacheName) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.search
    || !Object.hasOwn(shellAssets, url.pathname)) return;
  event.respondWith((async () => {
    const cached = await (await caches.open(cacheName)).match(url.pathname);
    return cached ?? fetch(request);
  })());
});
