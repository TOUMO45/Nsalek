// Offline app shell. Caches same-origin GET requests (static export). Financial data never
// passes through here: it lives in IndexedDB.
// `npm run build` rewrites the next two lines (scripts/sw-precache.mjs): PRECACHE becomes every
// file of the app shell, so the app opens offline from the first visit, and VERSION becomes a hash
// of those files, so each build drops the previous cache.
const VERSION = "nsalek-dev";
const PRECACHE = ["/", "/manifest.webmanifest", "/icon.svg"];
// One dropped file must not lose the whole offline copy: each file gets three tries, and what an
// earlier install already kept is not downloaded again. A missing file still fails the install.
async function keep(cache, url) {
  if (await cache.match(url)) return;
  for (let tries = 1; ; tries++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(url + " " + res.status);
      return await cache.put(url, res);
    } catch (err) {
      if (tries === 3) throw err;
      await new Promise((r) => setTimeout(r, tries * 2000));
    }
  }
}
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(VERSION)
      .then((c) => Promise.allSettled(PRECACHE.map((url) => keep(c, url)))) // a failure must not cut short the slower files
      .then((all) => {
        const failed = all.find((x) => x.status === "rejected");
        if (failed) throw failed.reason;
        return self.skipWaiting();
      }),
  );
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  // Network first for navigations (fresh app), cache fallback offline; cache first for assets.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then(async (res) => {
          // Only the app itself is kept as the offline page: never a host's error page or another page.
          if (res.ok) {
            if (new URL(req.url).pathname === "/") {
              const copy = res.clone();
              caches.open(VERSION).then((c) => c.put("/", copy));
            }
            return res;
          }
          if (res.type === "opaqueredirect") return res; // the browser follows it
          return (await caches.match("/")) || res;
        })
        .catch(() => caches.match("/")),
    );
    return;
  }
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window" }).then((list) => (list[0] ? list[0].focus() : self.clients.openWindow("/#/due"))));
});
