// XenoAI Trade — СЕРВЕР: Durable Object «Room» — один объект на аккаунт.
// Сильная консистентность (однопоточный исполнитель), персист в SQLite-хранилище DO,
// автономная торговля через alarm() каждые 2 минуты — работает при полностью закрытых
// браузерах (запрос пользователя: «ИИ должен управляться автономно на сервере»).
//
// Первый запуск: если в DO ещё нет состояния — аккаунт МИГРИРУЕТ из текстового облака
// textdb (детерминированный код синхронизации логина) + подтягивается глобальный мозг
// ИИ. Позиции, история, баланс и настройки пользователя переносятся без потерь.
"use strict";

import {
  AccountBrain, defaultArchive, normalizeBrain, validArchive, applyServerFields, fpOf, mergeArchives,
  adoptBrain, mergeBrainGlobal, mergeShadowGlobal, normalizeNtfy, NTFY_TOPIC_RE, normalizeOkx,
} from "./account.js";
import { fetchTickers, fetchKlines, fetchTickerOne, fetchAggTrades } from "./market.js";
import { sendPush } from "./webpush.js";
import {
  fetchUsdtBalance, marketBuyWithFill, marketSellWithFill, testKeys as okxTestKeys,
} from "./okx.js";
import { DataLib } from "./core.js";

const WATCH_SYMS = DataLib.WATCHLIST.map((i) => i.sym);
const TEXTDB_BASE = "https://textdb.online/";
const TICK_MS = 2 * 60000;       // тик ИИ каждые 2 минуты
const NEWS_MS = 10 * 60000;      // новостная лента раз в 10 минут
const SCAN_PER_TICK = 8;         // монет в скане за тик (ротация по кругу ≈ каждые 6-7 мин на монету)
const HUB_LOGIN = "__hub";       // R47: имя DO-хранилища ЕДИНОГО мозга ИИ (не аккаунт)
const HUB_SYNC_MS = 4 * 60000;   // синхронизация с общим мозгом не чаще раза в 4 минуты
export const BUILD = "r53";

const PASSWORDS = { david: "ETH123aAgo", yura: "BTCmyB671" };

const normalizeOkxDefault = (v) => normalizeOkx(v || null); // R51: нормализация публичного состояния OKX с дефолтом

// детерминированный код синхронизации логина (тот же алгоритм, что в js/auth.js):
// sha256("xenoai-sync-v1|<логин>|<пароль>") → первые 16 hex-символов
async function sha256hex(msg) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(buf)).map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
}
export async function syncCodeFor(login) {
  const lv = String(login || "").trim().toLowerCase();
  const hex = await sha256hex("xenoai-sync-v1|" + lv + "|" + (PASSWORDS[lv] || lv));
  return hex.slice(0, 4) + "-" + hex.slice(4, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16);
}

