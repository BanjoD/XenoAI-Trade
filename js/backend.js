// XenoAI Trade — СЕРВЕРНЫЙ КЛИЕНТ (js/backend.js).
// Единая точка общения с бэкендом (Cloudflare Worker + Durable Object):
//   • вход по логину/паролю → HMAC-токен (30 дней, живёт в localStorage);
//   • состояние аккаунта тянетс с сервера (сервер — единственный источник правды);
//   • все действия аккаунта (сделки, настройки, ОЧИСТКА ИСТОРИИ, подписки пуша)
//     исполняются НА СЕРВЕРЕ — с любого устройства видно одно и то же;
//   • опрос состояния каждые 12 секунд + мгновенный опрос при фокусе/сети.
// Если бэкенд не задеплоен (пустой URL в backend-config.js) — модуль молчит, и
// платформа работает по прежней схеме (локальное состояние + облако textdb).
"use strict";

const Server = (() => {
  const LS_KEY = "xenoai_backend_session_v1";
  const cfg = (typeof window !== "undefined" && window.XENOAI_BACKEND) || { url: "" };

  const ctl = {
    url: String(cfg.url || "").replace(/\/+$/, ""),
    token: null,
    login: null,
    ready: false,
    lastOkAt: 0,
    lastError: null,
    lastPull: 0,
    pollTimer: null,
    busy: false,
    pending: false,
    meta: null,
    bootstrapped: false,
  };

  function configured() { return Boolean(ctl.url); }

  function loadSession() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d && d.token && d.login) { ctl.token = d.token; ctl.login = d.login; }
    } catch (e) { /* нет сессии */ }
  }
  function saveSession() {
    try {
      if (ctl.token) localStorage.setItem(LS_KEY, JSON.stringify({ token: ctl.token, login: ctl.login, at: Date.now() }));
      else localStorage.removeItem(LS_KEY);
    } catch (e) { /* noop */ }
  }
  loadSession();

  function active() { return Boolean(configured() && ctl.token); }
  function sessionLogin() { return active() ? ctl.login : null; }

  async function api(path, opts) {
    if (!configured()) throw new Error("бэкенд не настроен");
    const o = opts || {};
    const headers = Object.assign({ "Content-Type": "application/json" }, o.headers || {});
    if (ctl.token) headers.Authorization = "Bearer " + ctl.token;
    const res = await fetch(ctl.url + path, {
      method: o.method || "GET",
      headers,
      body: o.body ? JSON.stringify(o.body) : undefined,
      signal: AbortSignal.timeout(o.timeoutMs || 15000),
    });
    const j = await res.json().catch(() => ({}));
    if (res.status === 401) { ctl.token = null; saveSession(); throw new Error("токен истёк — войдите заново"); }
    if (!res.ok || j.ok === false) throw new Error(j.error || ("HTTP " + res.status));
    return j;
  }

  // ---------- вход ----------
  async function login(l, p) {
    if (!configured()) return { ok: false, error: "бэкенд не задеплоен" };
    try {
      const j = await api("/api/login", { method: "POST", body: { login: l, password: p }, timeoutMs: 12000 });
      ctl.token = j.token;
      ctl.login = j.login;
      saveSession();
      ctl.ready = false; // состояние подтянем при первом цикле
      return { ok: true, login: j.login };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
  function logout() {
    ctl.token = null; ctl.login = null; ctl.ready = false;
    saveSession();
  }

  // ---------- состояние ----------
  // pullInto(storeApply): GET /api/state → storeApply(archive) — серверная правда
  // применяется к локальному состоянию (applyArchive в store.js).
  async function pull(storeApply) {
    if (!active()) return false;
    if (ctl.busy) { ctl.pending = true; return false; }
    ctl.busy = true;
    try {
      const j = await api("/api/state", { timeoutMs: 12000 });
      ctl.lastOkAt = Date.now();
      ctl.lastError = null;
      ctl.lastPull = Date.now();
      ctl.ready = true;
      ctl.meta = { build: j.build, now: j.now };
      if (typeof storeApply === "function" && j.archive) storeApply(j.archive);
      return Boolean(j.archive);
    } catch (e) {
      ctl.lastError = String((e && e.message) || e);
      return false;
    } finally {
      ctl.busy = false;
      if (ctl.pending) { ctl.pending = false; setTimeout(() => { if (ctl.pollHook) ctl.pollHook(); }, 1500); }
    }
  }

  // действие на сервере: open/close/clearHistory/set/toggle*/pushSub...
  // Ответ несёт свежий архив — он и применяется (серверное исполнение, не локальная догадка).
  async function action(type, payload, storeApply) {
    if (!active()) return { ok: false, error: "бэкенд не активен" };
    try {
      const j = await api("/api/action", { method: "POST", body: { type, payload: payload || {} }, timeoutMs: 20000 });
      ctl.lastOkAt = Date.now();
      ctl.lastError = null;
      if (typeof storeApply === "function" && j.archive) storeApply(j.archive);
      return j.result || { ok: true };
    } catch (e) {
      const msg = String((e && e.message) || e);
      ctl.lastError = msg;
      return { ok: false, error: msg };
    }
  }

  // одноразовый перенос локального архива устройства на сервер (первый вход после деплоя)
  async function bootstrap(archive) {
    if (!active() || ctl.bootstrapped || !archive) return { ok: false };
    try {
      const j = await api("/api/bootstrap", { method: "POST", body: { archive }, timeoutMs: 20000 });
      ctl.bootstrapped = true;
      return j;
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // ---------- пуш-подписка: регистрация на сервере (пуши шлёт сервер) ----------
  async function pushSub(sub, ua) {
    if (!active() || !sub || !sub.endpoint) return { ok: false };
    return action("pushSub", { sub, ua: ua || "" });
  }
  async function pushUnsub(endpoint) {
    if (!active()) return { ok: false };
    return action("pushUnsub", { endpoint });
  }
  // R42: тестовый пуш с сервера по всем подпискам аккаунта (диагностика доставки)
  async function pushTest() {
    if (!active()) return { ok: false, error: "бэкенд не активен" };
    try {
      const j = await api("/api/push-test", { method: "POST", body: {}, timeoutMs: 30000 });
      return j;
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // R50: тестовое сообщение в резервный канал ntfy (диагностика доставки).
  // Ответ несёт свежий архив (с ntfy.last) — применяется как у action/glmCfg.
  async function ntfyTest(storeApply) {
    if (!active()) return { ok: false, error: "бэкенд не активен" };
    try {
      const j = await api("/api/ntfy-test", { method: "POST", body: {}, timeoutMs: 30000 });
      if (j && j.archive && typeof storeApply === "function") storeApply(j.archive);
      return j;
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // R49: конфиг GLM-аналитика сервера (включение/выключение 13-го фактора 24/7).
  // Ответ несёт свежий архив (с вердиктом GLM) — применяется как у action.
  async function glmCfg(payload, storeApply) {
    if (!active()) return { ok: false, error: "бэкенд не активен" };
    try {
      const j = await api("/api/glmcfg", { method: "POST", body: { payload: payload || {} }, timeoutMs: 40000 });
      ctl.lastOkAt = Date.now();
      if (typeof storeApply === "function" && j.archive) storeApply(j.archive);
      return j.result || { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // R51: ПОЛНАЯ СИНХРОНИЗАЦИЯ OKX — подключение/отключение ключей НА СЕРВЕРЕ.
  // Сервер сам проверяет ключи запросом баланса; секреты в браузер не возвращаются.
  async function okxCfg(payload, storeApply) {
    if (!active()) return { ok: false, error: "бэкенд не активен" };
    try {
      const j = await api("/api/okxcfg", { method: "POST", body: { payload: payload || {} }, timeoutMs: 45000 });
      ctl.lastOkAt = Date.now();
      if (typeof storeApply === "function" && j.archive) storeApply(j.archive);
      return j.result || { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // ---------- фоновый опрос ----------
  function startPolling(hook) {
    ctl.pollHook = hook;
    if (ctl.pollTimer || typeof setInterval !== "function") return;
    ctl.pollTimer = setInterval(() => { if (ctl.pollHook) ctl.pollHook(); }, 12000);
    if (typeof window !== "undefined" && window.addEventListener) {
      const kick = () => { if (ctl.pollHook) setTimeout(() => ctl.pollHook(), 300); };
      window.addEventListener("focus", kick);
      window.addEventListener("online", kick);
      document.addEventListener("visibilitychange", () => { if (!document.hidden) kick(); });
    }
  }

  function info() {
    return {
      configured: configured(), active: active(), url: ctl.url, login: ctl.login,
      ready: ctl.ready, lastOkAt: ctl.lastOkAt, lastPull: ctl.lastPull, lastError: ctl.lastError,
      build: (ctl.meta && ctl.meta.build) || cfg.build || "",
    };
  }

  return {
    configured, active, sessionLogin, login, logout,
    pull, action, glmCfg, okxCfg, bootstrap, pushSub, pushUnsub, pushTest, ntfyTest, startPolling, info,
    _ctl: ctl,
  };
})();

window.Server = Server;
