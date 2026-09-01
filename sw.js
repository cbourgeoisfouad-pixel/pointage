/* Service worker Pointage — réception des notifications push */
self.addEventListener("install", e => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(clients.claim()));

self.addEventListener("push", e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) { data = { body: e.data ? e.data.text() : "" }; }
  const title = data.title || "Pointage — US Car Wash";
  e.waitUntil(self.registration.showNotification(title, {
    body: data.body || "Tu as des choses à faire dans Pointage.",
    icon: "icon.png",
    badge: "icon.png",
    data: { url: data.url || "/?goto=afaire" }
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/?goto=afaire";
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) { if ("focus" in c) { c.navigate(url); return c.focus(); } }
    return clients.openWindow(url);
  }));
});
