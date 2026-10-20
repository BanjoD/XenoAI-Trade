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

// R49: КАЛИБРОВКА УВЕРЕННОСТИ. ИИ пишет «уверенность 80%», но как часто он прав
// на самом деле? Счётчики по бакетам уверенности (ло 70–74, мид 75–80, хай 81+)
// сравнивают факт (винрейт закрытых ИИ-сделок) с ожиданием. Расхождение превращается
// в offset −6…+6 пунктов: effConf = уверенность + симбиас + тень + калибровка.
// Голая цифра перестаёт быть «просто формулой» — она соответствует реальному винрейту.
export const CALIB_TARGETS = { lo: 0.5, mid: 0.58, hi: 0.68 }; // ожидаемый винрейт бакета
export const CALIB_WEIGHTS = { lo: 0.25, mid: 0.35, hi: 0.4 }; // вклад бакета в offset
export const CALIB_MIN_N = 6;   // бакет влияет только с достаточной выборкой
export const CALIB_CAP = 6;     // потолок сдвига в пунктах уверенности

function defaultCalib() {
  return { lo: { n: 0, w: 0 }, mid: { n: 0, w: 0 }, hi: { n: 0, w: 0 }, offset: 0 };
}

// единая формула offset из бакетов (пересчёт после каждой сделки, merge, нормализация)
export function calibOffsetOf(calib) {
  if (!calib || typeof calib !== "object") return 0;
  let raw = 0;
  for (const k of ["lo", "mid", "hi"]) {
    const b = calib[k];
    if (!b || typeof b !== "object") continue;
    const n = Number(b.n) || 0, w = Number(b.w) || 0;
    if (n < CALIB_MIN_N) continue; // мало данных — бакет молчит
    raw += CALIB_WEIGHTS[k] * ((w / n) - CALIB_TARGETS[k]);
  }
  return Math.max(-CALIB_CAP, Math.min(CALIB_CAP, Math.round(raw * 100)));
}

export function normalizeCalib(c) {
  const out = defaultCalib();
  if (!c || typeof c !== "object") return out;
  for (const k of ["lo", "mid", "hi"]) {
    const b = c[k];
    if (b && typeof b === "object") {
      out[k].n = Math.max(0, Math.round(Number(b.n) || 0));
      out[k].w = Math.max(0, Math.min(out[k].n, Math.round(Number(b.w) || 0)));
    }
  }
  out.offset = calibOffsetOf(out);
  return out;
}

