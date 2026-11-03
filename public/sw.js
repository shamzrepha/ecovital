const CACHE_NAME = "ecovital-app-v2";
const PRECACHE_URLS = ["/", "/add", "/insights", "/ask", "/download", "/assets/logo.png"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS).catch(() => {})),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  if (event.request.url.includes("/api/")) return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request)),
  );
});

// Phone alerts (Web Push). Gas alarms stay on screen until tapped and vibrate in a long pattern.
self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { title: "EcoVital", body: event.data ? event.data.text() : "" }; }
  const alarm = !!d.alarm;
  event.waitUntil(self.registration.showNotification(d.title || "EcoVital alert", {
    body: d.body || "",
    icon: "/assets/logo.png",
    badge: "/assets/logo.png",
    tag: d.tag || "ecovital",
    renotify: true,
    requireInteraction: alarm,
    vibrate: alarm ? [600, 200, 600, 200, 600, 200, 600, 200, 900] : [200, 100, 200],
    data: { url: d.url || "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ("focus" in c) { c.navigate(url).catch(() => {}); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