export function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this._login = null;
    this.state = null;      // персист-архив аккаунта
    this.brainObj = null;   // AccountBrain (рантайм поверх архива)
    this.globalBrain = null;
    this._ticking = false;
    this._lastPersistFp = null;
    this._alarmSet = false;   // будильник автономной торговли уже проверен/взведён
    this._scanIdx = 0;
    this.lastTickAt = 0;
    this.lastTickOk = 0;
    this.lastError = null;
    this.migrated = null;
  }

  // ---------- хранилище ----------
  async loadState(login) {
    if (this._login && login && this._login !== login) return json({ ok: false, error: "чужая комната" }, 403);
    if (login) this._login = login;
    if (this.state) return this.state;
    if (!this._login) {
      // alarm-путь без заголовка: логин должен был сохраниться ранее
      this._login = await this.ctx.storage.get("login").catch(() => null);
    }
    if (this._login) await this.ctx.storage.put("login", this._login).catch(() => {});
    // САМОЗАПУСК торговли: взводим будильник при первом же касании DO (любой запрос).
    // Раньше первый alarm ставил только cron-тик, но у cron всего ~30 с на waitUntil —
    // долгий тик (сеть бирж) гиб вместе с изолятoм, и торговля могла не начаться вовсе.
    // Будильник alarm() исполняется в собственном контексте DO (до 15 мин) — надёжно.
    await this.ensureAlarm();
    let stored = null;
    try { stored = await this.ctx.storage.get("state"); } catch (e) { /* новый DO */ }
    if (stored && validArchive(stored)) {
      this.state = stored;
    } else {
      this.state = await this.migrateFromTextdb();
      await this.saveState(true);
    }
    this._lastPersistFp = fpOf(this.state);
    return this.state;
  }

  async saveState(force) {
    if (!this.state) return;
    const fp = fpOf(this.state);
    if (!force && fp === this._lastPersistFp) return; // содержимое не изменилось — запись не тратим
    this._lastPersistFp = fp;
    try { await this.ctx.storage.put("state", this.state); } catch (e) {
      this.lastError = "сохранение: " + String((e && e.message) || e);
    }
  }

  async saveBrain() {
    if (this.globalBrain) {
      try { await this.ctx.storage.put("brain", this.globalBrain); } catch (e) { /* не критично */ }
    }
  }

  // будильник автономной торговли: если не взведён — взвести через TICK_MS
  async ensureAlarm() {
    if (this._alarmSet) return; // уже проверено в этом изоляте (alarm() перевзводит сам)
    try {
      const cur = await this.ctx.storage.getAlarm();
      if (cur == null) await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
      this._alarmSet = true;
    } catch (e) { /* следующий запрос повторит попытку */ }
  }

  // ---------- миграция из textdb (одноразовая) ----------
  async migrateFromTextdb() {
    const login = this._login || "unknown";
    const fresh = defaultArchive(login);
    const code = await syncCodeFor(login);
    try {
      const r = await fetch(TEXTDB_BASE + "xenoai-sync-" + code, { signal: AbortSignal.timeout(9000) });
      const txt = (await r.text()).trim();
      if (txt) {
        const remote = JSON.parse(txt);
        if (validArchive(remote)) {
          applyServerFields(fresh, remote);
          fresh.updatedAt = Date.now();
          this.migrated = { from: "textdb", rev: remote.rev || 0, balance: Math.round(remote.balance || 0) };
        }
      }
    } catch (e) { /* пусто/битое/нет сети — свежий аккаунт */ }
    // глобальный мозг ИИ (общая память всех устройств) — тоже из textdb
    try {
      const r2 = await fetch(TEXTDB_BASE + "xenoai-global-brain-a7x42", { signal: AbortSignal.timeout(9000) });
      const t2 = (await r2.text()).trim();
      if (t2) {
        const b = normalizeBrain(JSON.parse(t2));
        if ((b.trades || 0) > 0) this.globalBrain = b;
      }
    } catch (e) { /* мозг начнётся с нуля */ }
    fresh.events = [{
      id: "srv-init-" + Date.now(), ts: Date.now(), tone: "neutral",
      title: "Аккаунт переселён на сервер XenoAI Trade",
      detail: "торговый ИИ теперь живёт на сервере: открывает и закрывает сделки каждые 2 минуты 24/7 — браузер включать не нужно · с любого устройства видно одно и то же состояние"
    }, ...(fresh.events || [])].slice(0, 60);
    return fresh;
  }

  // ---------- мозг ----------
  async ensureBrain() {
    await this.loadState();
    if (!this.brainObj) {
      if (!this.globalBrain) {
        try {
          const b = await this.ctx.storage.get("brain");
          if (b) this.globalBrain = normalizeBrain(b);
        } catch (e) { /* нет */ }
      }
      this.brainObj = new AccountBrain(this.state, this.globalBrain || normalizeBrain(null), {
        fetchTickers, fetchKlines, fetchTickerOne, fetchAggTrades,
        // R51: клиент OKX для полной синхронизации (баланс, авто-покупка/продажа)
        okx: { fetchUsdtBalance, marketBuyWithFill, marketSellWithFill },
      });
      // R49: конфиг GLM-аналитика (с ключом) живёт в storage DO отдельно от архива:
      // /state отдаёт архив на все устройства — ключ не должен туда попадать
      try {
        const gc = await this.ctx.storage.get("glm");
        if (gc && typeof gc === "object") this.brainObj.glmCfg = gc;
      } catch (e) { /* нет конфига — GLM выключен */ }
      // R51: ключи OKX (полная синхронизация) — тоже только в storage DO
      try {
        const oc = await this.ctx.storage.get("okx");
        if (oc && typeof oc === "object" && oc.apiKey) this.brainObj.okxCfg = oc;
      } catch (e) { /* нет ключей — синхронизация выключена */ }
      // R47 — КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ ПАМЯТИ ИИ: AccountBrain делает normalizeBrain(brain)
      // — это КОПИЯ, и всё обучение (learnFromClosed → веса/симстаты/порог/уроки) шло в неё.
      // saveBrain() при этом сохранял this.globalBrain — ОРИГИНАЛ, который обучение не
      // трогает. Итог: память ИИ НЕ ПЕРСИСТИЛАСЬ — каждый перезапуск DO (каждый деплой,
      // выселение изолята) сбрасывал мозг к снапшоту textdb эпохи миграции. Теперь
      // globalBrain указывает на РАБОЧИЙ объект мозга: сохраняется и отдаётся хабу ровно
      // то, чему ИИ научился.
      this.globalBrain = this.brainObj.brain;
      // восстановление цен из архива — ручным действиям не нужно ждать первого тика
      if (this.state.prices) {
        const now = Date.now();
        for (const sym of Object.keys(this.state.prices)) {
          this.brainObj.prices[sym] = { sym, price: this.state.prices[sym], chg24h: 0, vol24: 0, ts: now };
        }
      }
      // lastBarClose переживает перезапуск DO (не «перезакрывать» уже закрытые свечи)
      try {
        const lbc = await this.ctx.storage.get("lastBarClose");
        if (lbc) this.brainObj.lastBarClose = lbc;
      } catch (e) { /* нет */ }
    }
    return this.brainObj;
  }

  // ---------- маршруты DO (внутренние, после проверки токена роутером) ----------
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const login = req.headers.get("x-login") || "";
    try {
      // R47: синхронизация с ЕДИНЫМ мозгом ИИ. Вызывают ТОЛЬКО комнаты аккаунтов
      // напрямую через биндинг ROOMS (внутренний маршрут, наружу не светится).
      // Хранилище «__hub» — отдельный DO, не аккаунт: торговлю не ведёт, алармов не ставит.
      if (path === "/brain-sync" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        return json(await this.hubSync(body));
      }
      // R47: подтверждение от service worker устройства «пуш реально показан».
      // Публичный роутер раздаёт его по комнатам аккаунтов без токена (SW не имеет
      // сессии); в комнате матчим подписку по хвосту endpoint.
      if (path === "/push-ack" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        return json(this.pushAck(body || {}));
      }
      if (path === "/state") {
        await this.loadState(login);
        const b = await this.ensureBrain();
        return json({ ok: true, archive: this.state, build: BUILD, now: Date.now(), migrated: this.migrated });
      }
      if (path === "/meta") {
        await this.loadState(login);
        return json({ ok: true, login: this.state.login, build: BUILD, lastTickAt: this.lastTickAt, lastTickOk: this.lastTickOk, lastError: this.lastError, autonomous: true, tickMs: TICK_MS });
      }
      if (path === "/action" && req.method === "POST") {
        const body = await req.json();
        await this.loadState(login);
        const b = await this.ensureBrain();
        // перед торговым действием цены должны быть живыми (плейсмент проверяет свежесть);
        // R49: liveOrder тоже — от цены биржи считается PnL реальных сделок
        if (["open", "close", "liveOrder"].includes(body.type) && (!b.prices || !Object.keys(b.prices).length)) {
          try {
            const pairs = DataLib.WATCHLIST.filter((i) => i.pair).map((i) => i.pair);
            const { rows } = await fetchTickers(pairs);
            const now = Date.now();
            for (const t of rows) {
              if (!(Number(t.lastPrice) > 0)) continue;
              const sym = t.symbol === "TONUSDT" ? "GRAM" : String(t.symbol).replace(/USDT$/, "");
              b.prices[sym] = { sym, price: Number(t.lastPrice), chg24h: Number(t.priceChangePercent) || 0, vol24: Number(t.quoteVolume) || 0, ts: now };
              this.state.prices = this.state.prices || {};
              this.state.prices[sym] = b.prices[sym].price;
            }
          } catch (e) { /* цены недоступны — действие честно получит ошибку свежести */ }
        }
        const res = b.action(body.type, body.payload);
        if (res.ok) { this.state.updatedAt = Date.now(); this.state.rev = (this.state.rev || 0) + 1; await this.saveState(); }
        // R51: очередь реальных ордеров OKX — разгребаем сразу после действия
        // (вход в live-режиме ставит покупку; закрытие — продажу). okxSync —
        // принудительное обновление баланса мимо 5-минутного троттла.
        try {
          let guard = 0;
          while (await b.drainRealQueue()) { if (++guard >= 5) break; }
          const synced = await b.okxBalanceSync(body.type === "okxSync");
          if (synced) { this.state.updatedAt = Date.now(); await this.saveState(); }
        } catch (e) { this.lastError = "okx-drain: " + String((e && e.message) || e); }
        if (b.newEvents.length) { this.state.updatedAt = Date.now(); await this.saveState(); }
        const pushes = await this.sendEvents(b.newEvents || []);
        b.newEvents = [];
        return json({ ok: res.ok, error: res.error || null, result: res, archive: this.state, pushes });
      }
      // R49: конфиг GLM-аналитика сервера — отдельно от action (async: сразу спрашиваем
      // модель и возвращаем вердикт/ошибку в ответе кнопки). Ключ хранится в storage DO.
      if (path === "/glmcfg" && req.method === "POST") {
        const body = await req.json();
        await this.loadState(login);
        const b = await this.ensureBrain();
        const res = await this.glmCfgSave(b, body.payload || {});
        if (res.ok) { this.state.updatedAt = Date.now(); this.state.rev = (this.state.rev || 0) + 1; await this.saveState(); }
        const pushes = await this.sendEvents(b.newEvents || []);
        b.newEvents = [];
        return json({ ok: res.ok, error: res.error || null, result: res, archive: this.state, pushes });
      }
      // R51: ПОЛНАЯ СИНХРОНИЗАЦИЯ OKX — подключение/отключение ключей (async: сразу
      // проверяем ключи запросом баланса). Ключи живут ТОЛЬКО в storage DO.
      if (path === "/okxcfg" && req.method === "POST") {
        const body = await req.json();
        await this.loadState(login);
        const b = await this.ensureBrain();
        const res = await this.okxCfgSave(b, body.payload || {});
        if (res.ok) { this.state.updatedAt = Date.now(); this.state.rev = (this.state.rev || 0) + 1; await this.saveState(); }
        const pushes = await this.sendEvents(b.newEvents || []);
        b.newEvents = [];
        return json({ ok: res.ok, error: res.error || null, result: res, archive: this.state, pushes });
      }
      if (path === "/bootstrap" && req.method === "POST") {
        // одноразовый перенос локального архива устройства (первый вход на сервер):
        // union без потерь, после этого сервер авторитарен.
        // R44: защита от повторных слияний — клиент шлёт bootstrap при КАЖДОМ холодном
        // старте (флаг только в памяти страницы). Повторное слияние устаревшего архива
        // дрейфует баланс (pnl сделок «открылась и закрылась в промежутке» теряется).
        // Поэтому первое успешное слияние ставит clientMergedAt (персистится в стейте),
        // и все последующие вызовы возвращают текущее состояние без изменений.
        const body = await req.json();
        await this.loadState(login);
        if (this.state.clientMergedAt) {
          return json({ ok: true, archive: this.state, skipped: true, mergedAt: this.state.clientMergedAt });
        }
        if (body.archive && validArchive(body.archive)) {
          const merged = mergeArchives(this.state, body.archive);
          merged.login = this.state.login;
          merged.host = { id: "server", tag: "Сервер XenoAI", until: 9e15 };
          merged.clientMergedAt = Date.now(); // R44: сервер авторитарен с этого момента
          this.state = merged;
          this.brainObj = null; // пересобрать рантайм на новом архиве
          this.state.updatedAt = Date.now();
          this.state.rev = (this.state.rev || 0) + 1;
          await this.saveState(true);
          return json({ ok: true, archive: this.state });
        }
        return json({ ok: false, error: "архив не прошёл валидацию" });
      }
      if (path === "/tick" && req.method === "POST") {
        await this.loadState(login);
        const res = await this.runTick();
        return json({ ok: true, ...res });
      }
      // R42: тестовый пуш с сервера — нажатие кнопки в модалке уведомлений.
      // Ответ содержит по-подписочный результат доставки (статус FCM) — по нему видно,
      // где обрыв: 201 = доставлено в браузер устройства (если шторка пуста — дело в
      // разрешении Android/Chrome на устройстве), 410 = подписка мертва (пересоздаётся сама).
      if (path === "/pushtest" && req.method === "POST") {
        await this.loadState(login);
        const res = await this.pushTest();
        await this.saveState();
        return json({ ok: true, ...res, subs: ((this.state.pushSubs) || []).length });
      }
      // R50: тестовое сообщение в резервный канал ntfy (кнопка «Проверка ntfy»)
      if (path === "/ntfytest" && req.method === "POST") {
        await this.loadState(login);
        const res = await this.ntfyTest();
        await this.saveState();
        return json({ ok: true, ...res, ntfy: this.state.ntfy || null });
      }
      return json({ ok: false, error: "неизвестный маршрут DO: " + path }, 404);
    } catch (e) {
      this.lastError = String((e && e.message) || e);
      return json({ ok: false, error: this.lastError }, 500);
    }
  }

  // ---------- ТИК: автономная торговля ----------
  async runTick() {
    if (this._ticking) return { skipped: true, why: "предыдущий тик ещё идёт" };
    this._ticking = true;
    const t0 = Date.now();
    try {
      const b = await this.ensureBrain();
      // ротация скана: позиции всегда + порция круга по монетам
      const posSyms = Array.from(new Set(this.state.userPositions.map((p) => p.sym)));
      const scanSyms = [];
      for (let i = 0; i < Math.min(SCAN_PER_TICK, WATCH_SYMS.length); i++) {
        scanSyms.push(WATCH_SYMS[(this._scanIdx + i) % WATCH_SYMS.length]);
      }
      this._scanIdx = (this._scanIdx + Math.min(SCAN_PER_TICK, WATCH_SYMS.length)) % WATCH_SYMS.length;
      const all = Array.from(new Set([...posSyms, ...scanSyms]));

      // новости раз в NEWS_MS (фактор «Новостной фон» + новостная защита)
      if (!this.state.news || Date.now() - (this.state.news.ts || 0) > NEWS_MS) {
        try {
          const items = await fetchNews();
          if (items && items.length) {
            this.state.news = { items, ts: Date.now(), source: "cointelegraph" };
            b.news = { items, ts: Date.now() };
          }
        } catch (e) { /* лента недоступна — ИИ работает по индикаторам */ }
      } else {
        b.news = { items: this.state.news.items, ts: this.state.news.ts };
      }

      await b.tick({ scanSyms: all });

      // R51: ПОЛНАЯ СИНХРОНИЗАЦИЯ OKX — очередь реальных ордеров + баланс биржи.
      // Каждые 2 минуты по одной задаче: покупка/продажа на OKX-споте переживает
      // перезапуск DO (очередь персистится в архиве).
      try {
        let guard = 0;
        while (await b.drainRealQueue()) { if (++guard >= 3) break; }
        await b.okxBalanceSync();
      } catch (e) { this.lastError = "okx: " + String((e && e.message) || e); }

      this.lastTickAt = Date.now();
      if (!this.state.degraded) this.lastTickOk = this.lastTickAt;
      this.lastError = b.tickLog.length ? b.tickLog[0] : null;

      await this.ctx.storage.put("lastBarClose", b.lastBarClose);

      const persisted = this._lastPersistFp !== fpOf(this.state) ? true : false;
      const preFp = this._lastPersistFp;
      await this.saveState();          // запись только если fp изменился
      await this.saveBrain();
      await this.hubMaybeSync();       // R47: тяга/отдача общего мозга ИИ (дебаунс 4 мин)
      const pushes = await this.sendEvents(b.newEvents || []);
      b.newEvents = [];
      return {
        ms: Date.now() - t0, scan: all.length, positions: this.state.userPositions.length,
        balance: Math.round(this.state.balance), equity: Math.round(b.totalEquity()),
        pushes, persisted: this._lastPersistFp !== preFp || persisted,
        degraded: Boolean(this.state.degraded), log: b.tickLog.slice(0, 3),
        migrated: this.migrated,
      };
    } finally {
      this._ticking = false;
    }
  }

  // ---------- Web Push по событиям ----------
  async sendEvents(events) {
    const subs = ((this.state && this.state.pushSubs) || []).filter((s) => s && s.endpoint && s.keys);
    if ((!subs.length && !this.ntfyActive()) || !events.length) return { sent: 0, dead: 0, ntfy: 0 };
    // потолок: 2 события за вызов (лимит исходящих запросов), самые свежие
    // R46: потолок поднят 2 → 4 события за вызов (было 2 — при нескольких сделках в тик часть уведомлений терялась)
    const list = events.filter((e) => e && e.notify && e.notify.kind).slice(0, 4);
    if (!list.length) return { sent: 0, dead: 0, ntfy: 0 };
    const deadEndpoints = [];
    let sent = 0;
    for (const ev of list) {
      const payload = {
        title: String(ev.title || "XenoAI Trade").slice(0, 110),
        body: String(ev.detail || "").slice(0, 260),
        tag: ev.tone === "bear" ? "xenoai-bear" : "xenoai",
        url: "./",
      };
      // R46 — КЛЮЧЕВОЙ ФИКС «пуши не приходят при закрытом приложении (Android)»:
      // торговые события шли с Urgency: normal — FCM/Chrome откладывает такие пуши,
      // пока устройство спит в Doze (приложение закрыто, экран погашен) — они застревали
      // и с TTL 2 ч сгорали. Тестовый пуш (pushTest) шёл с high — потому «тест доходит,
      // реальные нет». Теперь ВСЕ торговые события — high (будят устройство немедленно),
      // TTL 12 ч (переживает ночной Doze). Уровень событий высокий — сигнал важен сейчас.
      for (const sub of subs) {
        const r = await sendPush(sub, payload, { urgency: "high", ttl: 43200, timeoutMs: 8000 });
        // R42: запоминаем результат последней доставки — виден в модалке уведомлений
        sub.last = { ts: Date.now(), status: r.status || 0, ok: Boolean(r.ok) };
        if (r.ok) sent++;
        else if (r.dead && !deadEndpoints.includes(sub.endpoint)) deadEndpoints.push(sub.endpoint);
      }
    }
    if (deadEndpoints.length) {
      this.state.pushSubs = (this.state.pushSubs || []).filter((s) => !deadEndpoints.includes(s.endpoint));
    }
    // R50: резервный канал ntfy — тот же список событий, независимо от Web Push.
    // lab/signal исключены (частые; по умолчанию выключены и в локальных настройках).
    const ntfySent = await this.sendNtfy(list);
    return { sent, dead: deadEndpoints.length, ntfy: ntfySent };
  }

  // ---------- R50: резервный канал доставки · ntfy ----------
  // Работает ПОМИМО Web Push: приложение ntfy (Google Play/F-Droid) получает сообщения
  // собственным соединением с ntfy.sh и показывает их при полностью закрытом браузере —
  // туда, где Chrome не будит service worker в фоне (агрессивные OEM-менеджеры батареи).
  // Единственная «авторизация» — несгадываемая случайная тема (как пароль из 32^10).
  ntfyActive() {
    const n = this.state && this.state.ntfy;
    return Boolean(n && n.on && NTFY_TOPIC_RE.test(String(n.topic || "")));
  }

  ntfyTone(ev) {
    if (ev.tone === "bear") return { priority: "high", tags: "chart_with_downwards_trend" };
    if (ev.tone === "bull") return { priority: "default", tags: "chart_with_upwards_trend" };
    return { priority: "default", tags: "bell" };
  }

  async ntfySend(title, body, tone) {
    const n = normalizeNtfy(this.state && this.state.ntfy);
    if (!n.on || !n.topic) return { ok: false, why: "канал выключен" };
    const t = this.ntfyTone({ tone });
    let status = 0, ok = false, err = "";
    try {
      const r = await fetch("https://ntfy.sh/" + n.topic, {
        method: "POST",
        headers: { "X-Title": String(title || "XenoAI Trade").slice(0, 200), "X-Priority": t.priority, "X-Tags": t.tags },
        body: String(body || "").slice(0, 900) || "Событие XenoAI Trade",
        signal: AbortSignal.timeout(8000),
      });
      status = r.status; ok = r.ok;
      if (!r.ok) err = "HTTP " + r.status + (r.status === 429 ? " (лимит ntfy.sh)" : "");
    } catch (e) {
      err = String((e && e.message) || e).slice(0, 120);
    }
    this.state.ntfy = normalizeNtfy({ on: true, topic: n.topic, last: { ts: Date.now(), status, ok } });
    return { ok, status, err };
  }

  async sendNtfy(events) {
    if (!this.ntfyActive()) return 0;
    let n = 0;
    for (const ev of events) {
      // частые события не дублируем в ntfy: лаборатория и сигналы сканера шумят
      const kind = ev && ev.notify && ev.notify.kind;
      if (kind === "lab" || kind === "signal") continue;
      const r = await this.ntfySend(ev.title, ev.detail || ev.title, ev.tone);
      if (r.ok) n++;
    }
    return n;
  }

  // R50: тестовое сообщение в ntfy (кнопка «Проверка ntfy» в модалке)
  async ntfyTest() {
    if (!this.ntfyActive()) return { ok: false, error: "Канал ntfy выключен или тема не задана" };
    const r = await this.ntfySend(
      "XenoAI Trade · проверка резервного канала",
      "Если это сообщение пришло в приложение ntfy — резервный канал работает и будет доставлять события сделок даже при полностью закрытом браузере. " + new Date().toISOString().slice(11, 19) + " UTC",
      "neutral",
    );
    // ok = запрос выполнен; sent = ntfy.sh принял (HTTP 200); status/err — детали для UI
    return { ok: true, sent: Boolean(r.ok), status: r.status || 0, err: r.err || "" };
  }


  // ---------- R42: тестовый пуш по всем подпискам аккаунта (кнопка диагностики) ----------
  async pushTest() {
    const subs = ((this.state && this.state.pushSubs) || []).filter((s) => s && s.endpoint && s.keys);
    const payload = {
      title: "Тестовый пуш XenoAI",
      body: "Доставка с сервера работает · " + new Date().toISOString().slice(11, 16) + " UTC. Если видите это в шторке — пуши до устройства доходят.",
      tag: "srvtest:" + Date.now(),
      url: "./",
    };
    const deadEndpoints = [];
    const results = [];
    for (const sub of subs) {
      const r = await sendPush(sub, payload, { urgency: "high", ttl: 600, timeoutMs: 10000 });
      sub.last = { ts: Date.now(), status: r.status || 0, ok: Boolean(r.ok) };
      if (r.dead) deadEndpoints.push(sub.endpoint);
      results.push({ endpoint: String(sub.endpoint).slice(-14), status: r.status || 0, ok: Boolean(r.ok), dead: Boolean(r.dead), why: r.why || "" });
    }
    if (deadEndpoints.length) {
      this.state.pushSubs = (this.state.pushSubs || []).filter((s) => !deadEndpoints.includes(s.endpoint));
    }
    return { results, sent: results.filter((r) => r.ok).length };
  }

  // ---------- R49: GLM-аналитик на сервере (конфиг из модалки GLM) ----------
  // Ключ хранится ТОЛЬКО в storage DO (в архив не попадает — /state раздаётся устройствам).
  // on=false конфиг не стирает: повторное включение не требует повторно вставлять ключ.
  async glmCfgSave(b, p) {
    const endpoint = String(p.endpoint || "").trim();
    const model = String(p.model || "").trim() || "glm-4-flash";
    const apiKey = String(p.apiKey || "").trim();
    const on = Boolean(p.on);
    if (endpoint && !/^https:\/\/.+/.test(endpoint)) return { ok: false, error: "Endpoint должен начинаться с https://" };
    if (on && !apiKey && !(b.glmCfg && b.glmCfg.apiKey)) return { ok: false, error: "Вставьте API-ключ (bigmodel.cn или z.ai) — без ключа модель не спросить" };
    const cur = b.glmCfg || {};
    const cfg = {
      endpoint: endpoint || cur.endpoint || "https://api.z.ai/api/paas/v4/chat/completions",
      model,
      apiKey: apiKey || cur.apiKey || "",
      on,
      ts: Date.now(),
    };
    if (on && !cfg.apiKey) return { ok: false, error: "Ключ не найден" };
    b.glmCfg = cfg;
    try { await this.ctx.storage.put("glm", cfg); } catch (e) { /* повторим при следующем сохранении */ }
    let verdict = null;
    if (on) {
      verdict = await b.glmAsk(true).catch(() => null);
      if (b.glmVerdict && b.glmVerdict.status === "error") {
        return { ok: true, warning: b.glmVerdict.error || "модель ответила ошибкой", verdict: b.glmVerdict };
      }
      if (!b.glmEventsSeen) {
        b.glmEventsSeen = true;
        b.pushEvent({ tone: "neutral", title: "GLM-аналитик подключён на сервере", detail: `языковая модель (${cfg.model}) стала 13-м фактором ансамбля 24/7 — вердикт обновляется каждые 10 минут даже при закрытом браузере` });
      }
    } else {
      b.pushEvent({ tone: "neutral", title: "GLM-аналитик на сервере выключен", detail: "12 рыночных факторов работают как раньше; ключ сохранён — включить можно в один клик" });
    }
    return { ok: true, verdict };
  }

  // ---------- R51: ПОЛНАЯ СИНХРОНИЗАЦИЯ OKX (конфиг из модалки реального рынка) ----------
  // Ключи хранятся ТОЛЬКО в storage DO (в архив не попадают — /state раздаётся устройствам).
  // Подключение = тест ключей запросом реального баланса; отключение стирает ключи.
  async okxCfgSave(b, p) {
    const apiKey = String(p.apiKey || "").trim();
    const secret = String(p.secret || "").trim();
    const pass = String(p.pass || "").trim();
    const on = p.on !== false;
    const mask = (k) => (k && k.length > 8 ? k.slice(0, 4) + "…" + k.slice(-4) : "…");
    if (!on) {
      // отключение: ключи стираются насовсем (повторное включение требует их заново)
      b.okxCfg = null;
      try { await this.ctx.storage.delete("okx"); } catch (e) { /* noop */ }
      b.a.okx = normalizeOkxDefault();
      b.pushEvent({ tone: "neutral", title: "Полная синхронизация OKX отключена", detail: "ключи стёрты с сервера; реальные ордера больше не отправляются (биржа ничего не хранит — деньги всегда были у вас)" });
      return { ok: true };
    }
    if (!apiKey || !secret || !pass) return { ok: false, error: "Нужны все три: API-ключ, секрет и passphrase (OKX всегда требует passphrase)" };
    const cfg = { apiKey, secret, pass, ts: Date.now() };
    // тест ключей живым запросом баланса — не работает ключ, синхронизация не включится
    let bal = null;
    try {
      bal = await okxTestKeys(cfg);
    } catch (e) {
      return { ok: false, error: "OKX не принял ключи: " + String((e && e.message) || e) };
    }
    b.okxCfg = cfg;
    try { await this.ctx.storage.put("okx", cfg); } catch (e) { /* повторим при следующем сохранении */ }
    b.a.okx = normalizeOkxDefault({
      on: true, auto: p.auto !== false, mask: mask(apiKey),
      balanceUSDT: bal.usdt, balanceEq: bal.total, ts: Date.now(), lastSync: Date.now(), lastErr: "",
    });
    b.pushEvent({
      tone: "bull",
      title: `OKX подключён к серверу · баланс ${Math.round(bal.usdt * 100) / 100} USDT`,
      detail: "ПОЛНАЯ СИНХРОНИЗАЦИЯ активна: баланс биржи виден в платформе; входы в сделки (сигналы, автопилот, вручную) покупают токен на OKX-споте реальными USDT, закрытия продают его обратно — всё автоматически, 24/7, даже с выключенным браузером",
      notify: { kind: "okx_conn" },
    });
    return { ok: true, usdt: bal.usdt };
  }

  // ---------- R47: ЕДИНЫЙ МОЗГ ИИ — хаб-синхронизация ----------
  // Носитель общего мозга — DO «__hub» (тот же класс Room, но не аккаунт: /brain-sync
  // читает/пишет напрямую storage, не трогая аккаунт-стейт и не взводя алармы).
  // Комната: отдаёт свой мозг+тень, получает слитый общий — и продолжает учиться на нём.
  async hubSync(body) {
    try {
      const cur = await this.ctx.storage.get("gbrain").catch(() => null);
      const curSh = await this.ctx.storage.get("gshadow").catch(() => null);
      const g = normalizeBrain(cur || null);
      const gs = mergeShadowGlobal(curSh && typeof curSh === "object" ? curSh : {}, null);
      const inc = body && body.brain && typeof body.brain === "object" ? body.brain : null;
      const incSh = body && body.shadow && typeof body.shadow === "object" ? body.shadow : null;
      if (inc) mergeBrainGlobal(g, inc, String((body && body.from) || "?"));
      if (incSh) mergeShadowGlobal(gs, incSh);
      await this.ctx.storage.put("gbrain", g);
      await this.ctx.storage.put("gshadow", gs);
      return { ok: true, brain: g, shadow: gs };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  async hubMaybeSync() {
    try {
      if (!this.env || !this.env.ROOMS) return;           // Node-тесты без биндингов
      if (this._login === HUB_LOGIN) return;              // хаб сам с собой не синхронизируется
      const now = Date.now();
      if (this._hubSyncAt && now - this._hubSyncAt < HUB_SYNC_MS) return;
      this._hubSyncAt = now;
      const sh = this.state && this.state.shadow ? this.state.shadow : {};
      const payload = {
        from: this._login || "?",
        brain: this.globalBrain || null,
        shadow: { stats: sh.stats || {}, trust: sh.trust || {}, skip: sh.skip || {} },
      };
      const stub = this.env.ROOMS.get(this.env.ROOMS.idFromName(HUB_LOGIN));
      const r = await stub.fetch("https://room/brain-sync", { method: "POST", body: JSON.stringify(payload) });
      const j = await r.json().catch(() => null);
      if (!j || !j.ok) return;
      // применяем общий мозг НА МЕСТЕ (AccountBrain держит ссылку на объект)
      if (j.brain && this.globalBrain) {
        adoptBrain(this.globalBrain, normalizeBrain(j.brain));
        await this.saveBrain();
      }
      // общая тень (доверие по монетам/пропуски) — max-слияние в стейт аккаунта
      if (j.shadow && this.state) {
        const before = JSON.stringify(this.state.shadow && this.state.shadow.trust || {}) + JSON.stringify(this.state.shadow && this.state.shadow.skip || {});
        mergeShadowGlobal(this.state.shadow = this.state.shadow || { list: [], stats: {}, trust: {}, skip: {} }, j.shadow);
        const after = JSON.stringify(this.state.shadow.trust || {}) + JSON.stringify(this.state.shadow.skip || {});
        if (before !== after) await this.saveState();
      }
    } catch (e) {
      // хаб недоступен — не критично, повторим на следующем тике
      try { this.tickLog.push("hubSync: " + String((e && e.message) || e).slice(0, 80)); } catch (e2) { /* noop */ }
    }
  }

  // ---------- R47: ack от service worker устройства ----------
  pushAck(body) {
    const tail = String(body.tail || "");
    if (tail.length < 6) return { ok: false, error: "tail" };
    let matched = 0;
    for (const s of (this.state && this.state.pushSubs) || []) {
      if (String(s.endpoint || "").slice(-tail.length) !== tail) continue;
      s.lastAck = { ts: Date.now(), ok: Boolean(body.ok), err: String(body.err || "").slice(0, 120) };
      matched++;
    }
    if (matched) this.saveState().catch(() => {});
    return { ok: true, matched };
  }

  // ---------- alarm: само-возобновляющийся таймер автономной торговли ----------
  async alarm() {
    this._alarmSet = true;
    try { await this.runTick(); } catch (e) { this.lastError = String((e && e.message) || e); }
    await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }
}

// новостная лента (тот же rss2json, что в браузере)
async function fetchNews() {
  const feeds = [
    "https://api.rss2json.com/v1/api.json?rss_url=https%3A%2F%2Fcointelegraph.com%2Frss",
    "https://api.rss2json.com/v1/api.json?rss_url=https%3A%2F%2Fwww.coindesk.com%2Farc%2Foutboundfeeds%2Frss%2F",
  ];
  for (const feed of feeds) {
    try {
      const j = await fetch(feed, { signal: AbortSignal.timeout(9000) }).then((r) => r.json());
      if (!j || j.status !== "ok" || !Array.isArray(j.items)) continue;
      const items = j.items.slice(0, 30).map((it) => ({
        title: stripHtml(it.title),
        body: stripHtml(it.description || it.content).slice(0, 420),
        ts: Date.parse(it.pubDate) || Date.now(),
        link: it.link || "",
        source: (j.feed && j.feed.title) || "",
      })).filter((it) => it.title);
      if (items.length) return items;
    } catch (e) { /* следующая лента */ }
  }
  return null;
}
function stripHtml(s) {
  return String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
