const CACHE_NAME = "ecovital-app-v2";
const PRECACHE_URLS = ["/", "/add", "/insights", "/ask", "/voice", "/download", "/assets/logo.png"];

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

// Push notification received in background (even when the app is closed)
self.addEventListener("push", (event) => {
  let data = {
    title: "EcoVital Air Alert",
    body: "Air quality alert from your EcoVital pod.",
    icon: "/assets/logo.png",
    data: { url: "/dashboard" },
  };

  try {
    if (event.data) {
      const parsed = event.data.json();
      data = { ...data, ...parsed };
    }
  } catch {
    if (event.data) data.body = event.data.text();
  }

  const isGas = !!data.isGasAlarm;
  const options = {
    body: data.body,
    icon: data.icon || "/assets/logo.png",
    badge: "/assets/logo.png",
    tag: data.tag || (isGas ? "gas-alarm-" + Date.now() : "ecovital-alert"),
    vibrate: isGas ? [500, 150, 500, 150, 500] : [200, 100, 200],
    requireInteraction: isGas,
    data: data.data || { url: "/dashboard" },
    actions: [
      { action: "open", title: "View Pod" },
      { action: "dismiss", title: "Dismiss" },
    ],
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

// Clicking the notification focuses the app or opens it
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  if (event.action === "dismiss") return;

  const urlToOpen = (event.notification.data && event.notification.data.url) || "/dashboard";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(urlToOpen);
      }
    }),
  );
});
