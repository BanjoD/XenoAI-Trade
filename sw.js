/* XenoAI Trade — service worker: оффлайн-кэш оболочки + системные уведомления.
   Рыночные API (Binance/Bybit/OKX), новостные ленты и облако памяти ИИ никогда
   не кэшируются — цены и сигналы всегда живые. Без сети платформа деградирует
   в симуляцию, но продолжает работать (кэш отдаёт оболочку приложения). */
"use strict";

const VERSION = "xenoai-v23";
const CORE = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon.svg",
  "./css/styles.css",
  "./js/format.js",
  "./js/data.js",
  "./js/indicators.js",
  "./js/candles.js",
  "./js/binance.js",
  "./js/live.js",
  "./js/engine.js",
  "./js/charts.js",
  "./js/store.js",
  "./js/whalesdb.js",
  "./js/glm.js",
  "./js/notify.js",
  "./js/ui.js",
  "./js/views-core.js",
  "./js/views-trade.js",
  "./js/auth.js",
  "./js/backend-config.js",
  "./js/backend.js",
  "./js/app.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-192.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/badge-96.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) =>
      // каждый файл кэшируем отдельно: один сбой не ломает установку
      Promise.all(CORE.map((url) => cache.add(new Request(url, { cache: "reload" })).catch(() => {})))
    ).then(() => self.skipWaiting())
  );
});

// R32: команда от страницы «применить новую версию немедленно» — без этого PWA
// может неделями работать на старом service worker (кейс «на мобиле старое поведение»)
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // биржи/новости/облако — только сеть

  // навигация: сеть → кэш → оболочка (SPA работает и офлайн)
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() =>
          caches.match(req).then((hit) => hit || caches.match("./index.html"))
        )
    );
    return;
  }

  // статика: сразу из кэша, фоновым обновлением не мешаем
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((hit) => {
        const network = fetch(req)
          .then((res) => {
            if (res && res.ok) {
              const copy = res.clone();
              caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
            }
            return res;
          })
          .catch(() => hit);
        return hit || network;
      })
    );
  }
});

/* ---- системные уведомления ---- */

// клик по уведомлению: сфокусировать открытое приложение или открыть новое
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "./";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.indexOf("xenoai") !== -1 || new URL(client.url).pathname === new URL(target, client.url).pathname) {
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});

// настоящий push: события от Стража (Web Push, RFC 8292) — приходят, когда приложение закрыто.
// R47: ГЛУХИХ ОТКАЗОВ БОЛЬШЕ НЕТ. Раньше пуш без title молча игнорировался (if (!p.title)
// return), а ошибка showNotification глоталась (.catch(() => {})) — сервер никогда не узнавал,
// что устройство не показало уведомление. Теперь: (1) без title показываем фолбэк;
// (2) успех/ошибка показа отправляется ack-ом на сервер (sub.lastAck — виден в модалке);
// (3) по ack-ам видно главный диагноз: 201 от FCM есть, ack с устройства не пришёл =
// пуш застрял на уровне OS/Chrome (разрешение, батарея, либо подписка чужого origin).
const API_BASE = "https://xenoai-trade-backend.eldavidarz.workers.dev";

async function ackPush(ok, err) {
  try {
    const sub = await self.registration.pushManager.getSubscription();
    if (!sub || !sub.endpoint) return;
    const tail = String(sub.endpoint).slice(-24);
    await fetch(API_BASE + "/api/push-ack", { method: "POST", body: JSON.stringify({ tail, ok: Boolean(ok), err: String(err || "").slice(0, 120) }) });
  } catch (e) { /* ack не критичен */ }
}

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let p = {};
    try { p = event.data ? event.data.json() : {}; } catch (e) { try { p = { title: event.data && event.data.text() }; } catch (e2) { /* пустой payload */ } }
    if (!p || typeof p !== "object" || !p.title) p = { title: "XenoAI Trade", body: "Новое событие сделки" }; // R47: фолбэк вместо молчания
    let shown = false;
    let errText = "";
    try {
      await self.registration.showNotification(p.title, {
        body: p.body || "",
        tag: p.tag || undefined,
        icon: "icons/icon-192.png",
        badge: "icons/badge-96.png",
        renotify: Boolean(p.tag),
        silent: p.silent === true,
        vibrate: p.silent === true ? undefined : [90, 45, 90],
        data: { url: p.url || "./" },
      });
      shown = true;
    } catch (e) {
      errText = String((e && e.message) || e);
    }
    // ack на сервер в ЛЮБОМ случае: ok=true — устройство показало; ok=false —
    // SW проснулся, но показать не смог (текст ошибки уедет в модалку)
    await ackPush(shown, shown ? "" : errText);
    if (!shown) return;
    // R42: сообщаем открытым окнам, что пуш реально доставлен на устройство —
    // по всплывашке в приложении видно, что доставка работает, даже если
    // системная шторка подавлена настройками Android
    try {
      const cs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of cs) { try { c.postMessage({ type: "push-shown", title: p.title, tag: p.tag || "" }); } catch (e) { /* noop */ } }
    } catch (e) { /* noop */ }
  })());
});
