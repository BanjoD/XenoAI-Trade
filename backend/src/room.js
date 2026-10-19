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
} from "./account.js";
import { fetchTickers, fetchKlines, fetchTickerOne, fetchAggTrades } from "./market.js";
import { sendPush } from "./webpush.js";
import { DataLib } from "./core.js";

const WATCH_SYMS = DataLib.WATCHLIST.map((i) => i.sym);
const TEXTDB_BASE = "https://textdb.online/";
const TICK_MS = 2 * 60000;       // тик ИИ каждые 2 минуты
const NEWS_MS = 10 * 60000;      // новостная лента раз в 10 минут
const SCAN_PER_TICK = 8;         // монет в скане за тик (ротация по кругу ≈ каждые 6-7 мин на монету)
export const BUILD = "r40";

const PASSWORDS = { david: "ETH123aAgo", yura: "BTCmyB671" };

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
      });
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
        // перед торговым действием цены должны быть живыми (плейсмент проверяет свежесть)
        if (["open", "close"].includes(body.type) && (!b.prices || !Object.keys(b.prices).length)) {
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
        const pushes = await this.sendEvents(b.newEvents || []);
        b.newEvents = [];
        return json({ ok: res.ok, error: res.error || null, result: res, archive: this.state, pushes });
      }
      if (path === "/bootstrap" && req.method === "POST") {
        // одноразовый перенос локального архива устройства (первый вход на сервер):
        // union без потерь, после этого сервер авторитарен
        const body = await req.json();
        await this.loadState(login);
        if (body.archive && validArchive(body.archive)) {
          const merged = mergeArchives(this.state, body.archive);
          merged.login = this.state.login;
          merged.host = { id: "server", tag: "Сервер XenoAI", until: 9e15 };
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

      this.lastTickAt = Date.now();
      if (!this.state.degraded) this.lastTickOk = this.lastTickAt;
      this.lastError = b.tickLog.length ? b.tickLog[0] : null;

      await this.ctx.storage.put("lastBarClose", b.lastBarClose);

      const persisted = this._lastPersistFp !== fpOf(this.state) ? true : false;
      const preFp = this._lastPersistFp;
      await this.saveState();          // запись только если fp изменился
      await this.saveBrain();
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
    if (!subs.length || !events.length) return { sent: 0, dead: 0 };
    // потолок: 2 события за вызов (лимит исходящих запросов), самые свежие
    const list = events.filter((e) => e && e.notify && e.notify.kind).slice(0, 2);
    if (!list.length) return { sent: 0, dead: 0 };
    const deadEndpoints = [];
    let sent = 0;
    for (const ev of list) {
      const payload = {
        title: String(ev.title || "XenoAI Trade").slice(0, 110),
        body: String(ev.detail || "").slice(0, 260),
        tag: ev.tone === "bear" ? "xenoai-bear" : "xenoai",
        url: "./",
      };
      for (const sub of subs) {
        const r = await sendPush(sub, payload, { urgency: ev.tone === "bear" ? "high" : "normal", ttl: 7200, timeoutMs: 8000 });
        if (r.ok) sent++;
        else if (r.dead && !deadEndpoints.includes(sub.endpoint)) deadEndpoints.push(sub.endpoint);
      }
    }
    if (deadEndpoints.length) {
      this.state.pushSubs = (this.state.pushSubs || []).filter((s) => !deadEndpoints.includes(s.endpoint));
    }
    return { sent, dead: deadEndpoints.length };
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
