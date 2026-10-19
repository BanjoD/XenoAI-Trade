// XenoAI Trade — СЕРВЕР: мозг аккаунта (порт торговой логики js/store.js без браузерных частей).
// Здесь живёт тот же автопилот: ансамбль 13 факторов, порог входа (база 74, калибровка окном
// 12 сделок), сессия с авто-стопом ±лимит, тихий час по монете, пауза после серии минусов,
// политика выходов «тело + N%», трейлинг, лаборатория, обучение (глобальная память ИИ).
// Отличия от браузера: состояние одно и авторитарное (никаких слияний устройств),
// исполнителем всегда является сервер, события собираются для Web Push.
"use strict";

import { Engine, Fmt, DataLib } from "./core.js";

const { WATCHLIST, BY_SYM, DEFAULT_PRICES } = DataLib;
const WATCH_SYMS = WATCHLIST.map((i) => i.sym);
const PAIR_TO_SYM = {};
WATCHLIST.forEach((i) => { if (i.pair) PAIR_TO_SYM[i.pair] = i.sym; });

const TRADE_ACCOUNTS = ["david", "yura"];
const AI_MAX_POS = 5;
const AI_MIN_SIZE = 10;
const AI_STOP_BAN_MS = 4 * 3600e3;

export function defaultBrain() {
  return {
    v: 1,
    weights: null,
    rel: {},
    symStats: {},
    confThreshold: 74, // база порога входа — требование пользователя: >74% открывается само
    trades: 0, wins: 0, losses: 0,
    lessons: [],
    wFlags: {},
    updatedAt: 0,
  };
}

export function normalizeBrain(b) {
  const base = defaultBrain();
  if (!b || typeof b !== "object" || b.v !== 1) return base;
  const br = { ...base, ...b, v: 1 };
  if (!br.rel || typeof br.rel !== "object") br.rel = {};
  if (!Array.isArray(br.lessons)) br.lessons = [];
  if (!br.symStats || typeof br.symStats !== "object") br.symStats = {};
  if (!br.wFlags || typeof br.wFlags !== "object") br.wFlags = {};
  if (!Number.isFinite(br.trades) || br.trades < 0) { br.trades = 0; br.wins = 0; br.losses = 0; }
  if (!Number.isFinite(br.wins) || br.wins < 0) br.wins = 0;
  if (!Number.isFinite(br.losses) || br.losses < 0) br.losses = 0;
  if (!Number.isFinite(br.confThreshold)) br.confThreshold = 74;
  br.confThreshold = Math.max(70, Math.min(80, Math.round(br.confThreshold)));
  return br;
}

// «отпечаток» архива — как fpOf в store.js: состав баланса/позиций/истории/настроек.
// Меняется только на реальных изменениях; по нему решаем, есть ли что сохранять.
export function fpOf(a) {
  if (!a || typeof a !== "object") return "";
  const c0 = (a.userClosed || [])[0] || {};
  const e0 = (a.events || [])[0] || {};
  const cu = a.clearedU || [], cl = a.clearedL || [];
  return [
    a.balance,
    (a.userPositions || []).map((p) => p.id + ":" + (p.stop || 0) + ":" + (p.mt || 0)).sort().join(","),
    (a.userClosed || []).length + ":" + (c0.id || ""),
    (a.events || []).length + ":" + (e0.id || ""),
    cu.length + ":" + (cu.length ? cu[cu.length - 1] : ""),
    cl.length + ":" + (cl.length ? cl[cl.length - 1] : ""),
    a.maxDeal, a.maxTotal, a.aiThreshold, a.aiPosMode,
    a.failPct,
    (a.pushSubs || []).length,
    a.mode, a.autoTrade ? 1 : 0, a.aiAuto ? 1 : 0, a.aiAutoLive ? 1 : 0,
  ].join("|");
}

export function pidOfClosed(c) {
  return (c && c.pid) || String((c && c.id) || "").replace(/-c\d+$/, "");
}

// слияние архивов для ОДНОРАЗОВОГО миграционного залёта (клиент отдал свой локальный
// архив при первом входе на сервер): история и события — union по id, позиции — union,
// баланс согласован. После миграции сервер авторитарен: слияний больше не будет.
export function mergeArchives(a, b) {
  if (!a || typeof a !== "object") return b;
  if (!b || typeof b !== "object") return a;
  const main = ((b.updatedAt || 0) > (a.updatedAt || 0)) ? b : a;
  const other = main === b ? a : b;
  const out = JSON.parse(JSON.stringify(main));

  const mergeClosed = (listA, listB, cap) => {
    const byPid = new Map();
    const add = (c) => {
      if (!c || !c.id) return;
      const pid = pidOfClosed(c);
      if (!pid) return;
      const cur = byPid.get(pid);
      if (!cur || (c.closedAt || 0) < (cur.closedAt || 0)) byPid.set(pid, c);
    };
    (listA || []).forEach(add);
    (listB || []).forEach(add);
    return Array.from(byPid.values()).sort((x, y) => (y.closedAt || 0) - (x.closedAt || 0)).slice(0, cap);
  };
  out.userClosed = mergeClosed(a.userClosed, b.userClosed, 400);
  out.labClosed = mergeClosed(a.labClosed, b.labClosed, 400);

  const closedPids = new Set(out.userClosed.map(pidOfClosed).filter(Boolean));
  const labClosedPids = new Set(out.labClosed.map(pidOfClosed).filter(Boolean));
  const mergeOpen = (aPos, bPos, closedSet) => {
    const byId = new Map();
    const put = (p) => {
      if (!p || !p.id) return;
      const cur = byId.get(p.id);
      if (!cur || ((p.mt || 0) > (cur.mt || 0))) byId.set(p.id, p);
    };
    (aPos || []).forEach(put);
    (bPos || []).forEach(put);
    const res = [];
    for (const p of byId.values()) if (!closedSet.has(p.id)) res.push(p);
    return res;
  };
  out.userPositions = mergeOpen(a.userPositions, b.userPositions, closedPids);
  out.labPositions = mergeOpen(a.labPositions, b.labPositions, labClosedPids);

  let bal = main.balance;
  const mainOpenIds = new Set((main.userPositions || []).map((p) => p.id));
  const outOpenIds = new Set(out.userPositions.map((p) => p.id));
  for (const p of out.userPositions) if (!mainOpenIds.has(p.id)) bal -= (p.size || 0);
  for (const p of main.userPositions || []) {
    if (outOpenIds.has(p.id)) continue;
    const c = out.userClosed.find((x) => pidOfClosed(x) === p.id);
    if (c) bal += (p.size || 0) + (c.pnl || 0);
  }
  out.balance = bal;

  const seenE = new Set((out.events || []).map((e) => e.id));
  (other.events || []).forEach((e) => { if (e && e.id && !seenE.has(e.id)) out.events.push(e); });
  out.events = (out.events || []).sort((x, y) => (y.ts || 0) - (x.ts || 0)).slice(0, 80);

  out.pushSubs = mergePushSubs(a.pushSubs, b.pushSubs);
  out.clearedU = Array.from(new Set([...(a.clearedU || []), ...(b.clearedU || [])])).slice(-800);
  out.clearedL = Array.from(new Set([...(a.clearedL || []), ...(b.clearedL || [])])).slice(-800);
  if (out.clearedU.length) {
    const t = new Set(out.clearedU);
    out.userClosed = (out.userClosed || []).filter((c) => !t.has(c.id));
  }
  if (out.clearedL.length) {
    const t = new Set(out.clearedL);
    out.labClosed = (out.labClosed || []).filter((c) => !t.has(c.id));
  }
  const ha = a.host && a.host.id ? a.host : null;
  const hb = b.host && b.host.id ? b.host : null;
  out.host = !ha ? hb : !hb ? ha : (((hb.until || 0) >= (ha.until || 0)) ? hb : ha);
  out.rev = Math.max(a.rev || 0, b.rev || 0);
  out.updatedAt = Math.max(a.updatedAt || 0, b.updatedAt || 0);
  return out;
}

export function mergePushSubs(aSubs, bSubs) {
  const byEp = new Map();
  const add = (s) => {
    if (!s || !s.endpoint || !s.keys || !s.keys.p256dh || !s.keys.auth) return;
    const cur = byEp.get(s.endpoint);
    if (!cur || ((s.ts || 0) > (cur.ts || 0))) byEp.set(s.endpoint, s);
  };
  (aSubs || []).forEach(add);
  (bSubs || []).forEach(add);
  return Array.from(byEp.values()).sort((x, y) => (y.ts || 0) - (x.ts || 0)).slice(0, 8);
}

