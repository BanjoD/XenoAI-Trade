// XenoAI Trade — системные уведомления + полноэкранный режим (PWA).
// Модуль самодостаточный: настройки живёт в отдельном ключе localStorage,
// событиями его кормит Store через шину Store.onNotify (см. store.js).
// Показ идёт через service worker (работает в фоне на Android/десктопе),
// с фолбэком на new Notification там, где SW нет.
"use strict";

const Notify = (() => {
  const LS_KEY = "xenoai_notify_v1";

  // какие события можно присылать: [ключ, название, описание] — порядок = порядок в настройках
  const EVENTS = [
    ["ai_open", "ИИ открывает сделку", "вход автопилота или сделка, открытая по сигналу ИИ"],
    ["ai_close", "ИИ закрывает сделку", "цель, стоп или сигнал выхода — с профитом или минусом"],
    ["ai_be", "ИИ перевёл в безубыток", "сделка дошла до +1R — стоп подтянут к входу, минус уже невозможен"],
    ["ai_flip", "ИИ переворачивает позицию", "флип: закрыл позицию и вошёл в обратную сторону"],
    ["threshold", "Авто-стоп сессии", "результат сессии достиг ±лимита — все ИИ-сделки закрыты"],
    ["autopilot", "Автопилот вкл/выкл", "переключение режима ИИ-автопилота и паузы после серии минусов"],
    ["signal", "Сигналы стратегий", "новые сигналы пяти стратегий сканера (частые)"],
    ["user_open", "Мои открытия", "демо-сделки, открытые вручную"],
    ["user_close", "Мои закрытия", "закрытие ваших сделок, включая стоп/цель"],
    ["live_order", "Реальные ордера", "ордер ушёл на биржу в реальном режиме"],
    ["lab", "Лаборатория", "сделки тестовых счетов стратегий (частые)"],
  ];

  const DEFAULTS = () => ({
    on: false,
    events: { ai_open: true, ai_close: true, ai_be: true, ai_flip: true, threshold: true, autopilot: true, signal: false, user_open: true, user_close: true, live_order: true, lab: false },
    minPnl: 0,      // присылать закрытия только если |профит| ≥ N ХРЮ (0 = все)
    sound: true,    // звук системного уведомления
    vibro: true,    // вибрация (Android)
    quiet: false,   // true = не беспокоить, когда приложение открыто на экране
  });

  let settings = load();

  function load() {
    const base = DEFAULTS();
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return base;
      const s = JSON.parse(raw);
      if (!s || typeof s !== "object") return base;
      const out = Object.assign(base, s);
      out.events = Object.assign(DEFAULTS().events, s.events || {});
      out.minPnl = Number.isFinite(Number(s.minPnl)) ? Math.max(0, Math.min(1000000, Math.round(Number(s.minPnl)))) : 0;
      return out;
    } catch (e) { return base; }
  }
  function persist() { try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch (e) { /* noop */ } }

  // ---------- возможности и разрешения ----------
  function supported() { return typeof window !== "undefined" && "Notification" in window; }
  function permission() {
    if (!supported()) return "unsupported";
    try { return Notification.permission; } catch (e) { return "unsupported"; }
  }
  // iOS: уведомления работают только в установленном на «Домой» приложении (iOS 16.4+)
  function isIOS() { return /iP(hone|ad|od)/.test(navigator.userAgent || "") || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); }
  function isStandalone() {
    return (window.matchMedia && (window.matchMedia("(display-mode: standalone)").matches || window.matchMedia("(display-mode: fullscreen)").matches || window.matchMedia("(display-mode: minimal-ui)").matches))
      || navigator.standalone === true;
  }
  function iosNeedsInstall() { return isIOS() && !isStandalone(); }

  // ---------- шина событий из Store ----------
  let storeHooked = false;
  function hookStore() {
    if (storeHooked || !window.Store || typeof Store.onNotify !== "function") return;
    storeHooked = true;
    Store.onNotify((kind, data) => handle(kind, data || {}));
  }
  function handle(kind, d) {
    if (!settings.on || permission() !== "granted") return;
    if (!settings.events[kind]) return;
    // фильтр мелких закрытий (порог в ХРЮ; курс 1 ХРЮ = $1)
    if (["ai_close", "user_close", "ai_flip", "threshold", "lab"].indexOf(kind) !== -1
      && settings.minPnl > 0 && Math.abs(Number(d.pnl) || 0) < settings.minPnl) return;
    if (settings.quiet && !document.hidden) return;
    show(d.title || "XenoAI Trade", d.body || "", { tag: kind + ":" + (d.sym || "—") });
  }

  // ---------- показ уведомления ----------
  async function show(title, body, opts) {
    if (!supported() || permission() !== "granted") return;
    const options = {
      body: body || "",
      tag: (opts && opts.tag) || undefined,
      icon: "icons/icon-192.png",
      badge: "icons/badge-96.png",
      silent: !settings.sound,
    };
    if (settings.vibro) options.vibrate = [90, 45, 90]; // без звука Android вибрацию подавит сам
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) { await reg.showNotification(title, options); return; }
      }
      // фолбэк: нет SW (например, file://) — обычное уведомление страницы
      const n = new Notification(title, options);
      if (settings.vibro && navigator.vibrate) { try { navigator.vibrate([90, 45, 90]); } catch (e) { /* noop */ } }
      return n;
    } catch (e) {
      try { return new Notification(title, { body: options.body }); } catch (e2) { /* noop */ }
    }
  }

  // ---------- включение/выключение ----------
  function requestPermission() {
    if (!supported()) return Promise.resolve("unsupported");
    try {
      const p = Notification.requestPermission();
      return p && typeof p.then === "function" ? p : Promise.resolve(p);
    } catch (e) { return Promise.resolve(Notification.permission); }
  }

  // включение мастером: запрашивает разрешение, при успехе включает и показывает тестовое
  function enable() {
    if (!supported()) return Promise.resolve({ ok: false, why: "Этот браузер не поддерживает системные уведомления (или сайт открыт как файл, а не по https/localhost)" });
    if (iosNeedsInstall()) return Promise.resolve({ ok: false, why: "На iPhone/iPad добавьте XenoAI Trade на экран «Домой» (Поделиться → «На экран Домой») и включите уведомления уже в установленном приложении — так требует iOS 16.4+" });
    if (permission() === "denied") return Promise.resolve({ ok: false, why: "Разрешение заблокировано. Разрешите уведомления для этого сайта в настройках браузера (значок замка в адресной строке)" });
    const after = () => {
      settings.on = true; persist();
      show("Уведомления включены", "XenoAI Trade сообщит о сделках ИИ, профите и авто-стопе", { tag: "system:on" });
      // R30: подписка Web Push создаётся сразу — пуши от Стража придут и при закрытом приложении
      return ensureSubscription().then((pr) => ({ ok: true, push: pr }));
    };
    if (permission() === "granted") return Promise.resolve().then(after);
    return requestPermission().then((p) => {
      if (p !== "granted") return { ok: false, why: "Разрешение не выдано — уведомления остались выключенными" };
      return after();
    });
  }
  function disable() { settings.on = false; persist(); }

  function setEvent(kind, val) { if (EVENTS.some((e) => e[0] === kind)) { settings.events[kind] = !!val; persist(); } }
  function set(key, val) { if (key in settings && key !== "events") { settings[key] = val; persist(); } }
  function setMinPnl(v) {
    const n = Math.round(Number(String(v).replace(/\s/g, "").replace(",", ".")) || 0);
    settings.minPnl = Math.max(0, Math.min(1000000, n)); persist();
  }
  function test() {
    if (!supported()) return { ok: false, why: "Браузер не поддерживает уведомления" };
    if (permission() !== "granted") return { ok: false, why: "Сначала включите уведомления" };
    show("Проверка уведомлений", "Так выглядит оповещение: ИИ купил BTC · сделка +34 ХРЮ (≈ +$34)", { tag: "test:" + Date.now() });
    return { ok: true };
  }

  // ---------- push на смартфон: НАТИВНЫЙ Web Push (без сторонних приложений) ----------
  // Требование пользователя: «для пушей нужно лишь предоставить разрешение и всё, не
  // должно быть никаких дополнительных действий». Так и сделано: разрешение → браузер
  // сам создаёт PushSubscription (VAPID-ключ платформы) → подписка сохраняется в архив
  // аккаунта и уезжает в облако синхронизации. Страж (GitHub Actions) читает подписки
  // и шлёт пуши о сделках прямо в браузер/PWA — даже когда приложение полностью закрыто
  // и выгружено из памяти. Никаких тем для копирования, сторонних программ и ручных шагов.
  const VAPID_PUBLIC = "BEwaHaeQPCSGfyskYFUA4rvij2rNV2NDBo8Gq54cHKVvwHNNsOb6fzUWjW_UdUBBMpY_NxsvZ5fwylHYPIq2PtE";

  function urlBase64ToUint8Array(b64) {
    let s = String(b64).replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const raw = atob(s);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function pushSupported() {
    return Boolean(supported() && window.PushManager && navigator.serviceWorker);
  }

  // синхронный кэш состояния подписки — им рисуется модалка (обновляется при каждом
  // асинхронном опросе/создании подписки: pushInfo/ensureSubscription)
  let pushCache = { on: false, endpoint: null, why: "проверяю…" };
  function getPushCache() { return pushCache; }

  // текущее состояние подписки устройства: { on, endpoint, why }
  async function pushInfo() {
    const res = await pushInfoRaw();
    pushCache = res;
    return res;
  }
  async function pushInfoRaw() {
    if (!pushSupported()) return { on: false, why: pushSupportedStop() };
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) return { on: false, why: "service worker ещё не готов" };
      const sub = await reg.pushManager.getSubscription();
      if (!sub) return { on: false, why: permission() === "granted" ? "подписка создаётся…" : "нужно разрешение на уведомления" };
      return { on: true, endpoint: sub.endpoint };
    } catch (e) { return { on: false, why: (e && e.message) || "ошибка подписки" }; }
  }

  function pushSupportedStop() {
    if (isIOS() && !isStandalone()) return "на iPhone/iPad сначала установите приложение на «Домой» (требование iOS 16.4+)";
    if (!window.PushManager) return "браузер не поддерживает Web Push";
    if (!supported()) return "браузер не поддерживает уведомления";
    return "сайт должен быть открыт по https (или localhost)";
  }

  // создаёт (или возвращает существующую) подписку и сохраняет её в аккаунт для Стража
  async function ensureSubscription() {
    if (!pushSupported()) { pushCache = { on: false, endpoint: null, why: pushSupportedStop() }; return pushCache; }
    if (permission() !== "granted") {
      pushCache = { on: false, endpoint: null, why: "нужно разрешение на уведомления" };
      return pushCache;
    }
    try {
      const reg = await (navigator.serviceWorker.ready || navigator.serviceWorker.getRegistration());
      if (!reg) return { ok: false, why: "service worker ещё не готов — откройте приложение ещё раз через пару секунд" };
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC),
        });
      }
      const raw = sub.toJSON();
      if (!raw || !raw.endpoint || !raw.keys || !raw.keys.p256dh || !raw.keys.auth) {
        return { ok: false, why: "браузер вернул неполную подписку" };
      }
      if (window.Store && typeof Store.addPushSub === "function") {
        const r = Store.addPushSub({ endpoint: raw.endpoint, keys: raw.keys });
        if (!r.ok) return { ok: false, why: r.error || "подписка не сохранена" };
      }
      pushCache = { on: true, endpoint: raw.endpoint, why: "" };
      return { ok: true, endpoint: raw.endpoint };
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (msg.indexOf("permission") !== -1 || msg.indexOf("denied") !== -1) {
        return { ok: false, why: "разрешение не выдано — уведомления заблокированы в браузере" };
      }
      pushCache = { on: false, endpoint: null, why: msg };
      return { ok: false, why: msg };
    }
  }

  // ---------- полноэкранный режим ----------
  function fsElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function fsSupported() {
    const el = document.documentElement;
    return Boolean(el.requestFullscreen || el.webkitRequestFullscreen);
  }
  function toggleFullscreen() {
    const el = document.documentElement;
    if (!fsElement()) {
      const req = el.requestFullscreen ? el.requestFullscreen({ navigationUI: "hide" })
        : el.webkitRequestFullscreen ? el.webkitRequestFullscreen()
        : null;
      if (!req) return Promise.resolve(false);
      return Promise.resolve(req).then(() => {
        // Android/Chrome: блокируем системную кнопку «назад» внутри полного экрана
        try { if (navigator.keyboard && navigator.keyboard.lock) navigator.keyboard.lock(["Escape"]); } catch (e) { /* noop */ }
        return true;
      }).catch(() => false);
    }
    try { if (navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock(); } catch (e) { /* noop */ }
    const exit = document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen ? document.webkitExitFullscreen() : null;
    return Promise.resolve(exit).then(() => false).catch(() => false);
  }

  // R32: САМОЗАЛЕЧИВАНИЕ ПОДПИСКИ. Диагноз R32: подписки умирают (410 Gone после
  // переустановки PWA/смены SW/чистки браузера) и больше не восстанавливаются —
  // «пуши работают только при первом заходе». Лечится циклом: пока разрешение
  // выдано, но живой подписки нет — создаём заново; живая подписка каждые 10 минут
  // перерегистрируется НА СЕРВЕРЕ (пуши отныне шлёт сервер, а не Страж).
  function pushHealthLoop() {
    if (pushHealthTimer || typeof setInterval !== "function") return;
    pushHealthTimer = setInterval(async () => {
      try {
        if (permission() !== "granted" || !pushSupported()) return;
        const reg = await navigator.serviceWorker.getRegistration();
        if (!reg) return;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
          // подписка умерла/исчезла — молча создаём новую (пользователь ничего не нажимает)
          await ensureSubscription().catch(() => {});
          return;
        }
        // живая подписка: перерегистрируем на сервере (heal потерь регистрации)
        if (window.Server && Server.active()) {
          const raw = sub.toJSON();
          if (raw && raw.endpoint && raw.keys) Server.pushSub({ endpoint: raw.endpoint, keys: raw.keys });
        }
      } catch (e) { /* канал не критичен */ }
    }, 10 * 60000);
  }
  let pushHealthTimer = null;

  function init() {
    hookStore();
    // R30: разрешение уже выдано ранее, а подписки нет (обновление страницы, сброс SW) —
    // восстанавливаем её молча: пользователю не нужно ничего нажимать повторно.
    // R32: три попытки с нарастающей задержкой (SW может быть ещё не готов) + вечный
    // цикл здоровья: умершая подписка восстанавливается сама.
    if (permission() === "granted" && pushSupported()) {
      const tryEnsure = (n) => {
        if (n <= 0) return;
        setTimeout(() => {
          (async () => {
            try {
              const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
              const hasSub = reg && await reg.pushManager.getSubscription();
              if (!hasSub) {
                const r = await ensureSubscription();
                if (r && r.ok) return;
              }
            } catch (e) { /* повторим */ }
            tryEnsure(n - 1);
          })();
        }, n === 3 ? 2500 : n === 2 ? 10000 : 25000);
      };
      tryEnsure(3);
      pushHealthLoop();
    }
  }

  return {
    init, EVENTS, getSettings() { return settings; },
    supported, permission, isIOS, isStandalone, iosNeedsInstall,
    enable, disable, setEvent, set, setMinPnl, test,
    pushSupported, pushInfo, getPushCache, ensureSubscription, // R30: нативный Web Push
    fsElement, fsSupported, toggleFullscreen,
  };
})();

window.Notify = Notify;
Notify.init();