export function defaultBrain() {
  return {
    v: 1,
    weights: null,
    rel: {},
    symStats: {},
    confThreshold: 74, // база порога входа — требование пользователя: >74% открывается само
    calib: defaultCalib(), // R49: калибровка уверенности по фактическому винрейту
    trades: 0, wins: 0, losses: 0,
    // R52: ЛОНГ-ОПЫТ отдельно. На реальном рынке (спот OKX) шортов нет — ИИ применяет
    // там именно лонг-опыт: винрейт/келли/байес по лонгам считается из этих счётчиков
    longTrades: 0, longWins: 0,
    lessons: [],
    wFlags: {},
    shadowWrong: 0,  // R44: сколько отказов «по порогу» тень признала ошибочными (обратная связь)
    shadowTuneAt: 0, // R44: троттл подстройки порога по тени — не чаще раза в час
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
  if (!Number.isFinite(br.shadowWrong) || br.shadowWrong < 0) br.shadowWrong = 0;
  if (!Number.isFinite(br.shadowTuneAt) || br.shadowTuneAt < 0) br.shadowTuneAt = 0;
  // R52: лонг-счётчики (опыт именно по лонгам — валюта решений реального рынка)
  if (!Number.isFinite(br.longTrades) || br.longTrades < 0) { br.longTrades = 0; br.longWins = 0; }
  if (!Number.isFinite(br.longWins) || br.longWins < 0) br.longWins = 0;
  if (br.longWins > br.longTrades) br.longWins = br.longTrades;
  // R52: под-статистики по направлениям внутри symStats — валидируем структуру
  if (br.symStats && typeof br.symStats === "object") {
    for (const k of Object.keys(br.symStats)) {
      const st = br.symStats[k];
      if (!st || typeof st !== "object") { delete br.symStats[k]; continue; }
      for (const sk of ["long", "short"]) {
        const d = st[sk];
        if (d == null) continue;
        if (typeof d !== "object" || !Number.isFinite(Number(d.n)) || Number(d.n) <= 0) { delete st[sk]; continue; }
        st[sk] = {
          n: Math.max(1, Math.round(Number(d.n) || 0)),
          wins: Math.max(0, Math.round(Number(d.wins) || 0)),
          streak: Math.max(-99, Math.min(99, Math.round(Number(d.streak) || 0))),
          avgPct: Number(d.avgPct) || 0,
        };
        if (st[sk].wins > st[sk].n) st[sk].wins = st[sk].n;
      }
    }
  }
  br.calib = normalizeCalib(br.calib); // R49: бакеты калибровки + offset пересчитывается по формуле
  return br;
}

// ================= R51: ПОЛНАЯ СИНХРОНИЗАЦИЯ OKX =================
// Пользователь: «нужна полная синхронизация с OKX — всё по-настоящему».
// 1) баланс виден с биржи (реальные USDT); 2) вход в сделку (сигнал/автопилот/вручную)
// = РЕАЛЬНАЯ покупка токена на OKX-споте (USDT → токен); 3) закрытие сделки
// = РЕАЛЬНАЯ продажа (токен → USDT); 4) PnL реальных сделок считается по факту
// исполнения биржи и льётся в общий мозг. Ключи — только в storage DO; в архив едет
// лишь публичное состояние (маска/баланс), устройства секретов никогда не видят.
export function defaultOkx() {
  return { on: false, auto: false, mask: "", balanceUSDT: null, balanceEq: null, ts: 0, lastSync: 0, lastErr: "" };
}

// публичное состояние OKX — СЕКРЕТОВ ЗДЕСЬ НЕТ (маска ключа максимум)
export function normalizeOkx(v) {
  const src = v && typeof v === "object" ? v : {};
  const out = defaultOkx();
  out.on = src.on === true;
  out.auto = src.auto !== false; // по умолчанию включена — пользователь просил «всё по-настоящему»
  out.mask = String(src.mask || "").slice(0, 16);
  if (Number.isFinite(Number(src.balanceUSDT))) out.balanceUSDT = Number(src.balanceUSDT);
  if (Number.isFinite(Number(src.balanceEq))) out.balanceEq = Number(src.balanceEq);
  if (Number(src.ts) > 0) out.ts = Number(src.ts);
  if (Number(src.lastSync) > 0) out.lastSync = Number(src.lastSync);
  out.lastErr = String(src.lastErr || "").slice(0, 160);
  return out;
}

// персист-очередь реальных ордеров: задачи переживают перезапуск DO.
// job = { id, kind: "buy"|"sell", sym, instId, usdt, qty, posId, attempts, ts, lastErr, note }
export function normalizeRealQueue(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((j) => j && typeof j === "object" && (j.kind === "buy" || j.kind === "sell")
    && typeof j.sym === "string" && j.sym.length <= 16)
    .slice(0, 40)
    .map((j) => ({
      id: String(j.id || "").slice(0, 32),
      kind: j.kind,
      sym: String(j.sym).slice(0, 16),
      instId: String(j.instId || "").slice(0, 20),
      usdt: Number.isFinite(Number(j.usdt)) ? Math.max(0, Math.round(Number(j.usdt) * 100) / 100) : 0,
      qty: Number.isFinite(Number(j.qty)) ? Math.max(0, Number(j.qty)) : 0,
      posId: String(j.posId || "").slice(0, 32),
      ordId: String(j.ordId || "").slice(0, 32),
      attempts: Math.max(0, Math.min(20, Math.round(Number(j.attempts) || 0))),
      ts: Number(j.ts) || 0,
      lastErr: String(j.lastErr || "").slice(0, 160),
      note: String(j.note || "").slice(0, 80),
    }));
}

// «отпечаток» архива — как fpOf в store.js: состав баланса/позиций/истории/настроек.
// Меняется только на реальных изменениях; по нему решаем, есть ли что сохранять.
export function fpOf(a) {
  if (!a || typeof a !== "object") return "";
  const c0 = (a.userClosed || [])[0] || {};
  const e0 = (a.events || [])[0] || {};
  const cu = a.clearedU || [], cl = a.clearedL || [];
  // R47: в отпечаток добавлены статус доставки подписок (last/lastAck) и тень
  // (trust/skip) — раньше их мутации не меняли fp и НЕ ПЕРСИСТИЛИСЬ до ближайшего
  // «настоящего» изменения баланса/позиций.
  const sh = a.shadow || {};
  const trKeys = Object.keys(sh.trust || {}).length;
  const skKeys = Object.keys(sh.skip || {}).length;
  // сумма содержимого trust/skip — иначе изменение ЗНАЧЕНИЙ при том же числе ключей не меняло fp
  let trSum = 0, skSum = 0;
  for (const k of Object.keys(sh.trust || {})) { const t = sh.trust[k] || {}; trSum += (Number(t.right) || 0) + (Number(t.wrong) || 0) + (Number(t.flat) || 0); }
  for (const k of Object.keys(sh.skip || {})) skSum += Math.round((Number(sh.skip[k]) || 0) / 60000);
  const st = sh.stats || {};
  // R49: калибровка/реальные сделки/вердикт GLM тоже мутируются без смены состава — в отпечаток
  const cb = a.liveStats || {};
  const gv = a.glmVerdict || {};
  // R51: синхронизация OKX (публичное состояние) + персист-очередь реальных ордеров
  const ox = a.okx || {};
  const rq = a.realQueue || [];
  return [
    a.balance,
    (a.userPositions || []).map((p) => p.id + ":" + (p.stop || 0) + ":" + (p.mt || 0)).sort().join(","),
    (a.userClosed || []).length + ":" + (c0.id || ""),
    (a.events || []).length + ":" + (e0.id || ""),
    cu.length + ":" + (cu.length ? cu[cu.length - 1] : ""),
    cl.length + ":" + (cl.length ? cl[cl.length - 1] : ""),
    a.maxDeal, a.maxTotal, a.aiThreshold, a.aiPosMode,
    a.failPct,
    (a.pushSubs || []).length + ":" + (a.pushSubs || []).map((s) => ((s.last && s.last.ts) || 0) + "." + ((s.lastAck && s.lastAck.ts) || 0)).join(","),
    "nt" + (a.ntfy && a.ntfy.on ? 1 : 0) + ":" + (a.ntfy && a.ntfy.topic || "") + ":" + ((a.ntfy && a.ntfy.last && a.ntfy.last.ts) || 0),
    a.mode, a.autoTrade ? 1 : 0, a.aiAuto ? 1 : 0, a.aiAutoLive ? 1 : 0,
    "okx" + (ox.on ? 1 : 0) + (ox.auto ? 1 : 0) + ":" + (ox.mask || "") + ":" + (Number(ox.balanceUSDT) || 0).toFixed(2) + ":" + ((Number(ox.lastSync) || 0) / 60000 | 0) + ":" + String(ox.lastErr || "").slice(0, 40),
    "rq" + rq.length + ":" + rq.map((j) => (j && j.kind ? j.kind[0] : "?") + (j.id || "").slice(-6) + ":" + (j.attempts || 0)).join(","),
    "ls" + (Number(cb.n) || 0) + ":" + (Number(cb.wins) || 0) + ":" + (Math.round(Number(cb.pnlUsdt) || 0)),
    "gv" + (Number(gv.ts) || 0) + ":" + String(gv.status || ""),
    "sh" + trKeys + ":" + trSum + ":" + skKeys + ":" + skSum + ":" + (Number(st.right) || 0) + "." + (Number(st.wrong) || 0) + "." + (Number(st.flat) || 0),
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
      // R44: при коллизии pid оставляем запись с ПОЗДНИМ closedAt — сервер авторитарен,
      // его закрытие правдивее устаревшей копии устройства
      const cur = byPid.get(pid);
      if (!cur || (c.closedAt || 0) > (cur.closedAt || 0)) byPid.set(pid, c);
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
  out.ntfy = mergeNtfy(a.ntfy, b.ntfy); // R50: резервный канал переезжает целиком (кто новее — тот и правда)
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

// ================= R50: РЕЗЕРВНЫЙ КАНАЛ ПУШЕЙ · NTFY =================
// Диагноз R50 (живой): сервер шлёт пуши исправно (FCM отвечает 201 на каждую
// отправку, включая реальные сделки), но sub.lastAck на устройстве НЕ приходил
// НИКОГДА — Chrome на части Android-устройств не будит service worker в фоне
// (агрессивная экономия батареи OEM, «убийцы» фоновых приложений, силы.stop Chrome).
// Серверным кодом это не лечится. Решение — второй, независимый канал доставки:
// приложение ntfy получает сообщения своим соединением и показывает их при
// полностью закрытом браузере. Тема — несгадываемый случайный идентификатор.
export const NTFY_TOPIC_RE = /^[a-zA-Z0-9_-]{6,64}$/;
const NTFY_HOST_DEFAULT = "https://ntfy.sh";

export function normalizeNtfy(v, host) {
  const src = v && typeof v === "object" ? v : {};
  const out = {
    on: src.on === true,
    topic: NTFY_TOPIC_RE.test(String(src.topic || "")) ? String(src.topic) : "",
    last: null,
  };
  if (out.on && !out.topic) out.on = false; // без темы канал бессмыслен
  if (src.last && typeof src.last === "object") {
    out.last = { ts: Number(src.last.ts) || 0, status: Number(src.last.status) || 0, ok: Boolean(src.last.ok) };
  }
  if (out.topic) out.url = (host || NTFY_HOST_DEFAULT) + "/" + out.topic;
  return out;
}

export function mergeNtfy(aN, bN) {
  const a = normalizeNtfy(aN), b = normalizeNtfy(bN);
  const ta = (a.last && a.last.ts) || 0, tb = (b.last && b.last.ts) || 0;
  if (ta !== tb) return ta > tb ? a : b;      // у кого свежее доставка — тот и правда
  if (a.on !== b.on) return a.on ? a : b;     // включённый канал важнее выключенного
  return a.topic ? a : b;                      // при равенстве — у кого есть тема
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
// R45: тень учит ПОДБОР МОНЕТ. Доверие к монете строится из исходов её отказов:
// «wrong» — отказали, а монета ушла в плюс (фильтр был слишком строг для неё — упущенный профит),
// «right» — отказали, и монета действительно рухнула (отказ верный).
// adj — прибавка/скидка к уверенности при входе и вес в ранжировании идей.
const TRUST_MIN_N = 2;     // минимум разобранных отказов по монете, прежде чем влиять
const TRUST_W_WRONG = 1.5; // вес упущенного профита (важнее: это наша дыра в подборе)
const TRUST_W_RIGHT = 1.0; // вес верного отказа
const TRUST_MAX = 4;       // потолок бонуса уверенности, пунктов
const TRUST_MIN = -6;      // дно штрафа уверенности, пунктов
// Монета с СТАБИЛЬНО верными отказами (right ≥ 3 и right ≥ 3×wrong) — мусорка, где
// ИИ каждый раз правильно не покупал: убираем её со скана на 12 часов.
const SKIP_RIGHT_N = 3;
const SKIP_RATIO = 3;
const SKIP_MS = 12 * 3600e3;

// ================= R49: СЕРВЕРНЫЕ КИТЫ И GLM-АНАЛИТИК =================
// Раньше оба фактора (12-й «киты» и 13-й «GLM») на сервере были пустышками:
// this.whales никогда не заполнялся (лишало автопилот китового фактора), а GLM
// был null (модель опрашивалась только из браузера, пока вкладка открыта).
const WHALE_PER_TICK = 3;        // сколько монет сканируем китовой лентой за тик
const WHALE_MIN_NOTIONAL = 15000; // сделка мельче $15K — не кит (как в браузере)
const WHALE_KEEP = 40;           // сколько крупных сделок храним по монете
const WHALE_THROTTLE_MS = 8 * 60000; // одну монету сканируем не чаще раза в 8 минут
const GLM_ASK_MS = 10 * 60000;   // опрос GLM-аналитика — раз в 10 минут (как в браузере)
const GLM_DECAY_H = 2;           // вердикт угасает за 2 часа
const GLM_MIN_STRENGTH = 0.15;   // слабый вердикт в ансамбль не попадает

function defaultShadow() {
  return { list: [], stats: { right: 0, wrong: 0, flat: 0, avoidedSum: 0, avoidedN: 0, since: Date.now() }, trust: {}, skip: {} };
}

// R45: adj доверия из счётчиков исходов — единая формула для пересчёта и нормализации
function trustAdjFrom(t) {
  if (!t || typeof t !== "object") return 0;
  const n = (Number(t.right) || 0) + (Number(t.wrong) || 0) + (Number(t.flat) || 0);
  if (n < TRUST_MIN_N) return 0;
  const raw = (Number(t.wrong) || 0) * TRUST_W_WRONG - (Number(t.right) || 0) * TRUST_W_RIGHT;
  return Math.max(TRUST_MIN, Math.min(TRUST_MAX, Math.round(raw)));
}

export function normalizeShadow(s) {
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
  // R45: доверие по монетам + действующие пропуски скана (истёкшие выбрасываем)
  if (s.trust && typeof s.trust === "object") {
    for (const k of Object.keys(s.trust)) {
      const t = s.trust[k];
      if (!t || typeof t !== "object") continue;
      out.trust[String(k).slice(0, 12)] = {
        right: Number(t.right) || 0, wrong: Number(t.wrong) || 0, flat: Number(t.flat) || 0,
        adj: trustAdjFrom(t), ts: Number(t.ts) || 0,
      };
    }
  }
  if (s.skip && typeof s.skip === "object") {
    for (const k of Object.keys(s.skip)) {
      const until = Number(s.skip[k]);
      if (Number.isFinite(until) && until > Date.now()) out.skip[String(k).slice(0, 12)] = until;
    }
  }
  return out;
}

// ================= R47: ЕДИНЫЙ МОЗГ ИИ (один на все аккаунты и режимы) =================
// Требование пользователя: «ИИ один общий для всех и всего» — знания, полученные на
// демо-сделках, лаборатории и тени ЛЮБОГО аккаунта, применяются в реальной торговле
// ВСЕХ аккаунтов. Носитель общего мозга — отдельный Durable Object «__hub» (один
// писатель, сильная консистентность); комнаты синхронизируются с ним по /brain-sync.

// Adopt: заменить содержимое target содержимым src С СОХРАНЕНИЕМ ссылок target
// (AccountBrain держит ссылку на объект мозга — заменять сам объект нельзя, только
// мутировать поля, иначе рантайм продолжит читать старую память).
export function adoptBrain(t, s) {
  const deep = (a, b) => {
    for (const k of Object.keys(a)) if (!(k in b)) delete a[k];
    for (const k of Object.keys(b)) {
      const v = b[k];
      if (v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" && !Array.isArray(a[k])) deep(a[k], v);
      else a[k] = Array.isArray(v) ? v.slice() : (v && typeof v === "object" ? Object.assign({}, v) : v);
    }
    return a;
  };
  return deep(t, s || {});
}

const clampRel = (x) => Math.max(0.55, Math.min(1.5, x));

// Слияние мозга аккаунта (inc) в глобальный (g). Правила:
//  - счётчики сделок — по-контрибуторский max (монотонность, идемпотентность);
//  - веса факторов rel — α-смешение по объёму сделок (α 0.1…0.5, без резких скачков);
//  - symStats — max по n/wins, стрик по большей |streak| (консервативно);
//  - порог входа — то же α-смешение с капами 70…80;
//  - флаги и уроки — объединение.
export function mergeBrainGlobal(g, inc, from) {
  if (!g || !inc || typeof inc !== "object") return g;
  const contrib = (g.contrib = g.contrib || {});
  const cKey = String(from || "?").slice(0, 24);
  const c = contrib[cKey] = contrib[cKey] || { trades: 0, wins: 0, losses: 0, longTrades: 0, longWins: 0 };
  const mx = (a, b) => (Number.isFinite(a) && a >= b ? a : b);
  c.trades = mx(c.trades, Number(inc.trades) || 0);
  c.wins = mx(c.wins, Number(inc.wins) || 0);
  c.losses = mx(c.losses, Number(inc.losses) || 0);
  // R52: лонг-счётчики сливаются так же монотонно (max по контрибуторам)
  c.longTrades = mx(c.longTrades || 0, Number(inc.longTrades) || 0);
  c.longWins = mx(c.longWins || 0, Number(inc.longWins) || 0);
  let gTrades = 0, gWins = 0, gLosses = 0, gLongTrades = 0, gLongWins = 0;
  for (const k of Object.keys(contrib)) {
    gTrades += contrib[k].trades || 0; gWins += contrib[k].wins || 0; gLosses += contrib[k].losses || 0;
    gLongTrades += contrib[k].longTrades || 0; gLongWins += contrib[k].longWins || 0;
  }
  g.trades = gTrades; g.wins = gWins; g.losses = gLosses;
  g.longTrades = gLongTrades; g.longWins = Math.min(gLongWins, gLongTrades);
  // α: вклад входящего мозга тем больше, чем больше у него своих сделок
  const incTrades = (Number(inc.trades) || 0) || (Number(inc.wins) || 0) + (Number(inc.losses) || 0);
  const alpha = Math.max(0.1, Math.min(0.5, incTrades / (incTrades + gTrades || 1)));
  if (inc.rel && typeof inc.rel === "object") {
    const rel = (g.rel = g.rel || {});
    for (const k of Object.keys(inc.rel)) {
      const v = Number(inc.rel[k]);
      if (!Number.isFinite(v)) continue;
      const cur = Number.isFinite(rel[k]) ? rel[k] : 1;
      rel[k] = clampRel(cur + (v - cur) * alpha);
    }
  }
  if (inc.symStats && typeof inc.symStats === "object") {
    const st = (g.symStats = g.symStats || {});
    // R52: под-статистики long/short сливаются отдельно (max по n) — иначе при
    // победе агрегата с большим n лонг-опыт другой стороны терялся бы целиком
    const pickSide = (a, b) => {
      if (!a || typeof a !== "object" || !(Number(a.n) > 0)) return b && Number(b.n) > 0 ? { n: Number(b.n), wins: Number(b.wins) || 0, streak: Number(b.streak) || 0, avgPct: Number(b.avgPct) || 0 } : undefined;
      if (!b || typeof b !== "object" || !(Number(b.n) > 0)) return { n: Number(a.n), wins: Number(a.wins) || 0, streak: Number(a.streak) || 0, avgPct: Number(a.avgPct) || 0 };
      const w = (Number(b.n) || 0) > (Number(a.n) || 0) ? b : a;
      return { n: Number(w.n) || 0, wins: Number(w.wins) || 0, streak: Number(w.streak) || 0, avgPct: Number(w.avgPct) || 0 };
    };
    for (const k of Object.keys(inc.symStats)) {
      const s = inc.symStats[k];
      if (!s || typeof s !== "object") continue;
      const cur = st[k];
      if (!cur || (Number(s.n) || 0) >= (Number(cur.n) || 0)) {
        st[k] = {
          n: Number(s.n) || 0, wins: Number(s.wins) || 0, streak: Number(s.streak) || 0, avgPct: Number(s.avgPct) || 0,
          long: pickSide(cur && cur.long, s.long),
          short: pickSide(cur && cur.short, s.short),
        };
      } else if (s.long || s.short) {
        cur.long = pickSide(cur.long, s.long);
        cur.short = pickSide(cur.short, s.short);
      }
    }
  }
  if (Number.isFinite(Number(inc.confThreshold)) && Number(inc.confThreshold) > 0) {
    const target = Math.max(70, Math.min(80, Math.round(Number(inc.confThreshold))));
    const cur = Math.max(70, Math.min(80, Math.round(Number(g.confThreshold) || 74)));
    g.confThreshold = Math.max(70, Math.min(80, Math.round(cur + (target - cur) * alpha)));
  }
  if (inc.wFlags && typeof inc.wFlags === "object") {
    const wf = (g.wFlags = g.wFlags || {});
    for (const k of Object.keys(inc.wFlags)) if (inc.wFlags[k]) wf[k] = 1;
  }
  // R49: калибровка уверенности — бакеты по-контрибуторски max по n (монотонно),
  // offset ВСЕГДА пересчитывается из слитых бакетов по единой формуле: повторная
  // отправка принятых бакетов ничего не меняет (идемпотентность), дрейфа нет
  if (inc.calib && typeof inc.calib === "object") {
    const gc = (g.calib = g.calib && typeof g.calib === "object" ? g.calib : { lo: { n: 0, w: 0 }, mid: { n: 0, w: 0 }, hi: { n: 0, w: 0 }, offset: 0 });
    for (const k of ["lo", "mid", "hi"]) {
      const b = inc.calib[k];
      if (!b || typeof b !== "object") continue;
      const cur = gc[k] = gc[k] || { n: 0, w: 0 };
      if ((Number(b.n) || 0) >= (Number(cur.n) || 0)) gc[k] = { n: Number(b.n) || 0, w: Number(b.w) || 0 };
    }
    gc.offset = calibOffsetOf(gc);
  }
  if (Array.isArray(inc.lessons) && inc.lessons.length) {
    const seen = new Set((g.lessons || []).map((l) => l && l.text));
    for (const l of inc.lessons.slice(0, 40)) {
      if (!l || !l.text || seen.has(l.text)) continue;
      seen.add(l.text);
      g.lessons = [{ ts: Number(l.ts) || Date.now(), text: String(l.text).slice(0, 220) }, ...g.lessons];
    }
    g.lessons = g.lessons.sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 30);
  }
  if ((Number(inc.shadowWrong) || 0) > (Number(g.shadowWrong) || 0)) g.shadowWrong = Number(inc.shadowWrong) || 0;
  if ((Number(inc.shadowTuneAt) || 0) > (Number(g.shadowTuneAt) || 0)) g.shadowTuneAt = Number(inc.shadowTuneAt) || 0;
  g.updatedAt = Date.now();
  return g;
}

// Слияние тени (доверие по монетам, пропуски скана, агрегаты) — max-слияние
// монотонных счётчиков; adj пересчитывается по единой формуле trustAdjFrom.
export function mergeShadowGlobal(g, inc) {
  if (!g || typeof g !== "object") g = {};
  if (!inc || typeof inc !== "object") return g;
  const mx = (a, b) => (Number.isFinite(a) && a >= b ? a : b);
  if (inc.stats && typeof inc.stats === "object") {
    const st = (g.stats = g.stats || {});
    for (const k of ["right", "wrong", "flat", "avoidedSum", "avoidedN"]) st[k] = mx(Number(st[k]) || 0, Number(inc.stats[k]) || 0);
    const since = Number(inc.stats.since) || 0;
    if (since && (!st.since || since < st.since)) st.since = since;
  }
  if (inc.trust && typeof inc.trust === "object") {
    const tr = (g.trust = g.trust || {});
    for (const k of Object.keys(inc.trust)) {
      const t = inc.trust[k];
      if (!t || typeof t !== "object") continue;
      const cur = tr[k] || {};
      const merged = {
        right: mx(Number(cur.right) || 0, Number(t.right) || 0),
        wrong: mx(Number(cur.wrong) || 0, Number(t.wrong) || 0),
        flat: mx(Number(cur.flat) || 0, Number(t.flat) || 0),
        ts: Math.max(Number(cur.ts) || 0, Number(t.ts) || 0),
      };
      merged.adj = trustAdjFrom(merged);
      tr[String(k).slice(0, 12)] = merged;
    }
  }
  if (inc.skip && typeof inc.skip === "object") {
    const sk = (g.skip = g.skip || {});
    const now = Date.now();
    for (const k of Object.keys(inc.skip)) {
      const until = Number(inc.skip[k]);
      if (!Number.isFinite(until) || until <= now) continue;
      if (!sk[k] || until > Number(sk[k])) sk[String(k).slice(0, 12)] = until;
    }
    for (const k of Object.keys(sk)) if (Number(sk[k]) <= now) delete sk[k];
  }
  return g;
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
    ntfy: { on: false, topic: "", last: null }, // R50: резервный канал ntfy (не зависит от Chrome/SW)
    host: { id: "server", tag: "Сервер XenoAI", until: 9e15 }, // исполнитель — всегда сервер
    aiIdeas: [],
    shadow: defaultShadow(), // R43: теневая торговля — журнал отказов ИИ и их проверка временем
    liveOpen: [], // R49: открытые реальные покупки (FIFO-очередь для расчёта PnL реальных сделок)
    liveStats: { n: 0, wins: 0, losses: 0, pnlUsdt: 0, since: 0 }, // R49: итог обучения на реальных сделках
    glmVerdict: null, // R49: последний вердикт GLM-аналитика сервера (без ключа — только вердикт)
    okx: defaultOkx(), // R51: полная синхронизация с OKX (публичное состояние; ключи — в storage DO)
    realQueue: [], // R51: персист-очередь реальных ордеров OKX (переживает перезапуск DO)
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
  // R49: реальные сделки (FIFO-очередь + статистика обучения) и вердикт GLM-аналитика
  if (Array.isArray(d.liveOpen)) {
    a.liveOpen = d.liveOpen.filter((o) => o && typeof o.sym === "string" && Number(o.amount) > 0 && Number(o.price) > 0 && typeof o.ts === "number")
      .slice(0, 20).map((o) => ({ id: String(o.id || "").slice(0, 24), sym: String(o.sym).slice(0, 16), amount: Number(o.amount), price: Number(o.price), ts: Number(o.ts) }));
  }
  if (d.liveStats && typeof d.liveStats === "object") {
    const ls = a.liveStats = a.liveStats || { n: 0, wins: 0, losses: 0, pnlUsdt: 0, since: 0 };
    for (const k of ["n", "wins", "losses", "pnlUsdt"]) { const v = Number(d.liveStats[k]); if (Number.isFinite(v)) ls[k] = k === "pnlUsdt" ? v : Math.max(0, Math.round(v)); }
    if (Number(d.liveStats.since) > 0) ls.since = Number(d.liveStats.since);
  }
  if (d.glmVerdict && typeof d.glmVerdict === "object") {
    const v = d.glmVerdict;
    a.glmVerdict = {
      bias: v.bias === "лонг" || v.bias === "шорт" || v.bias === "flat" ? v.bias : "flat",
      confidence: Math.max(0, Math.min(100, Math.round(Number(v.confidence) || 0))),
      reasoning: String(v.reasoning || "").slice(0, 240),
      ts: Number(v.ts) || 0, model: String(v.model || "").slice(0, 40),
      status: v.status === "ok" || v.status === "error" ? v.status : "error",
      error: String(v.error || "").slice(0, 160),
    };
  }
  // R51: публичное состояние OKX и очередь реальных ордеров (секреты через архив НЕ ходят)
  if (d.okx && typeof d.okx === "object") a.okx = normalizeOkx(d.okx);
  if (Array.isArray(d.realQueue)) a.realQueue = normalizeRealQueue(d.realQueue);
  if (Array.isArray(d.pushSubs)) a.pushSubs = d.pushSubs.filter((s) => s && typeof s.endpoint === "string" && s.endpoint.indexOf("https://") === 0 && s.keys && s.keys.p256dh && s.keys.auth).slice(0, 8);
  if (d.ntfy && typeof d.ntfy === "object") a.ntfy = normalizeNtfy(d.ntfy); // R50
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
    this.glmCfg = null;         // R49: конфиг GLM-аналитика сервера {endpoint, model, apiKey, on} (живёт в storage DO, НЕ в архиве)
    this._glmAt = 0;            // R49: когда последний раз спрашивали GLM (троттл)
    this.okxCfg = null;         // R51: ключи OKX {apiKey, secret, pass} — storage DO, НЕ архив (как glmCfg)
    this._okxSyncAt = 0;        // R51: троттл синхронизации баланса OKX (не чаще 5 мин)
    this._whaleIdx = 0;         // R49: ротация китового скана по кругу вотчлиста
    this._whaleAt = {};         // R49: sym → когда монета последний раз сканилась китовой лентой
  }

  price(sym) { const p = this.prices[sym]; return p && p.price ? p.price : (this.a.prices && this.a.prices[sym]) || null; }

  // ================= R52: РЕАЛЬНЫЙ РЫНОК = USDT (без ХРЮ) =================
  // Пользователь: «на реальном рынке ХРЮ не нужны, всё должно быть в USDT».
  // В live-режиме валюта сделок — реальные USDT с баланса OKX: размер, лимиты,
  // PnL и события — всё в USDT; баланс демо-счёта (ХРЮ) не трогается вовсе.
  isLive() { return this.a.mode === "live"; }
  cur() { return this.isLive() ? "USDT" : "ХРЮ"; }
  // база для лимитов нагрузки: демо — баланс ХРЮ, live — реальные USDT (баланс биржи + вложенное в позиции)
  tradeBase() {
    if (!this.isLive()) return this.a.balance;
    const ox = this.a.okx || {};
    let v = Number.isFinite(ox.balanceUSDT) ? ox.balanceUSDT : 0;
    for (const p of this.a.userPositions) if (p.live && p.live.qty) v += p.size || 0; // уже потрачено на токены
    return v;
  }
  // свободные USDT под НОВУЮ сделку: баланс биржи минус то, что ещё не учтено синком
  // (заявки в очереди + покупки, исполненные ПОСЛЕ последней синхронизации баланса)
  liveAvailableUsdt() {
    const ox = this.a.okx || {};
    if (!Number.isFinite(ox.balanceUSDT)) return null; // синхронизации ещё не было
    let spent = 0, lastFillTs = 0;
    for (const p of this.a.userPositions) {
      if (p.live && p.live.qty) { spent += p.size || 0; lastFillTs = Math.max(lastFillTs, p.live.ts || 0); }
    }
    let pending = 0, lastQueuedTs = 0;
    for (const j of this.a.realQueue || []) {
      if (j.kind === "buy") { pending += j.usdt || 0; lastQueuedTs = Math.max(lastQueuedTs, j.ts || 0); }
    }
    // свежий синк (после всех покупок) уже вычел потраченное из баланса — вычитаем только очередь;
    // устаревший синк ещё видит потраченное на бирже — вычитаем и его (консервативно, оверспенда нет)
    const fresh = (Number(ox.lastSync) || 0) >= Math.max(lastFillTs, lastQueuedTs);
    return Math.max(0, Math.round(((ox.balanceUSDT - (fresh ? pending : spent + pending)) || 0) * 100) / 100);
  }

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
  aiKellyFrac(longOnly) {
    const b = this.brain;
    // сглаженный винрейт (Лаплас, априор 50%); Kelly для RR 1:2: f* = 1.5p − 0.5,
    // четверть и кламп 2..10% — ровно как в браузере (store.js)
    // R52: longOnly (реальный рынок) — применяем ОПЫТ ПО ЛОНГАМ (шортов там нет):
    // до накопления лонг-сделок действует тот же априор 50%
    const tr = longOnly ? (b.longTrades || 0) : (b.trades || 0);
    const wn = longOnly ? (b.longWins || 0) : (b.wins || 0);
    const p = (wn + 3) / (tr + 6);
    const f = 1.5 * p - 0.5;
    return Math.max(0.02, Math.min(0.1, 0.25 * Math.max(0, f)));
  }
  aiSizeCalc() {
    const cap = this.aiDealCap();
    const remain = this.aiTotalRemain();
    // R53: келли от ЛОНГ-опыта во ВСЕХ режимах — демо повторяет реальный рынок 1:1:
    // тот же размер, тот же опыт, тот же перенос на реальные USDT
    const bal = this.isLive() ? (this.liveAvailableUsdt() || 0) : this.a.balance;
    let size = Math.round(bal * this.aiKellyFrac(true));
    size = Math.min(size, cap, Math.round(remain), Math.round(bal));
    const floor = Math.min(AI_MIN_SIZE, cap);
    if (!Number.isFinite(size) || size < floor) {
      if (bal >= floor && remain >= floor) size = floor;
      else return { size: 0, why: this.isLive() ? "не хватает свободных USDT на OKX или суммарного лимита" : "не хватает свободных хрювен или суммарного лимита" };
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
    const bal = this.tradeBase(), inMarket = this.openPositionsSum(); // R52: live — реальные USDT
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
        // R45: исход отказа копит ДОВЕРИЕ к монете — будущий подбор монет и решения по сигналам
        try {
          const tr = sh.trust = sh.trust || {};
          const t = tr[e.sym] = tr[e.sym] || { right: 0, wrong: 0, flat: 0, adj: 0, ts: 0 };
          t[e.verdict] = (t[e.verdict] || 0) + 1;
          t.adj = trustAdjFrom(t);
          t.ts = now;
          this.shadowSkipMaybe(e.sym, sh);
        } catch (x) { /* доверие не критично */ }
        try { this.shadowLearn(e, sh); } catch (x) { /* обратная связь не критична */ }
      }
    }
  }

  // R44: обратная связь «тень → ИИ». Отказ с кодом «порог», оказавшийся ОШИБОЧНЫМ
  // (монета пошла бы в плюс), значит: фильтр был слишком строг для таких входов.
  // Каждые 2 таких ошибки порог входа снижается на 1% (пол 72 — жёсткое дно по требованию
  // «>74% открывается само», ниже базового 74 на два деления максимум). Правильные отказы
  // порог НЕ поднимают: ужесточать торговлю по своей же статистике — путь к заморозке (кейс R40).
  // Гварды остальных фильтров (ансамбль/скам/риск/нагрузка) тенью не трогаются — они структурные.
  shadowLearn(e, sh) {
    if (!e || e.verdict !== "wrong" || e.whyCode !== "порог") return;
    const br = this.brain;
    if (!br) return;
    br.shadowWrong = (br.shadowWrong || 0) + 1;
    const now = Date.now();
    if (br.shadowWrong % 2 !== 0) return;               // каждые 2 ошибочных отказа
    if (now - (br.shadowTuneAt || 0) < 3600e3) return;  // не чаще раза в час
    const from = br.confThreshold || 74;
    if (from <= 72) return;                             // пол — ниже не опускаем
    br.shadowTuneAt = now;
    br.confThreshold = from - 1;
    this.pushLesson(`Тень: отказы по порогу оказались ошибочными (${br.shadowWrong} шт. суммарно, последний «+${e.hypPct}%» по ${e.sym}) — снизил порог входа до ${br.confThreshold}%`);
    sh.tune = [{ ts: now, from, to: br.confThreshold, why: "ошибочные отказы по порогу" }, ...(sh.tune || [])].slice(0, 10);
  }

  // ================= R45: тень → доверие к монетам =================
  // Прибавка/скидка к уверенности по монете: где фильтр ошибочно резал плюсовые
  // входы — доверие подрастает (вход доступнее), где отказы стабильно верны — скидка.
  shadowTrustAdj(sym) {
    const sh = this.a.shadow;
    const t = sh && sh.trust ? sh.trust[sym] : null;
    return t ? (Number(t.adj) || 0) : 0;
  }

  shadowSkipActive(sym) {
    const sh = this.a.shadow;
    return Boolean(sh && sh.skip && sh.skip[sym] && sh.skip[sym] > Date.now());
  }

  // Монета, у которой отказы СТАБИЛЬНО верны (right ≥ 3 и right ≥ 3×wrong), — мусорка,
  // где ИИ каждый раз правильно не покупал. Убираем её со скана на 12 часов: слоты
  // «лучших идей» не занимают заведомо плохие монеты — подбор улучшается.
  shadowSkipMaybe(sym, sh) {
    const t = sh.trust && sh.trust[sym];
    if (!t) return;
    const now = Date.now();
    if (sh.skip && sh.skip[sym] && sh.skip[sym] > now) return; // уже в тени
    if ((Number(t.right) || 0) >= SKIP_RIGHT_N && (Number(t.right) || 0) >= SKIP_RATIO * (Number(t.wrong) || 0)) {
      sh.skip = sh.skip || {};
      sh.skip[sym] = now + SKIP_MS;
      const n = (Number(t.right) || 0) + (Number(t.wrong) || 0) + (Number(t.flat) || 0);
      this.a.aiIdeas = (this.a.aiIdeas || []).filter((i) => i.sym !== sym); // идея монеты снимается немедленно
      this.pushLesson(`Тень: по ${sym} отказы стабильно верны (${t.right} из ${n} разобранных) — снял монету со скана ИИ на 12 ч`);
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

  symBias(sym, side) {
    const st = this.brain.symStats[sym];
    if (!st || st.n < 3) return 0;
    // R52: ОПЫТ ПО НАПРАВЛЕНИЯМ. На реальном рынке (только лонги) применяем именно
    // лонг-стрик монеты: шорт-минуса той же монеты не должны душить лонг-входы
    const d = side === "лонг" ? st.long : side === "шорт" ? st.short : null;
    const use = d && Number(d.n) >= 3 ? d : st;
    if (use.streak >= 3) return 3;
    if (use.streak <= -3) return -Math.min(10, 2 * Math.abs(use.streak));
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

  // ================= R49: КИТЫ НА СЕРВЕРЕ =================
  // Ротация: за тик сканируем лентой aggTrades до 3 монет (приоритет — открытые
  // позиции, затем круг вотчлиста), каждую — не чаще раза в 8 минут. Крупные сделки
  // (≥ $15K) копятся в this.whales[sym] — их читает aiWhaleBias (60-минутное окно),
  // который раньше на сервере всегда возвращал null: лента не качалась вовсе.
  async whaleScan(syms) {
    if (!this.hooks.fetchAggTrades) return;
    const now = Date.now();
    // приоритет: монеты открытых позиций (их китовые продажи критичны), затем ротация;
    // дедуп — монета в очереди один раз (иначе дубль из rest+WATCHLIST бил бы ленту дважды)
    const posSyms = Array.from(new Set(this.a.userPositions.map((p) => p.sym)));
    const rest = (syms || []).filter((s) => !posSyms.includes(s));
    const queue = Array.from(new Set([...posSyms, ...rest, ...WATCH_SYMS])).filter((s) => BY_SYM[s]);
    const picked = [];
    for (const sym of queue) {
      if (picked.length >= WHALE_PER_TICK) break;
      if (now - (this._whaleAt[sym] || 0) < WHALE_THROTTLE_MS) continue;
      picked.push(sym);
    }
    for (const sym of picked) {
      this._whaleAt[sym] = now;
      const inst = BY_SYM[sym];
      try {
        const trades = await this.hooks.fetchAggTrades(inst.pair, 500);
        if (!Array.isArray(trades)) continue;
        const whales = trades
          .map((t) => ({ id: t.id, sym, price: t.price, qty: t.qty, notional: t.price * t.qty, time: t.time, side: t.isBuyerMaker ? "sell" : "buy" }))
          .filter((t) => t.notional >= WHALE_MIN_NOTIONAL && t.time > 0)
          .sort((a, b) => b.time - a.time)
          .slice(0, WHALE_KEEP);
        this.whales[sym] = whales;
      } catch (e) {
        this.tickLog.push("whales " + sym + ": " + String((e && e.message) || e).slice(0, 60));
      }
    }
  }

  // ================= R49: GLM-АНАЛИТИК НА СЕРВЕРЕ =================
  // Вердикт языковой модели как 13-й фактор ансамбля — теперь 24/7, без открытой
  // вкладки браузера. Конфиг (ключ) живёт в storage DO (в архив/на устройства НЕ
  // попадает), сам вердикт — в архиве (a.glmVerdict), чтобы фактор переживал
  // перезапуск изолята и был виден на всех устройствах.
  glmFactor() {
    const v = this.a.glmVerdict;
    if (!this.glmCfg || !this.glmCfg.on || !v || v.status !== "ok" || !v.bias || v.bias === "flat") return null;
    const ageH = (Date.now() - (v.ts || 0)) / 36e5;
    if (ageH > GLM_DECAY_H) return null;
    const decay = Math.max(0.35, 1 - ageH / GLM_DECAY_H);
    const dir = v.bias === "лонг" ? 1 : v.bias === "шорт" ? -1 : 0;
    const strength = ((v.confidence || 0) / 100) * decay;
    if (dir === 0 || strength < GLM_MIN_STRENGTH) return null;
    return {
      dir: dir * strength,
      detail: `GLM ${v.bias} (${v.confidence}%${ageH > 0.25 ? `, ${Math.round(ageH * 60)} мин назад` : ""}): ${v.reasoning || "без обоснования"}`,
    };
  }

  // сводка рынка для GLM — то же, что видел бы браузерный аналитик
  glmBrief() {
    const lines = [];
    const px = (sym) => (this.prices[sym] && this.prices[sym].price) || 0;
    const chg = (sym) => (this.prices[sym] && this.prices[sym].chg24h) || 0;
    if (px("BTC")) lines.push(`BTC $${px("BTC").toFixed(0)} (${chg("BTC") >= 0 ? "+" : ""}${chg("BTC").toFixed(1)}%/24ч)`);
    if (px("ETH")) lines.push(`ETH $${px("ETH").toFixed(0)} (${chg("ETH") >= 0 ? "+" : ""}${chg("ETH").toFixed(1)}%/24ч)`);
    const movers = Object.values(this.prices).filter((p) => p.price > 0).sort((a, b) => Math.abs(b.chg24h) - Math.abs(a.chg24h)).slice(0, 5);
    if (movers.length) lines.push("Топ движений 24ч: " + movers.map((p) => `${p.sym} ${p.chg24h >= 0 ? "+" : ""}${p.chg24h.toFixed(1)}%`).join(", "));
    if (this.brain.trades) lines.push(`Винрейт нашего ансамбля: ${Math.round((this.brain.wins / this.brain.trades) * 100)}% на ${this.brain.trades} сделках`);
    const wb = this.aiWhaleBias("BTC"), we = this.aiWhaleBias("ETH");
    if (wb) lines.push("Поток китов BTC: " + wb.detail);
    if (we) lines.push("Поток китов ETH: " + we.detail);
    if (this.news.items && this.news.items.length) {
      lines.push("Свежие заголовки:");
      this.news.items.slice(0, 8).forEach((n) => lines.push("— " + String(n.title || "").slice(0, 110)));
    }
    return lines.join("\n");
  }

  async glmAsk(force) {
    const cfg = this.glmCfg;
    if (!cfg || !cfg.on || !cfg.apiKey) return this.a.glmVerdict;
    const now = Date.now();
    if (!force && now - this._glmAt < GLM_ASK_MS) return this.a.glmVerdict;
    this._glmAt = now;
    const SYSTEM = "Ты — крипто-аналитик внутри торговой платформы. Тебе дают краткую сводку рынка. Дай ОДИН вердикт по рынку на ближайшие часы. Ответ строго в JSON без markdown: {\"bias\":\"long\"|\"short\"|\"flat\",\"confidence\":0-100,\"reasoning\":\"1-2 предложения по-русски с ключевой причиной\"}. Не выдумывай данные, которых нет в сводке.";
    try {
      const res = await fetch(cfg.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + cfg.apiKey },
        body: JSON.stringify({
          model: cfg.model || "glm-4-flash",
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: this.glmBrief() },
          ],
          temperature: 0.3,
          max_tokens: 220,
        }),
        signal: AbortSignal.timeout(15000),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((j.error && j.error.message) || "HTTP " + res.status);
      const txt = (((j.choices || [])[0] || {}).message || {}).content || "";
      const m = txt.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("в ответе нет JSON");
      const parsed = JSON.parse(m[0]);
      const bias = parsed.bias === "long" ? "лонг" : parsed.bias === "short" ? "шорт" : "flat";
      const conf = Math.max(0, Math.min(100, Math.round(Number(parsed.confidence) || 0)));
      this.a.glmVerdict = {
        bias, confidence: conf,
        reasoning: String(parsed.reasoning || "").slice(0, 240),
        ts: Date.now(), model: cfg.model || "glm-4-flash", status: "ok", error: "",
      };
    } catch (e) {
      this.a.glmVerdict = { bias: "flat", confidence: 0, reasoning: "", ts: Date.now(), model: cfg.model || "", status: "error", error: String((e && e.message) || e).slice(0, 160) };
    }
    return this.a.glmVerdict;
  }

  effAuto() { return this.a.mode === "live" ? !!this.a.aiAutoLive : !!this.a.aiAuto; }
  totalEquity() {
    // R52: в live «капитал» — это реальные деньги: баланс USDT на бирже + плавающий PnL
    // открытых позиций (маржа внутри уже потрачена — размер второй раз не прибавляем)
    if (this.isLive()) {
      const ox = this.a.okx || {};
      let v = Number.isFinite(ox.balanceUSDT) ? ox.balanceUSDT : 0;
      for (const p of this.a.userPositions) {
        const price = this.price(p.sym) || p.entry;
        v += Engine.positionPnl(p, price).pnl;
      }
      return v;
    }
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
  // R49: накопление опыта по монете (n/wins/streak/avgPct) — общий для demo-ИИ сделок
  // и реальных сделок (liveOrder): symBias читает symStats при ЛЮБОМ входе, значит
  // реальные сделки теперь тоже влияют на решения автопилота
  // R52: + под-статистики ПО НАПРАВЛЕНИЯМ (long/short) — реальный рынок применяет
  // лонг-опыт в первую очередь (шорты на споте OKX невозможны)
  learnSymStats(sym, won, pnlPct, side) {
    const brain = this.brain;
    const st = brain.symStats[sym] || { n: 0, wins: 0, streak: 0, avgPct: 0 };
    st.n++;
    if (won) { st.wins++; st.streak = st.streak < 0 ? 1 : st.streak + 1; }
    else { st.streak = st.streak > 0 ? -1 : st.streak - 1; }
    st.avgPct = (st.avgPct * (st.n - 1) + (pnlPct || 0)) / st.n;
    const sk = side === "шорт" ? "short" : "long";
    const d = st[sk] = st[sk] || { n: 0, wins: 0, streak: 0, avgPct: 0 };
    d.n++;
    if (won) { d.wins++; d.streak = d.streak < 0 ? 1 : d.streak + 1; }
    else { d.streak = d.streak > 0 ? -1 : d.streak - 1; }
    d.avgPct = (d.avgPct * (d.n - 1) + (pnlPct || 0)) / d.n;
    brain.symStats[sym] = st;
    return st;
  }
  learnFromClosed(c, isLab) {
    if (!c) return;
    const brain = this.brain;
    const isAi = c.strategy === "ai";
    const labTrade = Boolean(isLab || (c.ai && c.ai.lab));
    const hasFactors = Boolean(c.ai && Array.isArray(c.ai.factors) && c.ai.factors.length);
    const won = c.pnl >= 0;
    if (isAi) {
      brain.trades++; if (won) brain.wins++; else brain.losses++;
      // R52: ЛОНГ-ОПЫТ отдельно — именно он применяется на реальном рынке (спот OKX,
      // только лонги): келли-размер и байес-винрейт там считают longTrades/longWins
      if (!labTrade && c.side === "лонг") {
        brain.longTrades = (brain.longTrades || 0) + 1;
        if (won) brain.longWins = (brain.longWins || 0) + 1;
      }
      // R49: КАЛИБРОВКА УВЕРЕННОСТИ — исход ИИ-сделки ложится в бакет по её уверенности
      // на входе; offset (−6…+6) пересчитывается по единой формуле calibOffsetOf
      if (!labTrade && c.ai && Number.isFinite(c.ai.confidence)) {
        const cal = brain.calib = normalizeCalib(brain.calib);
        const conf = Math.round(c.ai.confidence);
        const bk = conf > 80 ? cal.hi : conf >= 75 ? cal.mid : cal.lo;
        bk.n++; if (won) bk.w++;
        const before = cal.offset;
        cal.offset = calibOffsetOf(cal);
        if (Math.abs(cal.offset - before) >= 2) {
          this.pushLesson(`калибровка уверенности: фактический винрейт говорит сдвинуть доверие на ${cal.offset > 0 ? "+" : ""}${cal.offset} (было ${before}) — порог входа и флипы учитывают это`);
        }
      }
    }
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
    const st = this.learnSymStats(c.sym, won, c.pnlPct, c.side); // R52: опыт копится по направлениям
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
      if (!this.isLive()) this.a.balance += closed.size + closed.pnl; // R52: live — без ХРЮ, USDT вернутся с биржи
      this.learnFromClosed(closed);
      this.hookRealClose(pos, closed); // R51: каждая реальная нога продается на OKX
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
    const cur = this.cur(); // R52: live — USDT, демо — ХРЮ
    this.pushEvent({
      tone: isProfit ? "bull" : "bear",
      title: isProfit ? `Авто-стоп сессии ИИ: +${info.pct.toFixed(1)}% ≥ +${th}%` : `Авто-стоп сессии ИИ: ${info.pct.toFixed(1)}% ≤ −${th}%`,
      detail: (isProfit ? `ИИ наторговал ${Fmt.fmtNum(Math.round(info.pnl))} ${cur} профита` : `просадка ${Fmt.fmtNum(Math.round(Math.abs(info.pnl)))} ${cur}`)
        + ` — автопилот закрыл все ИИ-сделки по рынку (${closedList.length} шт., итог ${sumPnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(sumPnl)))} ${cur}) и ждёт возобновления`,
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

  // ================= R51: ПОЛНАЯ СИНХРОНИЗАЦИЯ OKX — ИСПОЛНИТЕЛЬ =================
  // Новые ордера ставятся в очередь только при активном реальном режиме; невыполненные
  // хвосты (продажи открытых ранее реальных ног) разгребаются при любом режиме —
  // иначе токен остался бы на бирже после переключения в демо.
  okxOn() { return Boolean(this.a.okx && this.a.okx.on && this.okxCfg); }
  okxSyncActive() { return this.okxOn() && this.a.mode === "live" && this.a.okx.auto !== false; }

  // задача в персист-очередь (дедуп по posId+kind — двойной тап не дублирует ордер)
  queueReal(kind, job) {
    if (!this.a.realQueue) this.a.realQueue = [];
    const dup = this.a.realQueue.find((j) => j.kind === kind && j.posId && j.posId === job.posId);
    if (dup) return dup;
    const j = {
      id: "rq" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      kind, sym: job.sym, instId: job.instId, usdt: Number(job.usdt) || 0, qty: Number(job.qty) || 0,
      posId: String(job.posId || ""), attempts: 0, ts: Date.now(), lastErr: "", note: String(job.note || "").slice(0, 80),
    };
    this.a.realQueue = [...this.a.realQueue, j].slice(-40);
    return j;
  }

  unqueueReal(posId, kind) {
    if (!this.a.realQueue || !posId) return 0;
    const before = this.a.realQueue.length;
    this.a.realQueue = this.a.realQueue.filter((j) => !(j.posId === posId && (!kind || j.kind === kind)));
    return before - this.a.realQueue.length;
  }

  // после УСПЕШНОГО открытия сделки: в live-режиме с синхронизацией ставим реальную покупку.
  // R52: шортов в live больше нет вовсе (placeDemo их не пропускает) — защищаемся от рассинхрона
  hookRealOpen(pos) {
    if (!pos || !this.okxSyncActive()) return;
    const a = this.a;
    if (pos.side !== "лонг") {
      this.tickLog.push("okx: открыт " + pos.side + " по " + pos.sym + " — спот не умеет, реальный ордер не ставим");
      return;
    }
    const usdt = Math.max(0, Math.round((pos.size || 0) * 100) / 100);
    if (usdt < 5) return; // ниже разумного минимума OKX — не тратим комиссию
    pos.realPending = true;
    this.queueReal("buy", { posId: pos.id, sym: pos.sym, instId: pos.sym, usdt });
  }

  // после ЗАКРЫТИЯ сделки: открытая реальная нога должна быть продана на OKX.
  hookRealClose(pos, closed) {
    if (!pos) return;
    const a = this.a;
    if (pos.realPending && !pos.live) {
      // покупка ещё не исполнилась (или не успела) — снимаем её, чтобы не купить токен «в никуда»
      const removed = this.unqueueReal(pos.id, "buy");
      if (removed && closed) this.pushEvent({
        tone: "neutral", sym: pos.sym,
        title: `${pos.sym}: реальная покупка отменена`,
        detail: "сделка закрылась раньше, чем OKX исполнил покупку — заявка снята с очереди, деньги не потрачены",
      });
      if (pos.realPending) delete pos.realPending;
      return;
    }
    if (!pos.live || !pos.live.qty) return;
    const qty = pos.live.qty;
    this.queueReal("sell", { posId: pos.id, sym: pos.sym, instId: pos.sym, qty, note: closed ? closed.exitReason : "" });
    if (closed) {
      this.pushEvent({
        tone: closed.pnl >= 0 ? "bull" : "bear", sym: pos.sym,
        title: `OKX: продаю ${pos.sym} по закрытию сделки`,
        detail: `реальные ${Fmt.fmtNum(Math.round(qty * 1e6) / 1e6)} ${pos.sym} (куплены по ${pos.live.entryPx ? String(pos.live.entryPx).slice(0, 12) : "—"}) уйдут на рынок, USDT вернутся на баланс биржи · причина закрытия: ${closed.exitReason}`,
        notify: { kind: "okx_sell" },
      });
    }
  }

  // РЕАЛЬНАЯ покупка исполнена: привязываем ногу к позиции + FIFO живых покупок
  recordRealBuy(job, fill) {
    const a = this.a;
    if (!a.liveOpen) a.liveOpen = [];
    const entry = { id: "lo" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), sym: job.sym, amount: fill.fillUsd || job.usdt, price: fill.avgPx, ts: Date.now() };
    a.liveOpen = [...a.liveOpen, entry].slice(-20);
    a.liveOrders = [{
      sym: job.sym, side: "лонг", amountUSDT: entry.amount, exchange: "OKX",
      note: job.note || "полная синхронизация", price: fill.avgPx > 0 ? fill.avgPx : null, ts: Date.now(),
    }, ...(a.liveOrders || [])].slice(0, 50);
    const pos = (a.userPositions || []).find((p) => p.id === job.posId);
    if (pos) {
      // R52: вход = реальная цена биржи — PnL позиции с этого момента считается от факта
      pos.entry = fill.avgPx;
      pos.usdt = true;
      pos.live = { instId: job.instId || job.sym, ordId: String(fill.ordId || ""), qty: fill.fillSz || 0, entryPx: fill.avgPx, ts: Date.now() };
      if (pos.realPending) delete pos.realPending;
    }
    this.pushEvent({
      id: "okxbuy-" + entry.id, tone: "bull", sym: job.sym,
      title: `OKX: куплено ${job.sym} на ${Fmt.fmtNum(Math.round(entry.amount))} USDT`,
      detail: `рыночная покупка исполнена сервером по ${fill.avgPx > 0 ? fill.avgPx.toPrecision(6) : "рынку"} · ${fill.fillSz ? Fmt.fmtNum(Math.round(fill.fillSz * 1e6) / 1e6) + " " + job.sym : ""} · токен ждёт закрытия сделки — продам автоматически${pos ? "" : " (позиция уже закрыта — сразу продаю обратно)"}`,
      notify: { kind: "okx_buy" },
    });
    // позиция уже не существует (закрылась, пока покупка висела) — немедленная продажа назад
    if (!pos) this.queueReal("sell", { posId: job.posId, sym: job.sym, instId: job.instId, qty: fill.fillSz || 0, note: "позиция закрылась до исполнения покупки" });
  }

  // РЕАЛЬНАЯ продажа исполнена: PnL по факту биржи → обучение общего мозга.
  // FIFO-сопоставление в ВАЛЮТЕ СДЕЛКИ (USDT): записи liveOpen хранят сумму покупки
  // (amount = USDT вложений) и цену входа; продажа сопоставляется на ту же величину
  // «вложений», PnL% = (цена выхода / средневзвешенная цена входа − 1) × 100.
  recordRealSell(job, fill) {
    const a = this.a;
    if (!a.liveOpen) a.liveOpen = [];
    const proceeds = fill.fillUsd > 0 ? fill.fillUsd : (fill.avgPx || 0) * (fill.fillSz || 0);
    let remain = proceeds, costSum = 0, matchedSum = 0;
    const keep = [];
    for (const lo of a.liveOpen) {
      if (lo.sym !== job.sym || remain <= 0) { keep.push(lo); continue; }
      const take = Math.min(lo.amount, remain);
      costSum += take * lo.price;
      matchedSum += take;
      remain -= take;
      if (take < lo.amount) keep.push({ ...lo, amount: Math.round((lo.amount - take) * 1e6) / 1e6 });
    }
    a.liveOpen = keep;
    a.liveOrders = [{
      sym: job.sym, side: "шорт", amountUSDT: fill.fillUsd || matchedSum * (fill.avgPx || 0), exchange: "OKX",
      note: job.note || "полная синхронизация · закрытие", price: fill.avgPx > 0 ? fill.avgPx : null, ts: Date.now(),
    }, ...(a.liveOrders || [])].slice(0, 50);
    if (matchedSum > 0 && fill.avgPx > 0) {
      const avgEntry = costSum / matchedSum;
      const pnlPct = (fill.avgPx / avgEntry - 1) * 100;
      const pnlUsdt = matchedSum * (pnlPct / 100);
      const st = this.learnSymStats(job.sym, pnlPct >= 0, pnlPct, "лонг"); // опыт — в ОБЩИЙ мозг (хаб); продажа на споте = выход из лонга
      const ls = a.liveStats = a.liveStats || { n: 0, wins: 0, losses: 0, pnlUsdt: 0, since: 0 };
      ls.n++; if (pnlPct >= 0) ls.wins++; else ls.losses++;
      ls.pnlUsdt = Math.round((ls.pnlUsdt + pnlUsdt) * 100) / 100;
      if (!ls.since) ls.since = Date.now();
      if (Math.abs(pnlPct) >= 1) {
        this.pushLesson(`OKX ${job.sym} ${pnlPct >= 0 ? "+" : "−"}${Math.abs(pnlPct).toFixed(1)}% (${matchedSum.toFixed(0)} USDT) — реальный рынок учтён (${st.n} сделок, стрик ${st.streak})`);
      }
      this.pushEvent({
        id: "okxsell-" + Date.now().toString(36), tone: pnlPct >= 0 ? "bull" : "bear", sym: job.sym,
        title: `OKX: ${job.sym} продано · реальный итог ${pnlUsdt >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(pnlUsdt)))} USDT`,
        detail: `продажа по ${fill.avgPx.toPrecision(6)} · вход ${avgEntry.toPrecision(6)} · ${pnlPct >= 0 ? "+" : "−"}${Math.abs(pnlPct).toFixed(2)}% на ${matchedSum.toFixed(2)} USDT · USDT вернулись на биржу · ИИ учёл опыт`,
        notify: { kind: "live_close", data: { pnl: pnlUsdt } },
      });
      return { pnlPct: Math.round(pnlPct * 100) / 100, pnlUsdt: Math.round(pnlUsdt * 100) / 100, matched: Math.round(matchedSum * 100) / 100, avgEntry };
    }
    this.pushEvent({
      id: "okxsell-" + Date.now().toString(36), tone: "neutral", sym: job.sym,
      title: `OKX: ${job.sym} продано`,
      detail: matchedSum > 0 ? "продажа исполнена (историю покупок найти не удалось — без расчёта PnL)" : "продажа исполнена на бирже",
      notify: { kind: "okx_sell" },
    });
    return null;
  }

  // ИСПОЛНИТЕЛЬ ОЧЕРЕДИ: вызывается из тика и после действий; по одной задаче за вызов
  // (одна сеть за раз — никаких штормов на биржу), счётчик попыток даёт честные ретраи.
  async drainRealQueue() {
    const a = this.a;
    if (!this.okxOn() || !Array.isArray(a.realQueue) || !a.realQueue.length) return 0;
    if (!this.hooks || !this.hooks.okx) return 0; // без биндингов (тесты) очередь ждёт
    const job = a.realQueue[0];
    const okx = this.hooks.okx;
    const instId = job.instId || job.sym;
    try {
      if (job.kind === "buy") {
        if (!(job.usdt >= 5)) throw new Error("сумма меньше минимума OKX ($5)");
        const fill = await okx.marketBuyWithFill(this.okxCfg, instId, job.usdt);
        if (!fill.ok || !(fill.avgPx > 0)) throw new Error(fill.state ? "ордер ещё не исполнен (" + fill.state + ")" : "исполнение не подтверждено");
        a.realQueue = a.realQueue.filter((j) => j.id !== job.id);
        this.recordRealBuy(job, fill);
      } else {
        const sellQty = job.qty > 0 ? job.qty : 0;
        if (!(sellQty > 0)) { // нечего продавать (покупка не дошла) — снимаем задачу
          a.realQueue = a.realQueue.filter((j) => j.id !== job.id);
          return 1;
        }
        const fill = await okx.marketSellWithFill(this.okxCfg, instId, sellQty);
        if (!fill.ok || !(fill.avgPx > 0)) throw new Error(fill.state ? "ордер ещё не исполнен (" + fill.state + ")" : "исполнение не подтверждено");
        a.realQueue = a.realQueue.filter((j) => j.id !== job.id);
        this.recordRealSell(job, fill);
      }
      a.okx = normalizeOkx({ ...(a.okx || {}), lastErr: "" });
    } catch (e) {
      job.attempts = (job.attempts || 0) + 1;
      job.lastErr = String((e && e.message) || e).slice(0, 160);
      const cap = job.kind === "sell" ? 8 : 3;
      if (job.attempts >= cap) {
        a.realQueue = a.realQueue.filter((j) => j.id !== job.id);
        const pos = (a.userPositions || []).find((p) => p.id === job.posId);
        if (pos && pos.realPending) delete pos.realPending;
        this.pushEvent({
          tone: "bear", sym: job.sym,
          title: job.kind === "sell"
            ? `OKX: НЕ УДАЛОСЬ продать ${job.sym} — токен остался на бирже`
            : `OKX: покупка ${job.sym} отменена после ${job.attempts} попыток`,
          detail: (job.kind === "sell"
            ? `продайте вручную на бирже (примерно ${Fmt.fmtNum(Math.round((job.qty || 0) * 1e6) / 1e6)} ${job.sym}) или проверьте ключи и повторите · `
            : "") + "последняя ошибка: " + job.lastErr,
          notify: { kind: "okx_fail" },
        });
      } else if (job.attempts === 1) {
        this.tickLog.push("okx " + job.kind + " " + job.sym + ": " + job.lastErr);
      }
    }
    return 1;
  }

  // синхронизация реального баланса (троттл 5 мин; вне live — только по явному запросу)
  async okxBalanceSync(force) {
    if (!this.okxOn()) return false;
    const now = Date.now();
    if (!force && this._okxSyncAt && now - this._okxSyncAt < 5 * 60000) return false;
    this._okxSyncAt = now;
    if (!this.hooks || !this.hooks.okx) return false;
    try {
      const bal = await this.hooks.okx.fetchUsdtBalance(this.okxCfg);
      this.a.okx = normalizeOkx({
        ...(this.a.okx || {}), on: true,
        balanceUSDT: bal.usdt, balanceEq: bal.total, lastSync: Date.now(), lastErr: "",
      });
      return true;
    } catch (e) {
      this.a.okx = normalizeOkx({ ...(this.a.okx || {}), on: true, lastErr: String((e && e.message) || e).slice(0, 160) });
      return false;
    }
  }

  // ---------- сделки ----------
  placeDemo(p) {
    const p0 = this.prices[p.sym];
    if (!p0 || !p0.price) return { ok: false, error: "Цена ещё не загружена" };
    if (!p0.ts || Date.now() - p0.ts > 120000) return { ok: false, error: "Цена по этой монете не обновляется" };
    const price = p0.price;
    const margin = Math.round(Number(p.size) || 0);
    if (!(margin > 0)) return { ok: false, error: "Некорректный размер сделки" };
    // ============ R52: РЕАЛЬНЫЙ РЫНОК — ТОЛЬКО РЕАЛЬНЫЕ СДЕЛКИ В USDT ============
    // 1) всё в USDT (ХРЮ на реальном рынке не участвуют); 2) шортов нет вовсе —
    // спот OKX умеет только «купить токен за USDT» и «продать токен обратно»;
    // 3) исполнение только через серверную синхронизацию OKX.
    if (this.isLive()) return this.placeLive(p, price, margin);
    // ============ R53: ШОРТОВ НЕТ НИГДЕ — ДЕМО ПОВТОРЯЕТ РЕАЛЬНЫЙ РЫНОК 1:1 ============
    // Спот OKX умеет только «купить токен → продать обратно», поэтому и демо-торговля
    // теперь лонг-only: ИИ обучается исключительно на кейсах, которые осуществимы на
    // реальном рынке, и весь этот опыт переносится на реальные USDT без потерь.
    // Старые открытые шорты (до R53) не трогаем — движок обслужит их до закрытия.
    if (p.side !== "лонг") {
      return { ok: false, error: "Шортов больше нет — демо-торговля повторяет реальный рынок 1:1: спот OKX умеет только купить токен за USDT и продать его обратно. Дождитесь лонг-сигнала." };
    }
    if (margin > this.aiDealCap()) return { ok: false, error: `Лимит одной сделки — ${Fmt.fmtNum(this.aiDealCap())} ХРЮ` };
    if (this.openPositionsSum() + margin > this.aiTotalCap()) return { ok: false, error: `Суммарный лимит сделок — ${Fmt.fmtNum(this.aiTotalCap())} ХРЮ: в рынке уже ${Fmt.fmtNum(Math.round(this.openPositionsSum()))} ХРЮ` };
    if (margin > this.a.balance) return { ok: false, error: `Недостаточно хрювен: свободно ${Fmt.fmtNum(this.a.balance)} ХРЮ` };
    const risk = price * 0.02;
    const pos = {
      // R44: id устойчив к коллизиям — два входа в одну миллисекунду (кнопка + автопилот,
      // быстрый тап по двум идеям) не должны получать один id: дубль id при закрытии
      // списывает маржу одной записью за обе позиции и ломает сходство баланса
      id: p.id || `u${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      owner: "user", strategy: p.strategy || "manual", sym: p.sym, side: "лонг",
      size: margin, lev: 1, entry: price,
      stop: p.stop || (price - risk),
      target: p.target || (price + risk * 2),
      r0: Math.abs(price - (p.stop || (price - risk))),
      openedAt: Date.now(),
      ai: p.ai || null,
    };
    this.a.balance -= margin;
    this.a.userPositions = [pos, ...this.a.userPositions];
    this.pushEvent({
      tone: "bull",
      title: p.strategy === "ai" ? `ИИ-сделка открыта: ${p.sym} лонг ×${pos.lev}` : `Демо-сделка открыта: ${p.sym} лонг ×${pos.lev}`,
      detail: `${Fmt.fmtNum(margin)} ХРЮ (≈ ${Fmt.fmtUsd(margin)}) по реальной цене ${price.toPrecision(6)}${p.ai ? ` · уверенность ИИ ${p.ai.confidence}%` : ""}`,
      sym: p.sym,
      notify: (p.strategy === "ai" && p.ai && p.ai.auto) ? null : { kind: p.strategy === "ai" ? "ai_open" : "user_open" },
    });
    return { ok: true, pos };
  }

  // ================= R52: ОТКРЫТИЕ НА РЕАЛЬНОМ РЫНКЕ (USDT · только лонги) =================
  // Валюта — реальные USDT с OKX: размер проверяется против свободного баланса биржи,
  // ХРЮ-баланс не трогается вовсе; шорт не пропускается никогда (спот не умеет);
  // исполнение — только через серверную полную синхронизацию OKX.
  placeLive(p, price, margin) {
    if (p.side !== "лонг") {
      return { ok: false, error: "На реальном рынке шортов нет: спот OKX умеет только купить токен за USDT и продать его обратно. Открывайте лонг — либо подождите, пока ИИ даст лонг-сигнал." };
    }
    if (!this.okxSyncActive()) {
      return { ok: false, error: "Реальные сделки исполняются только при подключённом OKX и включённых авто-ордерах: подключите ключи в модалке реального рынка (полная синхронизация)." };
    }
    if (margin > this.aiDealCap()) return { ok: false, error: `Лимит одной сделки — ${Fmt.fmtNum(this.aiDealCap())} USDT` };
    if (margin < 5) return { ok: false, error: "Минимум сделки на реальном рынке — 5 USDT (минимум ордера OKX)" };
    if (this.openPositionsSum() + margin > this.aiTotalCap()) return { ok: false, error: `Суммарный лимит сделок — ${Fmt.fmtNum(this.aiTotalCap())} USDT: в рынке уже ${Fmt.fmtNum(Math.round(this.openPositionsSum()))} USDT` };
    const avail = this.liveAvailableUsdt();
    if (avail == null) return { ok: false, error: "Баланс OKX ещё не синхронизирован — подождите минуту или нажмите «Обновить баланс»" };
    if (margin > avail) return { ok: false, error: `Недостаточно свободных USDT на бирже: доступно ${Fmt.fmtNum(avail, 2)} USDT` };
    const risk = price * 0.02;
    const pos = {
      id: p.id || `u${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      owner: "user", strategy: p.strategy || "manual", sym: p.sym, side: "лонг",
      size: margin, lev: 1, entry: price,
      stop: p.stop || (price - risk),
      target: p.target || (price + risk * 2),
      r0: Math.abs(price - (p.stop || (price - risk))),
      openedAt: Date.now(),
      ai: p.ai || null,
      usdt: true, // R52: позиция реального рынка — деньги в USDT, не в ХРЮ
    };
    // ВАЖНО: баланс ХРЮ НЕ списываем — на реальном рынке он не участвует;
    // реальные USDT уходят с биржи в момент исполнения покупки (hookRealOpen ниже)
    this.a.userPositions = [pos, ...this.a.userPositions];
    this.pushEvent({
      tone: "bull",
      title: p.strategy === "ai" ? `ИИ открыл реальную сделку: ${p.sym} лонг${p.ai ? ` · уверенность ${p.ai.confidence}%` : ""}` : `Реальная сделка открыта: ${p.sym} лонг`,
      detail: `${Fmt.fmtNum(margin)} USDT · покупка ${p.sym} на OKX-споте идёт автоматически · цена ≈ ${price.toPrecision(6)} · спот, без плеча`,
      sym: p.sym,
      notify: (p.strategy === "ai" && p.ai && p.ai.auto) ? null : { kind: p.strategy === "ai" ? "ai_open" : "user_open" },
    });
    this.hookRealOpen(pos); // реальная покупка USDT → токен
    return { ok: true, pos };
  }
  closeDemo(id) {
    const pos = this.a.userPositions.find((p) => p.id === id);
    if (!pos) return { ok: false, error: "Позиция не найдена" };
    const price = this.price(pos.sym) || pos.entry;
    const closed = Engine.closeTrade(pos, price, "Вручную");
    this.a.userPositions = this.a.userPositions.filter((p) => p.id !== id);
    this.a.userClosed = [closed, ...this.a.userClosed].slice(0, 300);
    if (!this.isLive()) this.a.balance += pos.size + closed.pnl; // R52: live — ХРЮ не трогаем, USDT вернутся с биржи
    this.learnFromClosed(closed);
    this.hookRealClose(pos, closed); // R51: реальная нога продается на OKX
    this.pushEvent({
      tone: closed.pnl >= 0 ? "bull" : "bear",
      title: this.isLive()
        ? `Сделка закрыта: ${pos.sym} ${closed.pnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(closed.pnl)))} USDT`
        : `Демо-сделка закрыта: ${pos.sym} ${closed.pnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(closed.pnl)))} ХРЮ`,
      detail: this.isLive()
        ? `${closed.exitReason} · токен продаётся на OKX, USDT вернутся на баланс биржи`
        : closed.exitReason,
      sym: pos.sym,
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
    if (!this.isLive()) this.a.balance += closed.size + closed.pnl; // R52: live — без ХРЮ
    this.learnFromClosed(closed);
    this.hookRealClose(pos, closed); // R51: реальная нога продается на OKX
    if (closed.strategy === "ai" && (reason === "Стоп" || reason === "Провал")) this.noteAiStopBan(pos.sym);
    this.pushEvent({
      id: "x" + pidOfClosed(closed),
      tone: closed.pnl >= 0 ? "bull" : "bear",
      title: this.isLive()
        ? `Реальный рынок: ${pos.sym} закрыта ${closed.exitReason.toLowerCase()} · ${closed.pnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(closed.pnl)))} USDT`
        : `Демо: ${pos.sym} закрыта ${closed.exitReason.toLowerCase()} · ${closed.pnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(closed.pnl)))} ХРЮ`,
      detail: this.isLive()
        ? `исполнено сервером XenoAI · правило выхода: ${closed.exitReason} · токен продаётся на OKX, USDT вернутся на биржу`
        : `исполнено сервером XenoAI · правило выхода: ${closed.exitReason}`,
      sym: pos.sym,
      notify: { kind: pos.strategy === "ai" ? "ai_close" : "user_close", data: { pnl: closed.pnl } },
    });
    return closed;
  }

  updateIdeas(sym, res, guard) {
    // R45: монета «в тени» (отказы стабильно верны) — идею снимаем и не добавляем
    // R53: шорт-идей не существует ни в одном режиме (спот OKX не умеет, демо = реальный
    // рынок 1:1) — в «Сигналы» попадают только лонги
    let rest = this.a.aiIdeas.filter((i) => i.sym !== sym);
    const showIdea = !this.shadowSkipActive(sym) && res.verdict !== "wait" && res.verdict !== "шорт";
    if (showIdea) rest.push({ sym, res, guard, ts: Date.now() });
    // R45: ранжирование с тенью — доверие по монете (из исходов прошлых отказов)
    // и симбиас реальных сделок двигают монету в «лучших идеях», мусор тонет
    // R49: + калибровка уверенности (та же поправка, что и при входе)
    // R52: ранжируем по опыту НАПРАВЛЕНИЯ идеи (лонг-опыт для лонгов)
    const calibOff = (this.brain.calib && Number.isFinite(this.brain.calib.offset)) ? this.brain.calib.offset : 0;
    const rank = (i) => i.res.confidence + this.shadowTrustAdj(i.sym) + (this.symBias(i.sym, i.res.verdict) || 0) + calibOff;
    rest.sort((x, y) => rank(y) - rank(x));
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
        detail: this.isLive()
          ? `${Fmt.fmtNum(size)} USDT · покупка на OKX-споте идёт автоматически · защита: ${guardWhy} · стоп/цель по ATR · сделку открыл СЕРВЕР (автономно)`
          : `${Fmt.fmtNum(size)} ХРЮ · спот · защита: ${guardWhy} · стоп/цель по ATR · сделку открыл СЕРВЕР (автономно)`,
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

    // R49: все 13 факторов на сервере живые — китовая лента качается whaleScan-ом,
    // GLM-аналитик опрашивается glmAsk-ом (конфиг — действие glmCfg из модалки)
    const extra = { whale: this.aiWhaleBias(sym), onchain: null, glm: this.glmFactor() };
    const res = Engine.aiAnalyze(sym, bars, this.brain, this.news.items, extra);
    if (!res) return;

    // ============ R53: ШОРТ-ВЕРДИКТ — ВО ВСЕХ РЕЖИМАХ (ДЕМО = РЕАЛЬНЫЙ РЫНОК 1:1) ============
    // Спот OKX шортов не умеет, и с R53 демо-торговля повторяет реальный рынок один-в-один,
    // поэтому шорт-вердикт ИИ везде означает одно и то же:
    //  1) не попадает в идеи и в тень (это не рыночный отказ, а отсутствие возможности);
    //  2) открытый лонг по той же монете ЗАКРЫВАЕТСЯ по гейтам флипа (разворот факторов
    //     вниз = повод выйти в кэш; на реальном рынке токен при этом продаётся на OKX),
    //     а шорт взамен не открывается.
    // Вся уверенность/экспертиза ИИ считается по ЛОНГ-опыту (symBias(sym,"лонг"),
    // келли от longTrades/longWins) — пользователь: «ИИ обучается только на кейсах,
    // которые осуществимы на реальном рынке».
    if (res.verdict === "шорт") {
      const aiPosL = this.a.userPositions.find((p) => p.sym === sym && p.strategy === "ai");
      if (aiPosL && aiPosL.side === "лонг") {
        const thrL = this.brain.confThreshold || 74;
        const effConfL = res.confidence + this.symBias(sym, "лонг") + this.shadowTrustAdj(sym)
          + ((this.brain.calib && Number.isFinite(this.brain.calib.offset)) ? this.brain.calib.offset : 0);
        const fg = this.flipAllowed(aiPosL, res, effConfL, thrL, sym);
        if (fg.ok) {
          const price0 = this.price(sym) || aiPosL.entry;
          const closed = Engine.closeTrade(aiPosL, price0, "ИИ-выход (разворот вниз)");
          this.a.userPositions = this.a.userPositions.filter((p) => p.id !== aiPosL.id);
          this.a.userClosed = [closed, ...this.a.userClosed].slice(0, 300);
          this.learnFromClosed(closed);
          this.hookRealClose(aiPosL, closed); // реальный токен продаётся на OKX
          this._flipAt = { ...this._flipAt, [sym]: Date.now() };
          this.pushEvent({
            tone: "bear",
            title: `ИИ вышел из лонга ${sym}: факторы развернулись вниз`,
            detail: this.isLive()
              ? `закрыто по ${closed.pnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(closed.pnl)))} USDT · ${closed.pnl >= 0 ? "+" : "−"}${Math.abs(Engine.positionPnl(aiPosL, closed.exit).pct).toFixed(2)}% · шорт на споте невозможен — выходим в кэш, токен продаётся на OKX`
              : `закрыто по ${closed.pnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(closed.pnl)))} ${this.cur()} · ${closed.pnl >= 0 ? "+" : "−"}${Math.abs(Engine.positionPnl(aiPosL, closed.exit).pct).toFixed(2)}% · шортов больше нигде нет — выходим в кэш`,
            sym,
            notify: { kind: "ai_flip", data: { pnl: closed.pnl } },
          });
        }
      }
      return; // шорт-вход не открываем никогда
    }

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
    // R45: доверие по тени — третий компонент эффективной уверенности (рядом с симбиасом)
    // R49: + калибровка уверенности (offset по фактическому винрейту бакетов)
    // R53: опыт по ЛОНГАМ во всех режимах — шорт-вердикты сюда не доходят (ранний выход),
    // а лонг-опыт един для демо и реального рынка (обучение только на осуществимых кейсах)
    const trustAdj = this.shadowTrustAdj(sym);
    const calibOff = (this.brain.calib && Number.isFinite(this.brain.calib.offset)) ? this.brain.calib.offset : 0;
    const effConf = res.confidence + this.symBias(sym, res.verdict) + trustAdj + calibOff;

    if (aiPos && res.verdict !== "wait" && res.verdict !== aiPos.side) {
      const fg = this.flipAllowed(aiPos, res, effConf, thr, sym);
      if (fg.ok) {
        const price0 = this.price(sym) || aiPos.entry;
        const closed = Engine.closeTrade(aiPos, price0, "ИИ-флип");
        this.a.userPositions = this.a.userPositions.filter((p) => p.id !== aiPos.id);
        this.a.userClosed = [closed, ...this.a.userClosed].slice(0, 300);
        if (!this.isLive()) this.a.balance += closed.size + closed.pnl; // R52: live — без ХРЮ
        this.learnFromClosed(closed);
        this.hookRealClose(aiPos, closed); // R51: реальная нога продается на OKX
        this._flipAt = { ...this._flipAt, [sym]: Date.now() };
        this.pushEvent({
          tone: res.verdict === "лонг" ? "bull" : "bear",
          title: `ИИ флипнул ${sym}: ${aiPos.side} → ${res.verdict}`,
          detail: this.isLive()
            ? `закрыто по ${closed.pnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(closed.pnl)))} USDT · разворот факторов (уверенность ${res.confidence}%)`
            : `закрыто по ${closed.pnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(closed.pnl)))} ХРЮ · разворот факторов (уверенность ${res.confidence}%)`,
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
      // R45: монета «в тени» — осознанный пропуск, а не отказ фильтра: в журнал
      // отказов НЕ пишем (не засоряем статистику), идей и входов не даём
      if (this.shadowSkipActive(sym)) return;
      const maxPos = this.effMaxPos();
      const hg = this.heatGuard();
      const sc = this.aiSizeCalc();
      let refuse = "";
      if (effConf < thrEntry) refuse = `порог: уверенность ${effConf}% < ${thrEntry}%${bump ? " · медвежий режим +6" : ""}${trustAdj ? ` · тень ${trustAdj > 0 ? "+" : ""}${trustAdj}` : ""}`;
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
        this.pushEvent({ tone: "neutral", title: "ИИ-автопилот ВКЛЮЧЁН в реальном режиме (вы явно разрешили)", detail: `полная синхронизация: каждый вход ИИ = покупка токена на OKX реальными USDT, каждое закрытие = продажа обратно · только лонги (спот) · авто-стоп ±${this.aiLimitPct()}% · торгует сервер`, notify: { kind: "autopilot", data: { on: true } } });
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
      const snap = Engine.aiFactorSnapshot(sym, bars, this.brain, this.news.items, { whale: this.aiWhaleBias(sym), glm: this.glmFactor() });
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
      if (!this.isLive()) this.a.balance += userClosedAdd.reduce((sum, c) => sum + c.size + c.pnl, 0); // R52: live — без ХРЮ
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
        const liveUsdt = e.pos.owner === "user" && this.isLive(); // R52: реальные позиции — в USDT
        this.pushEvent({
          id: "x" + pidOfClosed(e.closed),
          tone: e.closed.pnl >= 0 ? "bull" : "bear",
          title: liveUsdt
            ? `Реальный рынок: ${e.pos.sym} закрыта ${e.closed.exitReason.toLowerCase()} · ${e.closed.pnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(e.closed.pnl)))} USDT`
            : `${e.pos.owner === "lab" ? "Лаборатория" : "Демо"}: ${e.pos.sym} закрыта ${e.closed.exitReason.toLowerCase()} · ${e.closed.pnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(e.closed.pnl)))} ХРЮ`,
          detail: liveUsdt
            ? `исполнено СЕРВЕРОМ XenoAI · правило выхода: ${e.closed.exitReason} · токен продаётся на OKX, USDT вернутся на биржу`
            : `исполнено СЕРВЕРОМ XenoAI · ${(Engine.STRATEGIES.find((x) => x.id === e.pos.strategy) || { name: "вручную" }).name}`,
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

    // R49: китовая лента (фактор 12) + GLM-аналитик (фактор 13) — оба 24/7 на сервере.
    // Качаем ДО торговых шагов: анализ этого же тика видит свежий китовый перевес
    try { await this.whaleScan(o.scanSyms || []); } catch (e) { this.tickLog.push("whaleScan: " + (e && e.message)); }
    try { await this.glmAsk(false); } catch (e) { /* вердикт не критичен */ }

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
          if (!Number.isFinite(n) || n < 5 || n > 100000) return { ok: false, error: `Максимум одной сделки — от 5 до 100 000 ${this.cur()}` };
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
        // R51: live доступен и через серверное подключение OKX (полная синхронизация)
        const serverOkx = Boolean(a.okx && a.okx.on);
        if (p.mode === "live" && !p.liveConnected && !serverOkx) return { ok: false, error: "Сначала подключите кошелёк/ключи биржи или подключите OKX на сервере (полная синхронизация)" };
        if (p.mode === "demo" || p.mode === "live") a.mode = p.mode;
        return { ok: true };
      }
      case "okxAuto": {
        // R51: аварийный выключатель авто-ордеров OKX (баланс продолжает синхронизироваться)
        if (!a.okx || !a.okx.on) return { ok: false, error: "OKX не подключён на сервере" };
        const on = p.on !== false;
        a.okx = normalizeOkx({ ...a.okx, auto: on });
        this.pushEvent({
          tone: "neutral",
          title: on ? "Полная синхронизация OKX ВКЛЮЧЕНА" : "Авто-ордера OKX приостановлены",
          detail: on
            ? "входы (сигналы, автопилот, вручную) покупают токен на OKX-споте реальными USDT, закрытия продают его обратно — всё автоматически"
            : "баланс биржи по-прежнему виден здесь, но новые реальные ордера не открываются; уже открытые ноги продаются при закрытии сделок",
          notify: { kind: "autopilot", data: { on } },
        });
        return { ok: true, okx: a.okx };
      }
      case "okxSync": {
        // R51: принудительное обновление баланса OKX (кнопка «Обновить баланс»);
        // реальный запрос делает room после действия (okxBalanceSync(force))
        if (!a.okx || !a.okx.on) return { ok: false, error: "OKX не подключён на сервере" };
        return { ok: true };
      }
      case "setBalance": {
        // R52: баланс реального рынка приходит с биржи OKX — руками его не задать
        if (this.isLive()) return { ok: false, error: "Баланс реального рынка — реальные USDT с биржи OKX: он синхронизируется автоматически и вручную не меняется" };
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
        // R47: origin домена, создавшего подписку. КРИТИЧНО после переезда
        // xenoai-chi.vercel.app → xenotrade.vercel.app: PushSubscription, localStorage
        // и разрешение привязаны к origin — подписка старого домена мертва для нового.
        let origin = "";
        try { origin = new URL(String(sub.origin || "")).origin; } catch (e) { origin = ""; }
        const rest = (a.pushSubs || []).filter((s) => s.endpoint !== sub.endpoint);
        rest.unshift({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, ts: Date.now(), ua: String(p.ua || "").slice(0, 140), origin });
        a.pushSubs = rest.slice(0, 8);
        return { ok: true };
      }
      case "pushUnsub": {
        a.pushSubs = (a.pushSubs || []).filter((s) => s.endpoint !== p.endpoint);
        return { ok: true };
      }
      case "pushDrop": {
        // R47: удалить подписки по хвосту endpoint (кнопка «убрать старый домен» в модалке)
        const tail = String(p.tail || "");
        if (tail.length < 6) return { ok: false, error: "короткий хвост" };
        const before = (a.pushSubs || []).length;
        a.pushSubs = (a.pushSubs || []).filter((s) => String(s.endpoint || "").slice(-tail.length) !== tail);
        return { ok: true, removed: before - (a.pushSubs || []).length };
      }
      case "ntfySet": {
        // R50: включение/выключение резервного канала ntfy. Тема — случайный
        // несгадываемый идентификатор (единственная «авторизация» в ntfy.sh).
        const topic = String(p.topic || "").trim();
        if (!NTFY_TOPIC_RE.test(topic)) return { ok: false, error: "Тема ntfy: 6–64 символа, латиница/цифры/дефис/подчёркивание" };
        const on = p.on !== false;
        a.ntfy = normalizeNtfy({ on, topic, last: (a.ntfy && a.ntfy.last) || null });
        return { ok: true, ntfy: a.ntfy };
      }
      case "liveOrder": {
        // R47 (аудит реального режима): реальный ордер с устройства записывается
        // в аккаунт на сервере — история живёт на всех устройствах, событие live_order
        // (с пушем «Реальные ордера») генерирует СЕРВЕР, а не только браузер вкладки.
        // R49: ОБУЧЕНИЕ НА РЕАЛЬНЫХ СДЕЛКАХ. Покупка («лонг») открывает FIFO-запись
        // liveOpen по цене биржи на момент исполнения; продажа («шорт») закрывает
        // старейшие покупки той же монеты: считается PnL и опыт льётся в общий мозг
        // (symStats → symBias на будущих входах ИИ, уроки, статистика liveStats).
        const o = p.order;
        if (!o || typeof o.sym !== "string" || (o.side !== "лонг" && o.side !== "шорт")) return { ok: false, error: "ордер неполный" };
        const amt = Number(o.amountUSDT);
        if (!Number.isFinite(amt) || amt <= 0 || amt > 1e9) return { ok: false, error: "некорректная сумма ордера" };
        // устройство шлёт пару («BTCUSDT») — ИИ живёт в символах («BTC»): нормализуем,
        // иначе опыт реальных сделок копился бы под чужим ключом и не влиял на решения
        const sym = PAIR_TO_SYM[o.sym] || String(o.sym).replace(/USDT$/, "").slice(0, 16);
        const fill = Number(o.price) > 0 ? Number(o.price) : this.price(sym); // цена биржи, резерв — кэш сервера
        if (!a.liveOrders) a.liveOrders = [];
        if (!a.liveOpen) a.liveOpen = [];
        if (!a.liveStats) a.liveStats = { n: 0, wins: 0, losses: 0, pnlUsdt: 0, since: 0 };
        a.liveOrders = [{ sym, side: o.side, amountUSDT: amt, exchange: String(o.exchange || "?").slice(0, 24), note: String(p.note || "").slice(0, 80), price: fill > 0 ? fill : null, ts: Date.now() }, ...a.liveOrders].slice(0, 50);

        let learned = null;
        if (o.side === "лонг") {
          // реальная покупка: фиксируем FIFO-запись (цена нужна для будущего PnL)
          if (fill > 0) {
            a.liveOpen.push({ id: "lo" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), sym, amount: amt, price: fill, ts: Date.now() });
            a.liveOpen = a.liveOpen.slice(-20);
          }
        } else if (fill > 0) {
          // реальная продажа: закрываем старейшие покупки той же монеты (FIFO)
          let remain = amt, costSum = 0, matchedSum = 0;
          const keep = [];
          for (const lo of a.liveOpen) {
            if (lo.sym !== sym || remain <= 0) { keep.push(lo); continue; }
            const take = Math.min(lo.amount, remain);
            costSum += take * lo.price;
            matchedSum += take;
            remain -= take;
            if (take < lo.amount) keep.push({ ...lo, amount: Math.round((lo.amount - take) * 1e6) / 1e6 });
          }
          a.liveOpen = keep;
          if (matchedSum > 0) {
            const avgEntry = costSum / matchedSum;
            const pnlPct = (fill / avgEntry - 1) * 100;
            const pnlUsdt = matchedSum * (pnlPct / 100);
            // обучение: опыт реального рынка льётся в ОБЩИЙ мозг (symStats → symBias,
            // статистика и уроки едут в хаб всем аккаунтам и всем режимам)
            const st = this.learnSymStats(sym, pnlPct >= 0, pnlPct, "лонг"); // продажа вручную = выход из лонга (R52)
            const ls = a.liveStats;
            ls.n++; if (pnlPct >= 0) ls.wins++; else ls.losses++;
            ls.pnlUsdt = Math.round((ls.pnlUsdt + pnlUsdt) * 100) / 100;
            if (!ls.since) ls.since = Date.now();
            if (Math.abs(pnlPct) >= 1) {
              this.pushLesson(`реальный рынок: ${sym} ${pnlPct >= 0 ? "+" : "−"}${Math.abs(pnlPct).toFixed(1)}% (${matchedSum.toFixed(0)} USDT) — опыт по монете учтён (${st.n} сделок, стрик ${st.streak})`);
            }
            learned = { sym, pnlPct: Math.round(pnlPct * 100) / 100, pnlUsdt: Math.round(pnlUsdt * 100) / 100, matched: Math.round(matchedSum * 100) / 100, avgEntry };
            this.pushEvent({
              tone: pnlPct >= 0 ? "bull" : "bear",
              title: `Реальная сделка закрыта: ${sym} ${pnlPct >= 0 ? "+" : "−"}${Math.abs(pnlPct).toFixed(1)}%`,
              detail: `продажа ${Fmt.fmtNum(Math.round(amt))} USDT по ${fill.toPrecision(6)} · вход ≈ ${avgEntry.toPrecision(6)} · итог ${pnlUsdt >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(pnlUsdt)))} USDT · ИИ учёл опыт по ${sym}`,
              sym,
              notify: { kind: "live_close", data: { pnl: pnlUsdt } },
            });
          }
        }
        this.pushEvent({
          tone: o.side === "лонг" ? "bull" : "bear",
          title: `Реальный ордер: ${sym} ${o.side === "лонг" ? "BUY" : "SELL"}`,
          detail: `${Fmt.fmtNum(Math.round(amt))} USDT · ${String(o.exchange || "?").slice(0, 24)} · исполнен на бирже с устройства${fill > 0 ? ` · цена ${fill.toPrecision(6)}` : ""}`,
          notify: { kind: "live_order" },
        });
        return { ok: true, learned };
      }
      default: return { ok: false, error: "неизвестное действие: " + type };
    }
  }
}