// R43: «ТЕНЕВАЯ ТОРГОВЛЯ» (по мотивам поста Sova/Таповича t.me/tapovich_gram/7512):
// журнал отказов ИИ — кандидат был, вход не состоялся (порог/фильтр/лимит/пауза).
// Через горизонт часов каждый отказ проверяется по факту: отказ ПРАВИЛЬНЫЙ (монета
// пошла бы в минус) или ПРОПУСТИЛИ профит. Тапович: 49 из 50 отказов верны —
// после отказа монеты упали на 10–30%. Теперь наша платформа считает то же самое.
export const SHADOW_HORIZON_MS = 8 * 3600e3; // горизонт оценки отказа — 8 часов
const SHADOW_MAX = 60;                       // сколько записей храним в архиве
const SHADOW_GAP_MS = 3 * 3600e3;            // антидубль: одна запись sym+side раз в 3 часа
const SHADOW_DEADZONE = 1.0;                 // |движение| < 1% за горизонт — «мимо кассы»
// Медвежий режим (тот самый «фильтр, который зарубил почти всё»): BTC −3% за 24ч
// или ≥70% вотчлиста в красе → порог входа +6 — в падении торгуем только отборное.
const BEAR_GATE = { btc24h: -3, breadth: 0.7, bump: 6 };

function defaultShadow() {
  return { list: [], stats: { right: 0, wrong: 0, flat: 0, avoidedSum: 0, avoidedN: 0, since: Date.now() } };
}

function normalizeShadow(s) {
  const out = defaultShadow();
  if (!s || typeof s !== "object") return out;
  if (s.stats && typeof s.stats === "object") {
    for (const k of ["right", "wrong", "flat", "avoidedSum", "avoidedN"]) {
      const v = Number(s.stats[k]); if (Number.isFinite(v) && v >= 0) out.stats[k] = v;
    }
    if (Number(s.stats.since) > 0) out.stats.since = Number(s.stats.since);
  }
  if (Array.isArray(s.list)) {
    out.list = s.list.filter((e) => e && typeof e.id === "string" && e.sym && (e.side === "лонг" || e.side === "шорт")
      && typeof e.price === "number" && e.price > 0 && typeof e.ts === "number")
      .slice(0, SHADOW_MAX).map((e) => ({
        id: String(e.id).slice(0, 24), ts: e.ts, sym: String(e.sym).slice(0, 12), side: e.side,
        price: e.price, conf: Number(e.conf) || 0, whyCode: String(e.whyCode || "").slice(0, 16),
        why: String(e.why || "").slice(0, 160),
        evalTs: Number(e.evalTs) || null, hypPct: Number.isFinite(Number(e.hypPct)) ? Number(e.hypPct) : null,
        minPct: Number.isFinite(Number(e.minPct)) ? Number(e.minPct) : null,
        maxPct: Number.isFinite(Number(e.maxPct)) ? Number(e.maxPct) : null,
        verdict: e.verdict === "right" || e.verdict === "wrong" || e.verdict === "flat" ? e.verdict : null,
      }));
  }
  return out;
}

// ================= свежее состояние аккаунта =================
export function defaultArchive(login) {
  const labAccounts = Engine.mkLabAccounts();
  return {
    v: 3,
    login,
    rev: 0,
    updatedAt: Date.now(),
    balance: 10000,
    startBalance: 10000,
    userPositions: [],
    userClosed: [],
    labAccounts,
    labPositions: [],
    labClosed: [],
    events: [],
    autoTrade: true,
    labAutoMigrated: true,
    equityHist: [],
    mode: "demo",
    aiAuto: true,
    aiAutoLive: false,
    liveOrders: [],
    aiSession: null,
    aiStop: null,
    aiThreshold: 50,
    failPct: 50,
    aiMaxPos: 5,
    aiPosMode: "auto",
    maxDeal: 1000,
    maxTotal: 5000,
    lastCatchUp: Date.now(),
    lastScanAt: 0,
    aiCooldownUntil: 0,
    aiCooldownSeen: 0,
    aiBan: {},
    aiLastEntryTs: 0,
    aiRelaxAt: 0,
    clearedU: [],
    clearedL: [],
    pushSubs: [],
    host: { id: "server", tag: "Сервер XenoAI", until: 9e15 }, // исполнитель — всегда сервер
    aiIdeas: [],
    shadow: defaultShadow(), // R43: теневая торговля — журнал отказов ИИ и их проверка временем
  };
}

// валидация приходящего архива (клиентский бустрап / миграция textdb)
export function validArchive(d) {
  return Boolean(d && typeof d === "object" && Array.isArray(d.userClosed) && typeof d.balance === "number"
    && (!d.login || TRADE_ACCOUNTS.includes(String(d.login).toLowerCase())));
}

export function applyServerFields(a, d) {
  // перенос полей из чужого архива с сохранением структуры сервера (host остаётся сервером)
  if (typeof d.balance === "number") a.balance = d.balance;
  if (typeof d.startBalance === "number") a.startBalance = d.startBalance;
  if (Array.isArray(d.userPositions)) a.userPositions = d.userPositions;
  if (Array.isArray(d.userClosed)) a.userClosed = d.userClosed.slice(0, 400);
  if (Array.isArray(d.labAccounts) && d.labAccounts.length === Engine.STRATEGIES.length) a.labAccounts = d.labAccounts;
  if (Array.isArray(d.labPositions)) a.labPositions = d.labPositions;
  if (Array.isArray(d.labClosed)) a.labClosed = d.labClosed.slice(0, 400);
  if (Array.isArray(d.events)) a.events = d.events.slice(0, 80);
  if (Array.isArray(d.equityHist)) a.equityHist = d.equityHist.slice(-300);
  if (typeof d.autoTrade === "boolean") a.autoTrade = d.labAutoMigrated ? d.autoTrade : true;
  if (d.mode === "demo" || d.mode === "live") a.mode = d.mode;
  if (typeof d.aiAuto === "boolean") a.aiAuto = d.aiAuto;
  if (typeof d.aiAutoLive === "boolean") a.aiAutoLive = d.aiAutoLive;
  if (Array.isArray(d.liveOrders)) a.liveOrders = d.liveOrders.slice(0, 50);
  if (d.aiSession && typeof d.aiSession.startEquity === "number") a.aiSession = d.aiSession;
  if (d.aiStop && (d.aiStop.reason === "profit" || d.aiStop.reason === "loss")) a.aiStop = d.aiStop;
  if (typeof d.aiThreshold === "number" && d.aiThreshold >= 5 && d.aiThreshold <= 500) a.aiThreshold = d.aiThreshold;
  if (typeof d.failPct === "number" && d.failPct >= 0 && d.failPct <= 200) a.failPct = d.failPct;
  if (typeof d.aiMaxPos === "number" && d.aiMaxPos >= 1 && d.aiMaxPos <= 8) a.aiMaxPos = d.aiMaxPos;
  if (typeof d.maxDeal === "number" && d.maxDeal >= 5 && d.maxDeal <= 100000) a.maxDeal = d.maxDeal;
  if (typeof d.maxTotal === "number" && d.maxTotal >= 5 && d.maxTotal <= 1000000) a.maxTotal = d.maxTotal;
  if (d.aiPosMode === "auto" || (typeof d.aiPosMode === "number" && d.aiPosMode >= 1 && d.aiPosMode <= 8)) a.aiPosMode = d.aiPosMode;
  if (typeof d.lastCatchUp === "number" && d.lastCatchUp > 0) a.lastCatchUp = d.lastCatchUp;
  if (typeof d.lastScanAt === "number" && d.lastScanAt > 0) a.lastScanAt = d.lastScanAt;
  if (typeof d.aiCooldownUntil === "number" && d.aiCooldownUntil > 0) a.aiCooldownUntil = d.aiCooldownUntil;
  if (typeof d.aiCooldownSeen === "number" && d.aiCooldownSeen > 0) a.aiCooldownSeen = d.aiCooldownSeen;
  if (d.aiBan && typeof d.aiBan === "object") {
    const clean = {};
    for (const k of Object.keys(d.aiBan)) if (typeof d.aiBan[k] === "number" && d.aiBan[k] > Date.now()) clean[k] = d.aiBan[k];
    a.aiBan = { ...a.aiBan, ...clean };
  }
  if (typeof d.aiLastEntryTs === "number" && d.aiLastEntryTs > (a.aiLastEntryTs || 0)) a.aiLastEntryTs = d.aiLastEntryTs;
  if (typeof d.aiRelaxAt === "number" && d.aiRelaxAt > 0) a.aiRelaxAt = d.aiRelaxAt;
  if (Array.isArray(d.clearedU)) a.clearedU = d.clearedU.slice(-800);
  if (Array.isArray(d.clearedL)) a.clearedL = d.clearedL.slice(-800);
  if (Array.isArray(d.aiIdeas)) a.aiIdeas = d.aiIdeas.filter((i) => i && i.sym && i.res && typeof i.res.verdict === "string").slice(0, 8);
  if (d.shadow) a.shadow = normalizeShadow(d.shadow); // R43: теневая торговля
  if (Array.isArray(d.pushSubs)) a.pushSubs = d.pushSubs.filter((s) => s && typeof s.endpoint === "string" && s.endpoint.indexOf("https://") === 0 && s.keys && s.keys.p256dh && s.keys.auth).slice(0, 8);
  if (Array.isArray(d.userClosed) && a.clearedU.length) {
    const t = new Set(a.clearedU);
    a.userClosed = a.userClosed.filter((c) => !t.has(c.id));
  }
  if (Array.isArray(d.labClosed) && a.clearedL.length) {
    const t = new Set(a.clearedL);
    a.labClosed = a.labClosed.filter((c) => !t.has(c.id));
  }
  a.host = { id: "server", tag: "Сервер XenoAI", until: 9e15 };
  return a;
}

// ================= САМ ТОРГОВЫЙ МОЗГ =================
// Класс держит рантайм (цены/свечи/новости/киты — не персистятся) вокруг персист-архива.
export class AccountBrain {
  constructor(archive, brain, hooks) {
    this.a = archive;           // персист-архив (объект, мутируется)
    this.brain = normalizeBrain(brain);
    this.hooks = hooks || {};   // { fetchKlines, fetchAggTrades, log() }
    this.prices = {};           // sym → {price, chg24h, vol24, ts}
    this.bars = {};             // sym → массив 15м-свечей
    this.news = { items: [], ts: 0 };
    this.whales = {};
    this.lastBarClose = {};     // sym → openTime последней закрытой свечи
    this._aiLastEntryAt = 0;
    this._flipAt = {};
    this.lastSignalKey = "";
    this.newEvents = [];        // события текущего тика (для пушей)
    this.tickLog = [];
    this._bear = false;         // R43: медвежий режим (пересчитывается каждый тик)
    this._bearOn = false;       // R43: флаг перехода в медвежий режим (для одноразового события)
  }

  price(sym) { const p = this.prices[sym]; return p && p.price ? p.price : (this.a.prices && this.a.prices[sym]) || null; }

  // ---------- события ----------
  pushEvent(e, tsOverride) {
    const id = e.id || `e${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.a.events = [{ ...e, id, ts: tsOverride || Date.now() }, ...this.a.events].slice(0, 60);
    if (e.notify && e.notify.kind) this.newEvents.push({ ...e, id, ts: tsOverride || Date.now() });
  }

  // ---------- лимиты и гварды (порт store.js) ----------
  aiDealCap() { const v = Number(this.a.maxDeal); return Number.isFinite(v) ? Math.max(5, Math.min(100000, Math.round(v))) : 1000; }
  aiTotalCap() {
    const v = Number(this.a.maxTotal), d = this.aiDealCap();
    return Number.isFinite(v) ? Math.max(d, Math.min(1000000, Math.round(v))) : Math.max(d, 5000);
  }
  openPositionsSum() { return this.a.userPositions.reduce((s, p) => s + (p.size || 0), 0); }
  aiTotalRemain() { return Math.max(0, this.aiTotalCap() - this.openPositionsSum()); }
  autoMaxPos() { return Math.max(1, Math.min(8, Math.floor(this.aiTotalCap() / this.aiDealCap()))); }
  effMaxPos() {
    const m = this.a.aiPosMode;
    if (m === "auto" || typeof m !== "number") return this.autoMaxPos();
    return Math.max(1, Math.min(8, Math.round(m)));
  }
  aiKellyFrac() {
    const b = this.brain;
    // сглаженный винрейт (Лаплас, априор 50%); Kelly для RR 1:2: f* = 1.5p − 0.5,
    // четверть и кламп 2..10% — ровно как в браузере (store.js)
    const p = ((b.wins || 0) + 3) / ((b.trades || 0) + 6);
    const f = 1.5 * p - 0.5;
    return Math.max(0.02, Math.min(0.1, 0.25 * Math.max(0, f)));
  }
  aiSizeCalc() {
    const cap = this.aiDealCap();
    const remain = this.aiTotalRemain();
    let size = Math.round(this.a.balance * this.aiKellyFrac());
    size = Math.min(size, cap, Math.round(remain), Math.round(this.a.balance));
    const floor = Math.min(AI_MIN_SIZE, cap);
    if (!Number.isFinite(size) || size < floor) {
      if (this.a.balance >= floor && remain >= floor) size = floor;
      else return { size: 0, why: "не хватает свободных хрювен или суммарного лимита" };
    }
    if (size <= 0) return { size: 0, why: "нулевой размер" };
    return { size, why: "ок" };
  }
  aiLimitPct() { const v = Number(this.a.aiThreshold); return Number.isFinite(v) ? Math.max(5, Math.min(500, v)) : 50; }

  scamFilter(sym) {
    const p = this.prices[sym];
    if (!p || !p.price) return { ok: false, why: "нет цены" };
    if (!p.ts || Date.now() - p.ts > 120000) return { ok: false, why: "цена не обновляется" };
    if (p.vol24 && p.vol24 < 3e6) return { ok: false, why: `низкий объём $${(p.vol24 / 1e6).toFixed(1)}M` };
    if (Math.abs(p.chg24h) > 35) return { ok: false, why: `аномалия 24ч ${p.chg24h > 0 ? "+" : "−"}${Math.abs(p.chg24h).toFixed(0)}%` };
    return { ok: true };
  }
  newsGuard(sym) {
    if (!this.news.items || !this.news.items.length) return { ok: true, why: "" };
    const ns = Engine.newsSentiment(this.news.items, sym);
    if (ns.coinItems && ns.coin <= -0.55) return { ok: false, why: `новостной риск: медвежий фон по ${sym}` };
    if (ns.fresh && ns.global <= -0.7) return { ok: false, why: "новостной риск: медвежий фон всего рынка" };
    return { ok: true, why: "" };
  }
  combineGuard(sym) {
    const g = this.scamFilter(sym);
    if (!g.ok) return g;
    return this.newsGuard(sym);
  }
  riskGuard(res) {
    if (!res) return { ok: false, why: "нет расчёта" };
    if (res.riskPct > 6) return { ok: false, why: `волатильность взрывная: риск ${res.riskPct.toFixed(1)}% на 15м-бар` };
    if (res.riskPct < 0.45) return { ok: false, why: `ход слишком мал (${res.riskPct.toFixed(2)}%): круговая комиссия 0.1% съест результат` };
    const netRR = ((res.targetPct || 0) - 0.1) / ((res.riskPct || 0) + 0.1);
    if (!(netRR >= 1.5)) return { ok: false, why: `с учётом комиссии 0.1% соотношение цель/риск всего ${netRR.toFixed(2)} — вход не окупается` };
    if (res.flashRatio > 3.5) return { ok: false, why: `аномальная свеча ×${res.flashRatio.toFixed(1)} к ATR — вспышка или манипуляция` };
    return { ok: true, why: "ок" };
  }
  heatGuard() {
    const bal = this.a.balance, inMarket = this.openPositionsSum();
    if (bal > 0 && inMarket / bal > 0.6) return { ok: false, why: `портфель перегрет: ${Math.round((inMarket / bal) * 100)}% баланса в позициях` };
    return { ok: true, why: "ок" };
  }
  aiLossStreak() {
    let n = 0;
    for (const c of this.a.userClosed) { if (c.strategy !== "ai") continue; if (c.pnl < 0) n++; else break; }
    return n;
  }
  // ================= R43: ТЕНЕВАЯ ТОРГОВЛЯ =================
  // Отказ: кандидат с направлением был, вход не состоялся. Пишем причину и цену решения,
  // через горизонт часов проверяем фактом: отказ правильный или упустили профит.
  shadowLog(sym, res, whyCode, why) {
    if (!this.a.shadow || !Array.isArray(this.a.shadow.list)) this.a.shadow = defaultShadow();
    const list = this.a.shadow.list;
    const prev = list.find((x) => x.sym === sym && x.side === res.verdict);
    if (prev && (!prev.verdict || Date.now() - prev.ts < SHADOW_GAP_MS)) return; // открытая запись или свежий отказ — не дублируем
    const price = this.price(sym);
    if (!(price > 0)) return;
    list.unshift({
      id: "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ts: Date.now(), sym, side: res.verdict, price,
      conf: res.confidence || 0,
      whyCode: String(whyCode || "").slice(0, 16),
      why: String(why || "").slice(0, 160),
      evalTs: null, hypPct: null, minPct: null, maxPct: null, verdict: null,
    });
    this.a.shadow.list = list.slice(0, SHADOW_MAX);
  }

  // каждый тик: обновляем экстремумы по неразобранным отказам, разбираем достигшие горизонта
  shadowTick() {
    let sh = this.a.shadow;
    if (!sh || !Array.isArray(sh.list)) this.a.shadow = sh = defaultShadow();
    const now = Date.now();
    for (const e of sh.list) {
      const price = this.price(e.sym);
      if (!(price > 0)) continue;
      const dir = e.side === "шорт" ? -1 : 1;
      const hyp = ((price / e.price - 1) * 100) * dir; // каким был бы итог гипотетической сделки, %
      e.minPct = e.minPct == null ? hyp : Math.min(e.minPct, hyp);
      e.maxPct = e.maxPct == null ? hyp : Math.max(e.maxPct, hyp);
      if (e.verdict == null && now - e.ts >= SHADOW_HORIZON_MS) {
        e.evalTs = now;
        e.hypPct = Math.round(hyp * 10) / 10;
        e.verdict = hyp <= -SHADOW_DEADZONE ? "right" : hyp >= SHADOW_DEADZONE ? "wrong" : "flat";
        const st = sh.stats = sh.stats || { right: 0, wrong: 0, flat: 0, avoidedSum: 0, avoidedN: 0, since: now };
        if (e.verdict === "right") { st.right = (st.right || 0) + 1; st.avoidedSum = (st.avoidedSum || 0) + Math.abs(hyp); st.avoidedN = (st.avoidedN || 0) + 1; }
        else if (e.verdict === "wrong") st.wrong = (st.wrong || 0) + 1;
        else st.flat = (st.flat || 0) + 1;
      }
    }
  }

  // медвежий режим: BTC глубоко в красе за 24ч или подавляющая часть вотчлиста падает.
  // Ширина считается только по достаточной выборке (≥10 монет с данными) — на прогретом
  // кэше первого тика доля «всё в красе» из одной-двух монет не должна включать режим.
  bearGate() {
    const btc = this.prices.BTC;
    const chg = btc && Number.isFinite(btc.chg24h) ? btc.chg24h : 0;
    let down = 0, n = 0;
    for (const sym of WATCH_SYMS) {
      const t = this.prices[sym];
      if (t && Number.isFinite(t.chg24h)) { n++; if (t.chg24h < 0) down++; }
    }
    const breadth = n >= 10 ? down / n : 0;
    return { bear: chg <= BEAR_GATE.btc24h || breadth >= BEAR_GATE.breadth, chg, breadth };
  }

  symBias(sym) {
    const st = this.brain.symStats[sym];
    if (!st || st.n < 3) return 0;
    if (st.streak >= 3) return 3;
    if (st.streak <= -3) return -Math.min(10, 2 * Math.abs(st.streak));
    return 0;
  }
  aiWhaleBias(sym) {
    const list = this.whales[sym];
    if (!list || !list.length) return null;
    const now = Date.now();
    let buy = 0, sell = 0;
    for (const w of list) {
      if (!w.time || now - w.time > 60 * 60000) continue;
      if (w.side === "buy") buy += w.notional; else sell += w.notional;
    }
    const total = buy + sell;
    if (total < 50000) return null;
    const net = buy - sell;
    const dir = Math.max(-1, Math.min(1, net / 200000));
    if (Math.abs(dir) < 0.08) return null;
    return { dir, detail: `за час перевес ${net > 0 ? "покупок" : "продаж"} китов $${Fmt.fmtNum(Math.round(Math.abs(net) / 1000))}K из $${Fmt.fmtNum(Math.round(total / 1000))}K оборота` };
  }

  effAuto() { return this.a.mode === "live" ? !!this.a.aiAutoLive : !!this.a.aiAuto; }
  totalEquity() {
    let v = this.a.balance;
    for (const p of this.a.userPositions) {
      const price = this.price(p.sym) || p.entry;
      v += p.size + Engine.positionPnl(p, price).pnl;
    }
    return v;
  }

  // ---------- обучение (порт learnFromClosed) ----------
  pushLesson(text) {
    this.brain.lessons = [{ ts: Date.now(), text }, ...this.brain.lessons].slice(0, 24);
  }
  learnFromClosed(c, isLab) {
    if (!c) return;
    const brain = this.brain;
    const isAi = c.strategy === "ai";
    const labTrade = Boolean(isLab || (c.ai && c.ai.lab));
    const hasFactors = Boolean(c.ai && Array.isArray(c.ai.factors) && c.ai.factors.length);
    const won = c.pnl >= 0;
    if (isAi) { brain.trades++; if (won) brain.wins++; else brain.losses++; }
    if (hasFactors) {
      const sideSign = c.side === "лонг" ? 1 : -1;
      const outcomeSign = sideSign * (won ? 1 : -1);
      const stepUp = labTrade ? 0.022 : 0.045;
      const stepDn = labTrade ? 0.037 : 0.075;
      for (const f of c.ai.factors) {
        if (!f || !f.key || !f.dir) continue;
        const agree = (f.dir > 0 ? 1 : -1) === outcomeSign;
        const cur = brain.rel[f.key] == null ? 1 : brain.rel[f.key];
        const next = Math.max(0.55, Math.min(1.5, cur + (agree ? stepUp : -stepDn) * Math.min(1, Math.abs(f.dir))));
        brain.rel[f.key] = next;
      }
      const base = Engine.AI_BASE_WEIGHTS;
      let sum = 0;
      const weights = {};
      for (const k in base) { weights[k] = base[k] * (brain.rel[k] == null ? 1 : brain.rel[k]); sum += weights[k]; }
      if (sum > 0) for (const k in weights) weights[k] = weights[k] / sum;
      brain.weights = weights;
      const labels = { trend: "Тренд", rsi: "RSI", macd: "MACD", bb: "Боллинджер", ichi: "Ишимоку", vol: "Объём", roc: "Импульс", news: "Новости", adx: "ADX", stoch: "Стохастик", htf: "Старший ТФ", whale: "Киты", glm: "GLM" };
      for (const k in base) {
        const d = weights[k] / base[k] - 1;
        if (Math.abs(d) < 0.1) continue;
        const flag = k + (d < 0 ? "dn" : "up");
        if (brain.wFlags[flag]) continue;
        brain.wFlags[flag] = 1;
        this.pushLesson(d < 0
          ? `ослабил «${labels[k] || k}» (${base[k].toFixed(2)} → ${weights[k].toFixed(2)}): фактор ошибался в похожих сделках`
          : `усилил «${labels[k] || k}» (${base[k].toFixed(2)} → ${weights[k].toFixed(2)}): фактор чаще других был прав`);
      }
    }
    if (labTrade && !won) {
      const strat = Engine.STRATEGIES.find((x) => x.id === c.strategy);
      const flag = `lab-${c.strategy}-${c.sym}-loss`;
      if (strat && !brain.wFlags[flag] && Math.abs(c.pnlPct || 0) >= 1) {
        brain.wFlags[flag] = 1;
        this.pushLesson(`лаборатория: стратегия «${strat.short}» получила минус на ${c.sym} (${(c.pnlPct || 0).toFixed(1)}%) — связка под наблюдением`);
      }
    }
    const st = brain.symStats[c.sym] || { n: 0, wins: 0, streak: 0, avgPct: 0 };
    st.n++;
    if (won) { st.wins++; st.streak = st.streak < 0 ? 1 : st.streak + 1; }
    else { st.streak = st.streak > 0 ? -1 : st.streak - 1; }
    st.avgPct = (st.avgPct * (st.n - 1) + (c.pnlPct || 0)) / st.n;
    brain.symStats[c.sym] = st;
    const sFlag = c.sym + "-streak" + st.streak;
    if (st.streak <= -3 && st.n >= 4 && !brain.wFlags[sFlag]) {
      brain.wFlags[sFlag] = 1;
      this.pushLesson(`осторожнее с ${c.sym}: ${Math.abs(st.streak)} минуса подряд — уверенность на этой монете снижена`);
    }
    if (isAi) {
      const win = [];
      for (const c2 of this.a.userClosed) { if (c2.strategy !== "ai") continue; win.push(c2.pnl >= 0 ? 1 : 0); if (win.length >= 12) break; }
      if (win.length >= 6) {
        const wrW = win.reduce((x, y) => x + y, 0) / win.length;
        if (wrW < 0.4 && brain.confThreshold < 80) {
          brain.confThreshold++;
          this.pushLesson(`поднял порог входа до ${brain.confThreshold}%: в последнем окне сделок профитов меньше 40%`);
        } else if (wrW >= 0.6 && brain.confThreshold > 74) {
          brain.confThreshold--;
          this.pushLesson(`снизил порог входа до ${brain.confThreshold}%: качество последних сделок хорошее`);
        }
      }
    }
    brain.updatedAt = Date.now();
  }

  // ---------- сессия автопилота ----------
  aiSessionInfo() {
    const sess = this.a.aiSession;
    if (!sess) return null;
    let pnl = 0, trades = 0;
    for (const c of this.a.userClosed) if (c.strategy === "ai" && c.closedAt >= sess.openedAt) { pnl += c.pnl; trades++; }
    let open = 0;
    for (const p of this.a.userPositions) {
      if (p.strategy !== "ai") continue;
      open++;
      pnl += Engine.positionPnl(p, this.price(p.sym) || p.entry).pnl;
    }
    const pct = sess.startEquity > 0 ? (pnl / sess.startEquity) * 100 : 0;
    return { pnl, pct, trades, open, startBase: sess.startEquity };
  }
  closeAllAiPositions(reason) {
    const positions = this.a.userPositions.filter((p) => p.strategy === "ai");
    const out = [];
    for (const pos of positions) {
      const price = this.price(pos.sym) || pos.entry;
      const closed = Engine.closeTrade(pos, price, reason);
      this.a.userPositions = this.a.userPositions.filter((p) => p.id !== pos.id);
      this.a.userClosed = [closed, ...this.a.userClosed].slice(0, 300);
      this.a.balance += closed.size + closed.pnl;
      this.learnFromClosed(closed);
      out.push(closed);
    }
    return out;
  }
  aiSessionCheck() {
    if (!this.effAuto() || !this.a.aiSession) return;
    const info = this.aiSessionInfo();
    if (!info) return;
    const th = this.aiLimitPct();
    if (Math.abs(info.pct) < th) return;
    const isProfit = info.pct > 0;
    const closedList = this.closeAllAiPositions(isProfit ? "Авто-стоп сессии: фиксация результата" : "Авто-стоп сессии: защита капитала");
    const sumPnl = closedList.reduce((x, c) => x + c.pnl, 0);
    this.a.aiAuto = false;
    this.a.aiStop = { reason: isProfit ? "profit" : "loss", pct: info.pct, ts: Date.now(), threshold: th, closed: closedList.length };
    this.pushEvent({
      tone: isProfit ? "bull" : "bear",
      title: isProfit ? `Авто-стоп сессии ИИ: +${info.pct.toFixed(1)}% ≥ +${th}%` : `Авто-стоп сессии ИИ: ${info.pct.toFixed(1)}% ≤ −${th}%`,
      detail: (isProfit ? `ИИ наторговал ${Fmt.fmtNum(Math.round(info.pnl))} ХРЮ профита` : `просадка ${Fmt.fmtNum(Math.round(Math.abs(info.pnl)))} ХРЮ`)
        + ` — автопилот закрыл все ИИ-сделки по рынку (${closedList.length} шт., итог ${sumPnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(sumPnl)))} ХРЮ) и ждёт возобновления`,
      notify: { kind: "threshold", data: { pnl: info.pnl } },
    });
  }

  noteAiStopBan(sym) {
    if (!sym) return;
    if (!this.a.aiBan || typeof this.a.aiBan !== "object") this.a.aiBan = {};
    const until = Date.now() + AI_STOP_BAN_MS;
    if (this.a.aiBan[sym] && this.a.aiBan[sym] >= until) return;
    this.a.aiBan[sym] = until;
    this.pushEvent({
      tone: "bear",
      title: `ИИ взял тайм-аут по ${sym} на 4 часа после стопа`,
      detail: "тихий час: новых входов и флипов по этой монете не будет · открытые позиции защищаются как обычно",
      sym,
    });
  }

  // ---------- сделки ----------
  placeDemo(p) {
    const p0 = this.prices[p.sym];
    if (!p0 || !p0.price) return { ok: false, error: "Цена ещё не загружена" };
    if (!p0.ts || Date.now() - p0.ts > 120000) return { ok: false, error: "Цена по этой монете не обновляется" };
    const price = p0.price;
    const margin = Math.round(Number(p.size) || 0);
    if (!(margin > 0)) return { ok: false, error: "Некорректный размер сделки" };
    if (margin > this.aiDealCap()) return { ok: false, error: `Лимит одной сделки — ${Fmt.fmtNum(this.aiDealCap())} ХРЮ` };
    if (this.openPositionsSum() + margin > this.aiTotalCap()) return { ok: false, error: `Суммарный лимит сделок — ${Fmt.fmtNum(this.aiTotalCap())} ХРЮ: в рынке уже ${Fmt.fmtNum(Math.round(this.openPositionsSum()))} ХРЮ` };
    if (margin > this.a.balance) return { ok: false, error: `Недостаточно хрювен: свободно ${Fmt.fmtNum(this.a.balance)} ХРЮ` };
    const risk = price * 0.02;
    const pos = {
      id: p.id || `u${Date.now()}`, owner: "user", strategy: p.strategy || "manual", sym: p.sym, side: p.side,
      size: margin, lev: p.lev || 1, entry: price,
      stop: p.stop || (p.side === "лонг" ? price - risk : price + risk),
      target: p.target || (p.side === "лонг" ? price + risk * 2 : price - risk * 2),
      r0: Math.abs(price - (p.stop || (p.side === "лонг" ? price - risk : price + risk))),
      openedAt: Date.now(),
      ai: p.ai || null,
    };
    this.a.balance -= margin;
    this.a.userPositions = [pos, ...this.a.userPositions];
    this.pushEvent({
      tone: p.side === "лонг" ? "bull" : "bear",
      title: p.strategy === "ai" ? `ИИ-сделка открыта: ${p.sym} ${p.side} ×${pos.lev}` : `Демо-сделка открыта: ${p.sym} ${p.side} ×${pos.lev}`,
      detail: `${Fmt.fmtNum(margin)} ХРЮ (≈ ${Fmt.fmtUsd(margin)}) по реальной цене ${price.toPrecision(6)}${p.ai ? ` · уверенность ИИ ${p.ai.confidence}%` : ""}`,
      sym: p.sym,
      notify: (p.strategy === "ai" && p.ai && p.ai.auto) ? null : { kind: p.strategy === "ai" ? "ai_open" : "user_open" },
    });
    return { ok: true, pos };
  }
  closeDemo(id) {
    const pos = this.a.userPositions.find((p) => p.id === id);
    if (!pos) return { ok: false, error: "Позиция не найдена" };
    const price = this.price(pos.sym) || pos.entry;
    const closed = Engine.closeTrade(pos, price, "Вручную");
    this.a.userPositions = this.a.userPositions.filter((p) => p.id !== id);
    this.a.userClosed = [closed, ...this.a.userClosed].slice(0, 300);
    this.a.balance += pos.size + closed.pnl;
    this.learnFromClosed(closed);
    this.pushEvent({
      tone: closed.pnl >= 0 ? "bull" : "bear",
      title: `Демо-сделка закрыта: ${pos.sym} ${closed.pnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(closed.pnl)))} ХРЮ`,
      detail: closed.exitReason, sym: pos.sym,
      notify: { kind: "user_close", data: { pnl: closed.pnl } },
    });
    return { ok: true, closed };
  }
  // детерминированное закрытие (клиент/сервер считают одно и то же правило — двойные
  // исполнения схлопываются по pid, могилки не дают архиву воскресить закрытое)
  closeDeterministic(pos, exitPrice, reason, closedAtOverride) {
    const closed = Engine.closeTrade(pos, exitPrice, reason);
    if (closedAtOverride) { closed.closedAt = closedAtOverride; closed.id = `${pos.id}-c${closedAtOverride}`; }
    this.a.userPositions = this.a.userPositions.filter((p) => p.id !== pos.id);
    this.a.userClosed = [closed, ...this.a.userClosed].slice(0, 300);
    this.a.balance += closed.size + closed.pnl;
    this.learnFromClosed(closed);
    if (closed.strategy === "ai" && (reason === "Стоп" || reason === "Провал")) this.noteAiStopBan(pos.sym);
    this.pushEvent({
      id: "x" + pidOfClosed(closed),
      tone: closed.pnl >= 0 ? "bull" : "bear",
      title: `Демо: ${pos.sym} закрыта ${closed.exitReason.toLowerCase()} · ${closed.pnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(closed.pnl)))} ХРЮ`,
      detail: `исполнено сервером XenoAI · правило выхода: ${closed.exitReason}`,
      sym: pos.sym,
      notify: { kind: pos.strategy === "ai" ? "ai_close" : "user_close", data: { pnl: closed.pnl } },
    });
    return closed;
  }

  updateIdeas(sym, res, guard) {
    const rest = this.a.aiIdeas.filter((i) => i.sym !== sym);
    if (res.verdict !== "wait") rest.push({ sym, res, guard, ts: Date.now() });
    rest.sort((x, y) => y.res.confidence - x.res.confidence);
    this.a.aiIdeas = rest.slice(0, 8);
  }

  aiOpenInternal(res, size, isAuto, guardWhy) {
    const out = this.placeDemo({
      sym: res.sym, side: res.verdict, size, lev: 1,
      stop: res.stop, target: res.target, strategy: "ai",
      ai: { confidence: res.confidence, note: res.note, auto: !!isAuto, factors: res.factors, score: res.score },
    });
    if (out.ok && isAuto) {
      this.pushEvent({
        tone: res.verdict === "лонг" ? "bull" : "bear",
        title: `ИИ-автопилот вошёл: ${res.sym} ${res.verdict} ${res.confidence}%`,
        detail: `${Fmt.fmtNum(size)} ХРЮ · спот · защита: ${guardWhy} · стоп/цель по ATR · сделку открыл СЕРВЕР (автономно)`,
        sym: res.sym,
        notify: { kind: "ai_open" },
      });
    }
    return out;
  }

  flipAllowed(aiPos, res, effConf, thr, sym) {
    const ageMs = Date.now() - (aiPos.openedAt || 0);
    const price0 = this.price(sym) || aiPos.entry;
    const floatPct = Engine.positionPnl(aiPos, price0).pct;
    const riskPct0 = aiPos.r0 && aiPos.entry ? ((aiPos.r0 / aiPos.entry) * 100) : (res.riskPct || 1);
    const flippedRecently = Boolean(this._flipAt[sym] && Date.now() - this._flipAt[sym] < 45 * 60000);
    const ok = !flippedRecently
      && ageMs >= 15 * 60000
      && effConf >= Math.max(72, thr - 4)
      && res.confidence >= ((aiPos.ai && aiPos.ai.confidence) || thr) + 4
      && floatPct > -(riskPct0 * 0.6)
      && (res.agreeShare == null || res.agreeShare >= 0.6);
    return { ok, floatPct, riskPct0 };
  }

  // ================= автопилот по монете (порт aiAutoStep) =================
  aiAutoStep(sym, bars) {
    if (!this.effAuto() || !bars || bars.length < 60) return;

    if (!this.a.aiSession) this.a.aiSession = { startEquity: this.totalEquity(), openedAt: Date.now() };
    this.aiSessionCheck();
    if (!this.effAuto()) return;

    const extra = { whale: this.aiWhaleBias(sym), onchain: null, glm: null };
    const res = Engine.aiAnalyze(sym, bars, this.brain, this.news.items, extra);
    if (!res) return;
    const guard = this.combineGuard(sym);
    const rg = this.riskGuard(res);
    this.updateIdeas(sym, res, !guard.ok ? guard : !rg.ok ? rg : this.heatGuard());

    if (!this.a.aiBan || typeof this.a.aiBan !== "object") this.a.aiBan = {};
    if (this.a.aiBan[sym] && Date.now() >= this.a.aiBan[sym]) delete this.a.aiBan[sym];
    if (this.a.aiBan[sym]) {
      // R43: отказ из-за тайм-аута по монете — фиксируем в «Теневой торговле»
      if (res.verdict !== "wait") this.shadowLog(sym, res, "бан", "перерыв по монете после стопа — тайм-аут ИИ ещё не истёк");
      return;
    }

    const aiPos = this.a.userPositions.find((p) => p.sym === sym && p.strategy === "ai");
    const aiCount = this.a.userPositions.filter((p) => p.strategy === "ai").length;
    const thr = this.brain.confThreshold || 74;
    const effConf = res.confidence + this.symBias(sym);

    if (aiPos && res.verdict !== "wait" && res.verdict !== aiPos.side) {
      const fg = this.flipAllowed(aiPos, res, effConf, thr, sym);
      if (fg.ok) {
        const price0 = this.price(sym) || aiPos.entry;
        const closed = Engine.closeTrade(aiPos, price0, "ИИ-флип");
        this.a.userPositions = this.a.userPositions.filter((p) => p.id !== aiPos.id);
        this.a.userClosed = [closed, ...this.a.userClosed].slice(0, 300);
        this.a.balance += closed.size + closed.pnl;
        this.learnFromClosed(closed);
        this._flipAt = { ...this._flipAt, [sym]: Date.now() };
        this.pushEvent({
          tone: res.verdict === "лонг" ? "bull" : "bear",
          title: `ИИ флипнул ${sym}: ${aiPos.side} → ${res.verdict}`,
          detail: `закрыто по ${closed.pnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(closed.pnl)))} ХРЮ · разворот факторов (уверенность ${res.confidence}%)`,
          sym,
          notify: { kind: "ai_flip", data: { pnl: closed.pnl } },
        });
        const sc = this.aiSizeCalc();
        if (guard.ok && rg.ok && sc.size > 0) {
          this.aiOpenInternal(res, sc.size, true, "скам-фильтр, новости и риск-гвард ок");
          this._aiLastEntryAt = Date.now();
          this.a.aiLastEntryTs = Date.now();
        }
        return;
      }
    }

    const streakNow = this.aiLossStreak();
    if (streakNow < (this.a.aiCooldownSeen || 0)) this.a.aiCooldownSeen = streakNow;
    if (streakNow >= 3 && streakNow > (this.a.aiCooldownSeen || 0)) {
      this.a.aiCooldownUntil = Date.now() + 30 * 60000;
      this.a.aiCooldownSeen = streakNow;
      this.pushEvent({
        tone: "bear",
        title: "ИИ взял паузу на 30 минут: " + streakNow + " минуса подряд",
        detail: "защита от серии убытков: новые входы приостановлены, открытые позиции обслуживаются · после паузы вернётся сам",
        notify: { kind: "autopilot", data: { on: true } },
      });
      if (res.verdict !== "wait") this.shadowLog(sym, res, "пауза", "автопилот взял паузу на 30 минут: серия минусов");
      return;
    }
    if (Date.now() < (this.a.aiCooldownUntil || 0)) {
      if (res.verdict !== "wait") this.shadowLog(sym, res, "пауза", "автопилот на паузе после серии минусов");
      return;
    }

    const thrNow = this.brain.confThreshold || 74;
    if (thrNow > 74 && (this.a.aiLastEntryTs || 0) > 0 && Date.now() - this.a.aiLastEntryTs > 8 * 3600e3 && Date.now() - (this.a.aiRelaxAt || 0) > 2 * 3600e3) {
      this.brain.confThreshold = Math.max(74, thrNow - 2);
      this.a.aiRelaxAt = Date.now();
      this.pushLesson(`долго без новых входов — снизил порог входа до ${this.brain.confThreshold}%: строгий фильтр не должен замораживать торговлю`);
    }

    if (Date.now() - this._aiLastEntryAt < 4 * 60000) return;

    // R43: гейт входа с явной цепочкой причин — каждый отказ попадает в «Теневую торговлю».
    // Медвежий режим добавляет +6 к порогу: в падении торгуем только отборное («почти всё в кэше»).
    const bump = this._bear ? BEAR_GATE.bump : 0;
    const thrEntry = thr + bump;
    if (!aiPos && res.verdict !== "wait") {
      const maxPos = this.effMaxPos();
      const hg = this.heatGuard();
      const sc = this.aiSizeCalc();
      let refuse = "";
      if (effConf < thrEntry) refuse = `порог: уверенность ${effConf}% < ${thrEntry}%${bump ? " · медвежий режим +6" : ""}`;
      else if (res.agreeShare != null && res.agreeShare < 0.55) refuse = `ансамбль: согласие факторов ${Math.round(res.agreeShare * 100)}% < 55%`;
      else if (aiCount >= maxPos) refuse = `лимит: позиций уже ${aiCount} из ${maxPos}`;
      else if (!guard.ok) refuse = `фильтр: ${guard.why}`;
      else if (!rg.ok) refuse = `риск: ${rg.why}`;
      else if (!hg.ok) refuse = `нагрузка: ${hg.why}`;
      else if (!(sc.size > 0)) refuse = "размер: расчётный объём сделки 0";
      if (refuse) { this.shadowLog(sym, res, refuse.split(":")[0], refuse); return; }
      this.aiOpenInternal(res, sc.size, true, "скам-фильтр, новости и риск-гвард ок");
      this._aiLastEntryAt = Date.now();
      this.a.aiLastEntryTs = Date.now();
    }
  }

  toggleAiAuto(forceOn) {
    if (this.a.mode === "live") {
      const turningOn = forceOn === true ? true : !this.a.aiAutoLive;
      this.a.aiAutoLive = turningOn;
      if (turningOn) {
        this.a.aiSession = { startEquity: this.totalEquity(), openedAt: Date.now() };
        this.a.aiStop = null;
        this.pushEvent({ tone: "neutral", title: "ИИ-автопилот ВКЛЮЧЁН в реальном режиме (вы явно разрешили)", detail: `симуляция на реальных ценах · авто-стоп ±${this.aiLimitPct()}% · торгует сервер`, notify: { kind: "autopilot", data: { on: true } } });
      } else {
        this.pushEvent({ tone: "neutral", title: "ИИ-автопилот выключен в реальном режиме", detail: "ИИ сканирует и подсказывает — ордера отправляете вы", notify: { kind: "autopilot", data: { on: false } } });
      }
    } else {
      this.a.aiAuto = forceOn === true ? true : !this.a.aiAuto;
      if (this.a.aiAuto) {
        this.a.aiSession = { startEquity: this.totalEquity(), openedAt: Date.now() };
        this.a.aiStop = null;
        this.pushEvent({ tone: "neutral", title: "ИИ-автопилот включён: новая сессия", detail: `авто-стоп при ±${this.aiLimitPct()}% · сделки открывает и закрывает СЕРВЕР каждые 2 минуты — браузер не нужен`, notify: { kind: "autopilot", data: { on: true } } });
      } else {
        this.pushEvent({ tone: "neutral", title: "ИИ-автопилот выключен", detail: "ИИ сканирует и подсказывает", notify: { kind: "autopilot", data: { on: false } } });
      }
    }
  }

  // ================= шаг движка по монете (порт engineStep) =================
  engineStep(sym, bars) {
    if (!bars || !bars.length) return;
    if (bars[bars.length - 1].sim) return;
    this.a.lastScanAt = Date.now();
    const price = this.price(sym) || bars[bars.length - 1].c;

    // 0) автопилот — только сервер решает (здесь он и живёт)
    try { this.aiAutoStep(sym, bars); } catch (e) { this.tickLog.push("aiAutoStep " + sym + ": " + (e && e.message)); }

    // 1) сигналы стратегий + автоторговля лаборатории (демо-режим)
    for (const strat of Engine.STRATEGIES) {
      const sig = Engine.evalStrategy(strat.id, sym, bars);
      if (!sig) continue;
      const key = `${sig.strategy}-${sym}`;
      if (key === this.lastSignalKey) continue;
      if (this.a.labPositions.some((p) => p.sym === sym && p.strategy === strat.id)) continue;
      this.lastSignalKey = key;
      this.a.signals = [{ ...sig }, ...(this.a.signals || [])].slice(0, 40);
      this.pushEvent({ tone: "bull", title: `${strat.name}: сигнал по ${sym} · ${sig.confidence}%`, detail: sig.note, sym });

      if (!this.a.autoTrade) continue;
      if (this.a.mode === "live") continue;
      const eq = Engine.entryQualityFromBars(bars, "лонг");
      if (!eq.ok) continue;
      const acc = this.a.labAccounts.find((x) => x.strategy === strat.id);
      if (!acc || acc.balance < 500) continue;
      const size = Math.max(200, Math.min(1000, acc.balance * 0.1));
      const snap = Engine.aiFactorSnapshot(sym, bars, this.brain, this.news.items, { whale: this.aiWhaleBias(sym) });
      const pos = {
        id: `l${Date.now()}-${strat.id}`, owner: "lab", strategy: strat.id, account: acc.id,
        sym, side: "лонг", size, lev: 1, entry: price,
        stop: sig.stop, target: sig.target, openedAt: Date.now(),
        ladder: sig.entry - sig.atr * 0.5,
        ai: snap,
      };
      this.a.labPositions = [pos, ...this.a.labPositions];
      this.a.labAccounts = this.a.labAccounts.map((x) => (x.id === acc.id ? { ...x, balance: x.balance - size } : x));
    }

    // 2) выходы + трейлинг (та же политика «тело + N%»)
    const exits = [];
    for (const p of this.a.labPositions) {
      if (p.sym !== sym) continue;
      const ex = Engine.evalExit(p, bars, price, this.a.failPct);
      if (ex) exits.push({ pos: p, closed: Engine.closeTrade(p, ex.price, ex.reason) });
    }
    for (const p of this.a.userPositions) {
      if (p.sym !== sym) continue;
      if (p.strategy === "ai" && p.ai) {
        const newStop = Engine.aiTrailStop(p, price);
        if (newStop != null) {
          p.stop = newStop;
          p.mt = Date.now();
          const atBe = p.side === "лонг" ? newStop >= p.entry : newStop <= p.entry;
          if (!p.beNotified && atBe) {
            p.beNotified = true;
            this.pushEvent({
              tone: "bull", title: `ИИ перевёл ${p.sym} в безубыток`,
              detail: `стоп подтянут к входу (+1R): сделка уже не уйдёт в минус · цена ${Fmt.fmtPrice(price)}`,
              sym: p.sym, notify: { kind: "ai_be" },
            });
          }
        }
      }
      const ex = Engine.evalExit(p, bars, price, this.a.failPct);
      if (ex) exits.push({ pos: p, closed: Engine.closeTrade(p, ex.price, ex.reason) });
    }
    if (exits.length) {
      const labIds = new Set(exits.filter((e) => e.pos.owner === "lab").map((e) => e.pos.id));
      const userIds = new Set(exits.filter((e) => e.pos.owner === "user").map((e) => e.pos.id));
      const labClosedAdd = exits.filter((e) => e.pos.owner === "lab").map((e) => e.closed);
      const userClosedAdd = exits.filter((e) => e.pos.owner === "user").map((e) => e.closed);
      this.a.labPositions = this.a.labPositions.filter((p) => !labIds.has(p.id));
      this.a.labClosed = [...labClosedAdd, ...this.a.labClosed].slice(0, 300);
      this.a.userPositions = this.a.userPositions.filter((p) => !userIds.has(p.id));
      this.a.userClosed = [...userClosedAdd, ...this.a.userClosed].slice(0, 300);
      this.a.balance += userClosedAdd.reduce((sum, c) => sum + c.size + c.pnl, 0);
      for (const c of userClosedAdd) this.learnFromClosed(c);
      for (const c of userClosedAdd) if (c.strategy === "ai" && (c.exitReason === "Стоп" || c.exitReason === "Провал")) this.noteAiStopBan(c.sym);
      for (const c of labClosedAdd) this.learnFromClosed(c, true);
      if (labClosedAdd.length) {
        this.a.labAccounts = this.a.labAccounts.map((x) => {
          const adds = labClosedAdd.filter((c) => c.account === x.id);
          if (!adds.length) return x;
          const bal = x.balance + adds.reduce((sum, c) => sum + c.size + c.pnl, 0);
          return { ...x, balance: bal, equityHist: [...x.equityHist.slice(-40), bal], days: x.days + 1 / 5760 };
        });
      }
      for (const e of exits) {
        this.pushEvent({
          id: "x" + pidOfClosed(e.closed),
          tone: e.closed.pnl >= 0 ? "bull" : "bear",
          title: `${e.pos.owner === "lab" ? "Лаборатория" : "Демо"}: ${e.pos.sym} закрыта ${e.closed.exitReason.toLowerCase()} · ${e.closed.pnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(e.closed.pnl)))} ХРЮ`,
          detail: `исполнено СЕРВЕРОМ XenoAI · ${(Engine.STRATEGIES.find((x) => x.id === e.pos.strategy) || { name: "вручную" }).name}`,
          sym: e.pos.sym,
          notify: e.pos.owner === "lab"
            ? { kind: "lab", data: { pnl: e.closed.pnl } }
            : { kind: e.pos.strategy === "ai" ? "ai_close" : "user_close", data: { pnl: e.closed.pnl } },
        });
      }
    }
  }

  // ================= ТОК: обновление цен + торговля =================
  // params: { pairs, barSymbols } — какие монеты прошли полный шаг (новая свеча)
  async tick(opts) {
    const o = opts || {};
    this.newEvents = [];
    this.tickLog = [];
    const now = Date.now();

    // 1) цены: пачка всех пар одним запросом
    try {
      const pairs = WATCHLIST.filter((i) => i.pair).map((i) => i.pair);
      const { rows } = await this.hooks.fetchTickers(pairs);
      for (const t of rows) {
        const sym = PAIR_TO_SYM[t.symbol] || String(t.symbol).replace(/USDT$/, "");
        if (!(Number(t.lastPrice) > 0)) continue;
        this.prices[sym] = { sym, price: Number(t.lastPrice), chg24h: Number(t.priceChangePercent) || 0, vol24: Number(t.quoteVolume) || 0, ts: now };
      }
      this.a.prices = {};
      for (const sym of WATCH_SYMS) if (this.prices[sym]) this.a.prices[sym] = this.prices[sym].price;
      this.a.degraded = false;
    } catch (e) {
      this.a.degraded = true; // источники молчат: торговля честно стоит (как в браузере R30)
      this.tickLog.push("tickers fail: " + (e && e.message));
      return;
    }

    // 2) докачка монет, которых нет у рабочего источника (только нужные: позиции + кандидаты)
    const need = new Set([
      ...this.a.userPositions.map((p) => p.sym),
      ...(o.scanSyms || []),
    ].filter((sym) => !this.prices[sym] || now - (this.prices[sym].ts || 0) > 60000));
    for (const sym of Array.from(need).slice(0, 6)) {
      const inst = BY_SYM[sym];
      if (!inst) continue;
      try {
        const t = await this.hooks.fetchTickerOne(inst.pair);
        if (t && Number(t.lastPrice) > 0) {
          this.prices[sym] = { sym, price: Number(t.lastPrice), chg24h: Number(t.priceChangePercent) || 0, vol24: Number(t.quoteVolume) || 0, ts: now };
          this.a.prices[sym] = this.prices[sym].price;
        }
      } catch (e) { /* следующий тик повторит */ }
    }

    // 3) полный шаг по монетам с новой 15м-свечой + выходы по живой цене для позиций
    const syms = o.scanSyms || [];
    for (const sym of syms) {
      const inst = BY_SYM[sym];
      if (!inst) continue;
      try {
        const { bars } = await this.hooks.fetchKlines(inst.pair, "15m", 120);
        if (!bars || bars.length < 10) continue;
        this.bars[sym] = bars;
        // R40: у ВСЕХ источников каскада (Binance, MEXC, Bybit, OKX, Gate, KuCoin)
        // ПОСЛЕДНИЙ элемент массива — формирующаяся свеча (openTime + ТФ > now).
        // Раньше «последней закрытой» считали именно её, поэтому условие
        // now >= openTime + 15м не выполнялось НИКОГДА: гейт новой свечи молчал →
        // engineStep (сигналы, идеи ИИ, входы автопилота) не запускался ни разу
        // с переезда на сервер. Работали только выходы (exitsOnly) — торговля стояла.
        // Считаем закрытой последнюю свечу, чьё время закрытия уже прошло, и шагаем
        // РОВНО ОДИН раз на каждое её обновление (первый скан после деплоя тоже
        // шагает — мгновенный старт сканера без ожидания ближайшего закрытия).
        let ci = bars.length - 1;
        while (ci >= 0 && bars[ci].openTime + 15 * 60000 > now) ci--;
        const closedOpen = ci >= 0 ? bars[ci].openTime : 0;
        const isNewBar = closedOpen > 0 && closedOpen !== (this.lastBarClose[sym] || 0);
        if (isNewBar) this.lastBarClose[sym] = closedOpen;
        // выходы проверяем каждый тик по живой цене (как в браузере);
        // полный шаг (сигналы+входы) — только на новой закрытой свече
        if (isNewBar) this.engineStep(sym, bars);
        else if (this.a.userPositions.some((p) => p.sym === sym)) this.exitsOnly(sym, bars, now);
      } catch (e) {
        this.tickLog.push("klines " + sym + ": " + (e && e.message));
      }
    }

    // R43: медвежий режим (порог +6) и проверка отказов «Теневой торговли» по свежим ценам
    const bearNow = this.bearGate();
    this._bear = bearNow.bear;
    if (bearNow.bear && !this._bearOn) {
      this.pushEvent({
        tone: "bear",
        title: `Медвежий режим: порог входа ${(this.brain.confThreshold || 74) + BEAR_GATE.bump}%`,
        detail: `BTC ${bearNow.chg.toFixed(1)}% за 24ч · в красе ${Math.round(bearNow.breadth * 100)}% вотчлиста — входы только отборные, отказы видны во вкладке «Тень»`,
      });
    }
    this._bearOn = bearNow.bear;
    try { this.shadowTick(); } catch (e) { /* журнал отказов не критичен */ }

    // 4) сессия: эквити-история
    this.a.equityHist = [...this.a.equityHist, { ts: now, v: Math.round(this.totalEquity()) }].slice(-300);
    this.a.rev = (this.a.rev || 0) + 1;
    this.a.updatedAt = now;
  }

  // выходы без полного шага (живая цена против стопа/цели/провала)
  exitsOnly(sym, bars, now) {
    const price = this.price(sym);
    if (!price) return;
    for (const p of [...this.a.userPositions]) {
      if (p.sym !== sym) continue;
      if (p.strategy === "ai" && p.ai) {
        const newStop = Engine.aiTrailStop(p, price);
        if (newStop != null) { p.stop = newStop; p.mt = now; }
      }
      const ex = Engine.evalExit(p, bars, price, this.a.failPct);
      if (ex) this.closeDeterministic(p, ex.price, ex.reason);
    }
    for (const p of [...this.a.labPositions]) {
      if (p.sym !== sym) continue;
      const ex = Engine.evalExit(p, bars, price, this.a.failPct);
      if (ex) {
        const closed = Engine.closeTrade(p, ex.price, ex.reason);
        this.a.labPositions = this.a.labPositions.filter((q) => q.id !== p.id);
        this.a.labClosed = [closed, ...this.a.labClosed].slice(0, 300);
        this.learnFromClosed(closed, true);
        this.a.labAccounts = this.a.labAccounts.map((x) => (x.id === closed.account ? { ...x, balance: x.balance + closed.size + closed.pnl } : x));
        this.pushEvent({
          id: "x" + pidOfClosed(closed),
          tone: closed.pnl >= 0 ? "bull" : "bear",
          title: `Лаборатория: ${p.sym} закрыта ${closed.exitReason.toLowerCase()} · ${closed.pnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(closed.pnl)))} ХРЮ`,
          detail: "исполнено СЕРВЕРОМ XenoAI", sym: p.sym,
          notify: { kind: "lab", data: { pnl: closed.pnl } },
        });
      }
    }
  }

  // ---------- серверные действия (ручные) ----------
  action(type, payload) {
    const a = this.a;
    const p = payload || {};
    switch (type) {
      case "open": return this.placeDemo(p);
      case "close": {
        const pos = a.userPositions.find((x) => x.id === p.id);
        if (!pos) return { ok: false, error: "Позиция не найдена" };
        const closed = this.closeDeterministic(pos, p.exitPrice != null ? p.exitPrice : (this.price(pos.sym) || pos.entry), p.reason || "Вручную");
        return { ok: true, closed };
      }
      case "closeAllAi": {
        const closedList = this.closeAllAiPositions(p.reason || "Закрыто владельцем");
        return { ok: true, n: closedList.length };
      }
      case "clearHistory": {
        const isUser = p.which !== "lab";
        const list = isUser ? a.userClosed : a.labClosed;
        const n = list.length;
        if (!n) return { ok: false, error: "История закрытых сделок и так пуста" };
        if (isUser) { a.clearedU = Array.from(new Set([...(a.clearedU || []), ...list.map((c) => c.id)])).slice(-800); a.userClosed = []; }
        else { a.clearedL = Array.from(new Set([...(a.clearedL || []), ...list.map((c) => c.id)])).slice(-800); a.labClosed = []; }
        this.pushEvent({
          tone: "neutral",
          title: `История закрытых сделок очищена: удалено ${n}`,
          detail: (isUser ? "ваша история" : "история лаборатории") + " · удаление ЗАФИКСИРОВАНО НА СЕРВЕРЕ — оно приедет на все устройства, воскреснуть не сможет",
        });
        return { ok: true, n };
      }
      case "set": {
        const keys = ["failPct", "aiThreshold", "maxDeal", "maxTotal", "aiPosMode", "aiMaxPos"];
        const key = String(p.key || "");
        if (!keys.includes(key)) return { ok: false, error: "неизвестная настройка: " + key };
        if (key === "failPct") {
          const n = Math.round(Number(p.value));
          if (!Number.isFinite(n) || n < 0 || n > 200) return { ok: false, error: "Провальный порог — от 0 до 200% от тела сделки" };
          a.failPct = n;
        } else if (key === "aiThreshold") {
          const n = Math.round(Number(p.value));
          if (!Number.isFinite(n) || n < 5 || n > 500) return { ok: false, error: "Лимит сессии — от 5% до 500%" };
          a.aiThreshold = n;
        } else if (key === "maxDeal") {
          const n = Math.round(Number(p.value));
          if (!Number.isFinite(n) || n < 5 || n > 100000) return { ok: false, error: "Максимум одной сделки — от 5 до 100 000 ХРЮ" };
          a.maxDeal = n;
          if (Number(a.maxTotal) < n) a.maxTotal = n;
        } else if (key === "maxTotal") {
          const n = Math.round(Number(p.value));
          if (!Number.isFinite(n) || n < a.maxDeal) return { ok: false, error: "Суммарный лимит не может быть меньше лимита одной" };
          a.maxTotal = n;
        } else if (key === "aiPosMode" || key === "aiMaxPos") {
          if (p.value === "auto") a.aiPosMode = "auto";
          else {
            const n = Math.round(Number(p.value));
            if (!Number.isFinite(n) || n < 1 || n > 8) return { ok: false, error: "Максимум одновременных ИИ-позиций — от 1 до 8" };
            a.aiPosMode = n;
          }
        }
        return { ok: true };
      }
      case "toggleAuto": a.autoTrade = !a.autoTrade; return { ok: true };
      case "toggleAiAuto": this.toggleAiAuto(p.forceOn); return { ok: true };
      case "setMode": {
        if (p.mode === "live" && !p.liveConnected) return { ok: false, error: "Сначала подключите кошелёк или ключи биржи" };
        if (p.mode === "demo" || p.mode === "live") a.mode = p.mode;
        return { ok: true };
      }
      case "setBalance": {
        const v = Number(p.value);
        if (!Number.isFinite(v) || v < 0) return { ok: false, error: "Некорректный баланс" };
        a.balance = v; a.startBalance = v;
        if (a.aiAuto && a.aiSession) a.aiSession.startEquity = this.totalEquity();
        return { ok: true };
      }
      case "resetDemo": {
        a.balance = a.startBalance;
        a.userPositions = []; a.userClosed = [];
        a.labAccounts = Engine.mkLabAccounts();
        a.labPositions = []; a.labClosed = []; a.equityHist = [];
        a.aiSession = { startEquity: this.totalEquity(), openedAt: Date.now() };
        a.aiStop = null;
        this.pushEvent({ tone: "neutral", title: "Демо-счёт сброшен", detail: "Все сделки и статистики обнулены · память ИИ сохранена" });
        return { ok: true };
      }
      case "pushSub": {
        const sub = p.sub;
        if (!sub || typeof sub.endpoint !== "string" || sub.endpoint.indexOf("https://") !== 0
          || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return { ok: false, error: "подписка неполная" };
        const rest = (a.pushSubs || []).filter((s) => s.endpoint !== sub.endpoint);
        rest.unshift({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, ts: Date.now(), ua: String(p.ua || "").slice(0, 140) });
        a.pushSubs = rest.slice(0, 8);
        return { ok: true };
      }
      case "pushUnsub": {
        a.pushSubs = (a.pushSubs || []).filter((s) => s.endpoint !== p.endpoint);
        return { ok: true };
      }
      default: return { ok: false, error: "неизвестное действие: " + type };
    }
  }
}
