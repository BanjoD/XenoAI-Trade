#!/usr/bin/env node
// XenoAI Trade — тесты R29 + R30.
// R29: политика «очевидно провальных сделок» (тело + N%), порог входа 74, догон Стража.
// R30: каскад источников цен, персист последних цен, запрет торговли на синтетике,
//      слияние синка по позициям (union + могилы закрытий + пересчёт баланса),
//      нативный Web Push (RFC 8291/8292 roundtrip) и чистка ntfy.
// Запуск: node scripts/test-xenoai.js   (без сети: движок грузится в VM со стабами браузера)
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const REPO = path.join(__dirname, ".."); // тест лежит внутри репозитория

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}
function section(t) { console.log(`\n== ${t} ==`); }

// ---------- VM-контекст как у Стража: стабы браузера + настоящие Date/Math/JSON ----------
function boot(seedBrain) {
  const mem2 = {};
  const ctx2 = {
    console, Date, Math, JSON, Promise, URL, AbortController,
    setTimeout: () => 0, clearTimeout: () => {},   // таймеры не нужны: hydrate синхронен
    setInterval: () => 0, clearInterval: () => {}, navigator: {},
    fetch: () => Promise.reject(new Error("offline")), // вся сеть офлайн — код деградирует штатно
  };
  ctx2.window = ctx2; ctx2.globalThis = ctx2;
  ctx2.localStorage = {
    getItem: (k) => (k in mem2 ? mem2[k] : null),
    setItem: (k, v) => { mem2[String(k)] = String(v); },
    removeItem: (k) => { delete mem2[String(k)]; },
    get length() { return Object.keys(mem2).length; },
    key: (i) => Object.keys(mem2)[i] || null,
  };
  ctx2.document = { addEventListener: () => {}, hidden: true };
  ctx2.addEventListener = () => {}; ctx2.removeEventListener = () => {};
  ctx2.confirm = () => false;
  ctx2.Auth = { sessionLogin: () => "david", readSession: () => ({ login: "david", role: "admin", at: Date.now() }), syncCodeFor: () => "TESTCODE01" };
  if (seedBrain) mem2["xenoai_global_brain_v1"] = JSON.stringify(seedBrain);
  vm.createContext(ctx2);
  for (const f of ["format.js", "data.js", "indicators.js", "candles.js", "binance.js", "engine.js", "store.js"]) {
    vm.runInContext(fs.readFileSync(path.join(REPO, "js", f), "utf8"), ctx2, { filename: f });
  }
  return { ctx: ctx2, Store: ctx2.window.Store, E: ctx2.window.Engine };
}

const { ctx, Store, E } = boot({ v: 1, confThreshold: 84, trades: 10, wins: 2, losses: 8 });

// ---------- помощники ----------
function mkBars(closes, step) {
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1];
    return { o, c, h: Math.max(o, c) + (step || 0.01), l: Math.min(o, c) - (step || 0.01), v: 1000, t: i };
  });
}
function pos(over) {
  return Object.assign({
    id: "t1", owner: "user", strategy: "ai", sym: "BTC", side: "лонг",
    size: 500, lev: 1, entry: 100, stop: 98, target: 106, r0: 2, openedAt: Date.now(),
  }, over || {});
}

// ================= 1. ПРОВАЛЬНАЯ ЛИНИЯ: тело + N% (R29) =================
section("Политика провала: evalExit (лонг, тело 2, failPct 50 → провал на 97)");
{
  const p = pos(); // entry 100, stop 98 (тело 2), target 106
  ok(E.failLineOf(p, 50) === 97, "failLineOf: 100 − 2×1.5 = 97", String(E.failLineOf(p, 50)));
  ok(E.evalExit(p, null, 97.5, 50) === null, "цена 97.5 (за стопом, выше провала) — ДЕРЖИМ, null");
  ok(E.evalExit(p, null, 98.05, 50) === null, "цена 98.05 — за стоп-линией ещё нет, null");
  const f1 = E.evalExit(p, null, 96.9, 50);
  ok(f1 && f1.reason === "Провал" && Math.abs(f1.price - 97) < 1e-9, "цена 96.9 (ниже 97−0.06 гистерезиса) → Провал по 97", JSON.stringify(f1));
  ok(E.evalExit(p, null, 96.95, 50) === null, "фитиль ровно на 96.95 (+0.05 от линии) — гистерезис держит");
  const t1 = E.evalExit(p, null, 106.2, 50);
  ok(t1 && t1.reason === "Цель" && t1.price === 106, "цель 2R приоритетнее провала → Цель по 106");
}

section("Провал: failPct крайние случаи, шорт, тело без r0");
{
  const p = pos();
  const f0 = E.evalExit(p, null, 97.9, 0);
  ok(f0 && f0.reason === "Провал" && Math.abs(f0.price - 98) < 1e-9, "failPct=0 → классический стоп: 97.9 → Провал по 98", JSON.stringify(f0));
  ok(E.evalExit(p, null, 97.99, 0) === null, "failPct=0: фитиль 97.99 (выше 98−0.06) — держит");
  ok(E.failLineOf(p, undefined) === 97, "failPct не задан → дефолт 50 (97)");
  ok(E.failLineOf(p, 500) === 94, "failPct 500 зажимается в 200 → 100 − 2×3 = 94", String(E.failLineOf(p, 500)));
  ok(E.failLineOf(p, -7) === 98, "failPct −7 зажимается в 0 → 98");
  const pl = pos({ r0: undefined }); // лаборатория/ручная без r0: тело из |entry−stop|
  ok(E.failLineOf(pl, 50) === 97, "тело восстанавливается из стопа (нет r0) → 97");
  const sh = pos({ side: "шорт", stop: 102, target: 94 });
  ok(E.failLineOf(sh, 50) === 103, "шорт зеркально: 100 + 2×1.5 = 103");
  ok(E.evalExit(sh, null, 102.5, 50) === null, "шорт: 102.5 (за стопом, ниже провала) — ДЕРЖИМ");
  ok(E.evalExit(sh, null, 103.2, 50) !== null && E.evalExit(sh, null, 103.2, 50).reason === "Провал", "шорт: 103.2 → Провал");
}

section("Провал: трейлинг и тренд-выход не сломаны");
{
  // стоп, подтянутый трейлингом в плюс: пересечение = выход В ПЛЮСЕ (не Провал)
  const be = pos({ stop: 100.5 }); // безубыток с запасом
  const r1 = E.evalExit(be, null, 100.4, 50);
  ok(r1 && r1.reason === "Стоп" && Math.abs(r1.price - 100.5) < 1e-9, "стоп в плюсе (100.5), цена 100.4 → Стоп (заработанное защищено)", JSON.stringify(r1));
  ok(E.failLineOf(be, 50) === 97, "провальная линия у трейлинговой позиции всё ещё по ИСХОДНОМУ телу (r0=2) → 97", String(E.failLineOf(be, 50)));
  // тренд-выход в минусе запрещён
  const closes = [];
  for (let i = 0; i < 30; i++) closes.push(100 + i * 0.1); // рост
  const barsDip = mkBars(closes);
  const loser = pos();
  ok(E.evalExit(loser, barsDip, 99.5, 50) === null, "в минусе (99.5) тренд-выход НЕ срабатывает — ждём цели");
  // тренд-выход в плюсе работает: два закрытия подряд ниже середины BB
  const sma0 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const c2 = closes.slice();
  c2[28] = sma0 - 0.3; c2[29] = sma0 - 0.5;
  const bars2 = mkBars(c2);
  const r2 = E.evalExit(pos({ target: 130 }), bars2, c2[29], 50);
  ok(r2 && r2.reason === "Сигнал выхода", "в плюсе + два закрытия за серединой BB → Сигнал выхода", JSON.stringify(r2));
  // behindStopLine
  ok(E.behindStopLine(pos(), 97.9) === true, "behindStopLine: 97.9 за стоп-линией 98 → true");
  ok(E.behindStopLine(pos(), 98.1) === false, "behindStopLine: 98.1 выше линии → false");
  ok(E.behindStopLine(be, 100.4) === false, "behindStopLine: стоп в плюсе → всегда false");
}

// ================= 2. ДОГОНЯЮЩИЙ ДВИЖОК (Страж, R29) =================
section("catchExitOnBar: Страж закрывает по тем же правилам");
{
  const p = pos(); // тело 2, провал 97 при failPct 50
  ok(E.catchExitOnBar(p, { h: 98.5, l: 97.5 }, 50) === null, "бар задел только стоп-линию (low 97.5 > 96.94) → живём");
  const f = E.catchExitOnBar(p, { h: 98.5, l: 96.5 }, 50);
  ok(f && f.reason === "Провал" && Math.abs(f.price - 97) < 1e-9, "бар пробил провальную линию → Провал по 97", JSON.stringify(f));
  const t = E.catchExitOnBar(p, { h: 106.5, l: 99 }, 50);
  ok(t && t.reason === "Цель", "бар достиг цели → Цель");
  // консерватизм: в одном баре и провал, и цель — первым считаем выходной уровень (худший случай)
  const both = E.catchExitOnBar(p, { h: 106.5, l: 96 }, 50);
  ok(both && both.reason === "Провал", "бар задел и провал, и цель → провал первым (консервативно)", JSON.stringify(both));
  const be = pos({ stop: 100.5 });
  const bs = E.catchExitOnBar(be, { h: 101, l: 100.3 }, 50);
  ok(bs && bs.reason === "Стоп" && Math.abs(bs.price - 100.5) < 1e-9, "догон: трейлинг-стоп в плюсе работает как стоп", JSON.stringify(bs));
}

// ================= 3. ПОРОГ ВХОДА: база 74, потолок 80 (R29) =================
section("Мозг ИИ: порог входа — кейс «автопилот замер»");
Store.start(); // hydrate() синхронен: глобальный мозг из localStorage проходит через normalizeBrain
ok(Store.state.aiBrain.confThreshold === 80, "загруженный мозг с порогом 84 зажат в 80", String(Store.state.aiBrain.confThreshold));
ok(Store.state.aiBrain.trades === 10, "опыт мозга при зажиме не потерялся");
ok(boot().Store.state.aiBrain.confThreshold === 74, "свежий мозг → база 74 (всё выше 74% открывает само)");

// ================= 4. failPct: дефолт, гвард, синк (R29) =================
section("failPct: дефолт 50, гвард 0..200, попадание в архив синка");
{
  ok(Store.state.failPct === 50, "дефолт провального порога 50%", String(Store.state.failPct));
  ok(Store.setFailPct(300).ok === false, "300 отклоняется (максимум 200)");
  ok(Store.setFailPct(-1).ok === false, "−1 отклоняется");
  const r = Store.setFailPct(75);
  ok(r && r.ok && Store.state.failPct === 75, "setFailPct(75) применился");
  const arc = Store.archiveAccount();
  ok(arc.failPct === 75, "failPct попадает в архив синка (Страж увидит 75)", JSON.stringify({ failPct: arc.failPct }));
  Store.setFailPct(50);
}

// ================= 5. R30: СЛИЯНИЕ АРХИВОВ ПО ПОЗИЦИЯМ =================
section("Синк устройств: union открытых позиций, могилы закрытий, пересчёт баланса");
{
  const closedU0 = { id: "u0-c700", pid: "u0", sym: "BTC", side: "лонг", size: 100, lev: 1, entry: 100, exit: 101, pnl: 0.9, closedAt: 700, exitReason: "Цель" };
  const A = { // ПК (СВЕЖЕЕ устройство): открыл MNT, закрыл u0, держит подписку fcm/a
    v: 3, rev: 10, updatedAt: 1200, balance: 9900, startBalance: 10000,
    userPositions: [{ id: "u1", owner: "user", strategy: "ai", sym: "MNT", side: "лонг", size: 10, lev: 1, entry: 0.53, stop: 0.51, target: 0.6, openedAt: 500, mt: 900 }],
    userClosed: [closedU0],
    labPositions: [], labClosed: [], events: [], equityHist: [], clearedU: [], clearedL: [],
    pushSubs: [{ endpoint: "https://fcm/a", keys: { p256dh: "k", auth: "a" }, ts: 5 }],
  };
  const B = { // телефон: открыл FET, параллельно Страж закрыл u0 (дубль) и MNT (u1)
    v: 3, rev: 5, updatedAt: 1100, balance: 9990, startBalance: 10000,
    userPositions: [{ id: "u2", owner: "user", strategy: "ai", sym: "FET", side: "лонг", size: 10, lev: 1, entry: 0.19, stop: 0.185, target: 0.21, openedAt: 600 }],
    userClosed: [
      { id: "u0-c701", pid: "u0", sym: "BTC", side: "лонг", size: 100, lev: 1, entry: 100, exit: 101, pnl: 0.9, closedAt: 701, exitReason: "Цель" }, // дубль u0
      { id: "u1-c900", pid: "u1", sym: "MNT", side: "лонг", size: 10, lev: 1, entry: 0.53, exit: 0.5, pnl: -0.5, closedAt: 900, exitReason: "Провал" },
    ],
    labPositions: [], labClosed: [], events: [], equityHist: [], clearedU: [], clearedL: [],
    pushSubs: [{ endpoint: "https://fcm/b", keys: { p256dh: "k2", auth: "a2" }, ts: 6 }],
  };
  const m = Store._mergeArchives(B, A); // main = A (свежее updatedAt 1200): u1 открыта на main, закрыта на other
  ok(m.userPositions.length === 1 && m.userPositions[0].id === "u2", "MNT (закрыт на телефоне) не воскрес, FET (открыт на телефоне) жив", JSON.stringify(m.userPositions.map((p) => p.id)));
  ok(m.userClosed.length === 2, "двойное закрытие u0 схлопнуто: записей 2 (u0 + u1)", String(m.userClosed.length));
  const u0 = m.userClosed.find((c) => c.pid === "u0");
  ok(u0 && u0.closedAt === 700, "из дублей закрытия остаётся САМОЕ РАННЕЕ (реальное исполнение)", JSON.stringify(u0 && u0.closedAt));
  ok(Math.abs(m.balance - (9900 - 10 + (10 - 0.5))) < 1e-9, "баланс main согласован: маржа FET зарезервирована, MNT закрыт с зачётом результата (9899.5)", String(m.balance));
  const m2 = Store._mergeArchives(A, B); // main = B: u2 уже в main, u1 там отсутствует
  ok(m2.userPositions.length === 1 && m2.userPositions[0].id === "u2", "и в обратную сторону: закрытое не воскресает", JSON.stringify(m2.userPositions.map((p) => p.id)));
  ok(Math.abs(m2.balance - (9900 - 10 + (10 - 0.5))) < 1e-9, "баланс пересчитан: маржа u2 зарезервирована, u1 закрыта с зачётом результата (9899.5)", String(m2.balance));
  ok(m2.pushSubs.length === 2, "push-подписки обоих устройств в объединённом архиве", String(m2.pushSubs.length));
  // правки позиции (трейлинг) берутся по свежей версии mt
  const A2 = { v: 3, rev: 2, updatedAt: 100, balance: 100, startBalance: 100, userPositions: [{ id: "z", sym: "BTC", side: "лонг", size: 1, lev: 1, entry: 10, stop: 9, target: 12, openedAt: 1, mt: 50 }], userClosed: [], labPositions: [], labClosed: [], events: [], equityHist: [], clearedU: [], clearedL: [], pushSubs: [] };
  const B2 = { v: 3, rev: 3, updatedAt: 200, balance: 100, startBalance: 100, userPositions: [{ id: "z", sym: "BTC", side: "лонг", size: 1, lev: 1, entry: 10, stop: 9.5, target: 12, openedAt: 1, mt: 70 }], userClosed: [], labPositions: [], labClosed: [], events: [], equityHist: [], clearedU: [], clearedL: [], pushSubs: [] };
  const m3 = Store._mergeArchives(A2, B2);
  ok(m3.userPositions[0].stop === 9.5, "свежий трейлинг-стоп (mt 70) побеждает при слиянии", String(m3.userPositions[0].stop));
}

section("Синк устройств: pid у закрытий, отпечаток чувствителен к стопам и подпискам");
{
  const closed = E.closeTrade(pos(), 106, "Цель");
  ok(closed.pid === "t1", "closeTrade несёт pid исходной позиции", String(closed.pid));
  const b4 = boot();
  const S4 = b4.Store.state;
  b4.Store.start();
  const fp0 = b4.Store._fpOf(b4.Store.archiveAccount());
  S4.userPositions = [{ id: "u1", owner: "user", strategy: "ai", sym: "BTC", side: "лонг", size: 10, lev: 1, entry: 100, stop: 98, target: 106, openedAt: 1 }];
  const fp1 = b4.Store._fpOf(b4.Store.archiveAccount());
  S4.userPositions[0].stop = 99.5; S4.userPositions[0].mt = Date.now();
  const fp2 = b4.Store._fpOf(b4.Store.archiveAccount());
  ok(fp1 !== fp0, "появление позиции меняет отпечаток синка");
  ok(fp2 !== fp1, "сдвиг стопа трейлингом меняет отпечаток (иначе не уезжал бы в облако)");
  const r1 = b4.Store.addPushSub({ endpoint: "https://fcm/x", keys: { p256dh: "pk", auth: "au" } });
  ok(r1.ok && b4.Store.state.pushSubs.length === 1 && b4.Store.archiveAccount().pushSubs.length === 1, "подписка Web Push сохраняется в аккаунт и архив синка");
  ok(b4.Store.addPushSub({ endpoint: "http://insecure", keys: { p256dh: "a", auth: "b" } }).ok === false, "неподходящая подписка отклоняется (только https)");
  b4.Store._applyArchive({ userClosed: [], pushSubs: [
    { endpoint: "https://ok/x", keys: { p256dh: "1", auth: "2" } },
    { endpoint: "javascript:evil", keys: { p256dh: "1", auth: "2" } },
  ] });
  ok(b4.Store.state.pushSubs.length === 1 && b4.Store.state.pushSubs[0].endpoint === "https://ok/x", "чужая/опасная подписка из архива отфильтровывается");
}

// ================= 6. R30: ЦЕНЫ ПЕРЕЖИВАЮТ ПЕРЕЗАГРУЗКУ =================
section("Снапшот цен: сохранение и восстановление последнего известного уровня");
{
  const b5 = boot();
  const S5 = b5.Store.state;
  b5.Store.start();
  const now = Date.now();
  S5.prices.BTC = { sym: "BTC", price: 12345.6, prev: 12300, chg24h: 1.5, high24: 12400, low24: 12200, vol24: 999, open24: 12300, spark: [], ts: now };
  S5.prices.FET = { sym: "FET", price: 0.1914, prev: 0.19, chg24h: -2, high24: 0.2, low24: 0.188, vol24: 5e6, open24: 0.195, spark: [], ts: now };
  b5.Store._priceSave();
  // имитация перезагрузки: цены сброшены в дефолты (как было до R30) — восстанавливаем
  S5.prices.BTC.price = 81315; S5.prices.BTC.ts = 0; S5.prices.FET.price = 0.188; S5.prices.FET.ts = 0;
  const okR = b5.Store._priceRestore();
  ok(okR === true, "снапшот нашёлся и применился");
  ok(S5.prices.BTC.price === 12345.6 && S5.prices.FET.price === 0.1914, "цены восстановились, а НЕ сбросились к дефолтам (кейс −0.10/−0.18 при каждом F5)", JSON.stringify({ btc: S5.prices.BTC.price, fet: S5.prices.FET.price }));
  ok(S5.prices.BTC.ts === 0, "восстановленные цены помечены протухшими — сразу докачаются свежие");
  ok(S5.prices.BTC.spark.length > 0, "спарк для интерфейса восстановлен");
  const noSnap = boot();
  ok(noSnap.Store._priceRestore() === false, "без снапшота (новое устройство) — тихий отказ без ошибок");
}

// ================= 7. R30: ТОРГОВЛЯ ТОЛЬКО НА РЕАЛЬНЫХ ДАННЫХ =================
section("Гейт деградации: движок не торгует на синтетике и без источников");
{
  const b6 = boot();
  const S6 = b6.Store.state;
  b6.Store.start();
  const simBars = b6.Store._genSimBars("BTC", 100);
  ok(simBars.length === 110 && simBars.every((b) => b.sim === true), "сим-свечи для графиков помечены sim:true");
  const hb0 = S6.lastScanAt;
  b6.Store._announceDegraded();
  ok(S6.degraded === true, "announceDegraded переводит платформу в деградацию");
  b6.Store._engineStep("BTC", simBars);
  ok(S6.lastScanAt === hb0, "engineStep на сим-свечах не шагает");
  const realBars = mkBars(Array.from({ length: 90 }, (_, i) => 100 + Math.sin(i / 3) * 2));
  b6.Store._engineStep("BTC", realBars);
  ok(S6.lastScanAt === hb0, "engineStep при degraded=true не шагает (даже с реальными барами)");
  const posCount = S6.userPositions.length + S6.labPositions.length + S6.signals.length;
  b6.Store._engineStep("BTC", realBars);
  ok(S6.userPositions.length + S6.labPositions.length + S6.signals.length === posCount, "на синтетике не открываются ни ИИ-, ни лабораторные сделки, ни сигналы");
  b6.Store._announceRestored();
  ok(S6.degraded === false, "announceRestored возвращает торговлю");
  b6.Store._engineStep("BTC", realBars);
  ok(S6.lastScanAt !== hb0, "после восстановления источника движок снова живой");
  // сим-свечи при живом источнике тоже отклоняются (защита от подмены данных)
  const hb1 = S6.lastScanAt;
  b6.Store._engineStep("BTC", simBars);
  ok(S6.lastScanAt === hb1, "помеченные сим-свечи не пропускаются в движок даже без degraded");
}

// ================= 8. R30: WEB PUSH (крипто) =================
section("Web Push: RFC 8291 roundtrip + VAPID ES256 (оффлайн)");
{
  const crypto = require("crypto");
  const wp = require(path.join(REPO, "tools", "webpush.js"));
  const b64u = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const dec = (s) => { s = String(s).replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return Buffer.from(s, "base64"); };
  const { publicKey: cliPub, privateKey: cliPriv } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const clientPubRaw = Buffer.from(cliPub.export({ type: "spki", format: "der" })).slice(-65);
  const sub = { endpoint: "https://fcm.googleapis.com/wp/test123", keys: { p256dh: b64u(clientPubRaw), auth: b64u(crypto.randomBytes(16)) } };
  const payload = JSON.stringify({ title: "ИИ вошёл: MNT лонг 10 ХРЮ", body: "уверенность 78%" });
  const body = wp.encryptPayload(sub.keys.p256dh, payload);
  const salt = body.slice(0, 16), idlen = body[20];
  const asPubRaw = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
  const asPubObj = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex"), asPubRaw]), format: "der", type: "spki" });
  const ecdh = crypto.diffieHellman({ privateKey: cliPriv, publicKey: asPubObj });
  const hkdf = (ikm, s, info, len) => Buffer.from(crypto.hkdfSync("sha256", ikm, s, info, len));
  const prk = hkdf(ecdh, Buffer.alloc(32), Buffer.concat([Buffer.from("WebPush: info"), Buffer.from([0]), clientPubRaw, asPubRaw]), 32);
  const cek = hkdf(prk, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(prk, salt, Buffer.from("Content-Encoding: nonce\0"), 12);
  const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ct.slice(ct.length - 16));
  const record = Buffer.concat([d.update(ct.slice(0, ct.length - 16)), d.final()]);
  ok(record[record.length - 1] === 0x02, "маркер последней записи RFC 8291 на месте");
  ok(record.slice(0, record.length - 1).toString("utf8") === payload, "payload расшифровался байт в байт (кириллица не побилась)");
  let sigOk = true;
  for (let i = 0; i < 20; i++) {
    const h = wp.vapidHeader("https://fcm.googleapis.com/wp/x", wp._privateKeyFromRaw(wp._VAPID_PRIV), wp._VAPID_PUB, "mailto:x@y.z");
    const m = h.match(/^vapid t=(.+?)\.([^\.]+)\.([^\.]+), k=(.+)$/);
    if (!m || !crypto.verify(null, Buffer.from(m[1] + "." + m[2]), { key: wp._publicKeyFromRaw(m[4]), dsaEncoding: "ieee-p1363" }, dec(m[3]))) { sigOk = false; break; }
  }
  ok(sigOk, "VAPID-подпись ES256 валидна ×20 (JOSE r||s)");
  ok(wp._VAPID_PUB.length > 80 && wp._VAPID_PRIV.length > 30, "VAPID-ключи платформы вшиты (нулевая настройка)");
  let threw = null;
  try { wp.encryptPayload("not-base64!!", "x"); } catch (e) { threw = e; }
  ok(Boolean(threw), "битый p256dh подписки не роняет процесс, а отклоняется");
}

// ================= 9. R31: СЕРВЕРНЫЙ АККАУНТ =================
section("R31: слияние ПЕРЕД записью — «свежее» устройство не затирает позиции второго");
{
  // кейс R31 со скринов: ПК и телефон с разными наборами позиций. Раньше устройство
  // с большим updatedAt пушало свой архив КАК ЕСТЬ — позиции другой стороны исчезали.
  // Теперь перед каждой записью обязательное слияние: выжить должны обе стороны.
  const pc = {
    v: 3, rev: 50, updatedAt: 2000, balance: 9385, startBalance: 10000,
    userPositions: [
      { id: "p1", owner: "user", strategy: "ai", sym: "ZEC", side: "лонг", size: 300, lev: 1, entry: 100, stop: 95, target: 110, openedAt: 500, mt: 1500 },
      { id: "p2", owner: "user", strategy: "user", sym: "UNI", side: "лонг", size: 460, lev: 1, entry: 7.4, stop: 7, target: 8, openedAt: 500, mt: 1500 },
    ],
    userClosed: [], labPositions: [], labClosed: [], events: [], equityHist: [], clearedU: [], clearedL: [],
    pushSubs: [], host: null, maxDeal: 1000, maxTotal: 5000, aiThreshold: 50, aiPosMode: "auto", failPct: 50,
    autoTrade: true, aiAuto: true, aiAutoLive: false, mode: "demo",
  };
  const phone = JSON.parse(JSON.stringify(pc));
  phone.updatedAt = 1000; phone.balance = 9795;
  phone.userPositions = [{ id: "p2", owner: "user", strategy: "user", sym: "UNI", side: "лонг", size: 460, lev: 1, entry: 7.4, stop: 7.1, target: 8, openedAt: 500, mt: 1800 }]; // телефон двигал стоп p2
  const mR31 = Store._mergeArchives(pc, phone); // main = ПК (updatedAt 2000)
  ok(mR31.userPositions.length === 2, "позиции ОБЕИХ сторон живы после слияния (ZEC и UNI)", JSON.stringify(mR31.userPositions.map((p) => p.id)));
  ok(mR31.userPositions.find((p) => p.id === "p2").stop === 7.1, "у спорной позиции берётся свежая правка (стоп 7.1 по mt 1800)");
  ok(mR31.balance === 9385, "баланс согласован с позициями main-стороны", String(mR31.balance));
}

section("R31: аренда исполнителя автоторговли (host) — merge, claim, release");
{
  const base = { v: 3, rev: 1, updatedAt: 100, balance: 1000, startBalance: 1000, userPositions: [], userClosed: [], labPositions: [], labClosed: [], events: [], equityHist: [], clearedU: [], clearedL: [], pushSubs: [] };
  const h1 = Object.assign({}, base, { host: { id: "dA", tag: "браузер", until: 5000 } });
  const h2 = Object.assign({}, base, { host: { id: "dB", tag: "Страж", until: 9000 } });
  ok(Store._mergeArchives(h1, h2).host.id === "dB", "слияние аренды: действует более поздний срок (dB)");
  ok(Store._mergeArchives(h1, Object.assign({}, base, { host: null })).host.id === "dA", "слияние аренды: null не затирает живую аренду");
  ok(Store._fpOf(h1) !== Store._fpOf(Object.assign({}, base, { host: { id: "dA", tag: "браузер", until: 6000 } })), "продление аренды меняет отпечаток (уезжает в облако)");

  Store.state.host = { id: "other-device", tag: "чужой", until: Date.now() + 60000 };
  ok(Store.isAutoHost() === false, "чужая живая аренда — это устройство НЕ исполнитель");
  ok(Store.claimHost("тест") === false, "заявка при чужой живой аренде отклонена");
  ok(Store.hostInfo().host.id === "other-device", "чужая аренда видна в hostInfo (Кабинет покажет её)");
  Store.state.host = { id: "other-device", tag: "чужой", until: Date.now() - 10 };
  ok(Store.hostInfo().host === null, "истёкшая аренда = свободно");
  ok(Store.claimHost("тест-девайс") === true, "свободная аренда берётся");
  ok(Store.isAutoHost() === true && Store.state.host.tag === "тест-девайс", "после заявки это устройство — исполнитель с меткой");
  ok(Store.releaseHost(true) === true && Store.hostInfo().host === null, "releaseHost освобождает аренду");

  Store.state.host = { id: "dX", tag: "т", until: 123456 };
  const arch = Store.archiveAccount();
  ok(arch.host && arch.host.id === "dX" && arch.host.until === 123456, "аренда попадает в архив (и в облако)");
  Store.state.host = null;
  Store._applyArchive(arch);
  ok(Store.state.host && Store.state.host.id === "dX", "аренда восстанавливается из архива облака");
  Store.releaseHost(true);
}

section("R31: часы изменения — фоновый персист не двигает updatedAt");
{
  const b5 = boot();
  const S5 = b5.Store.state;
  b5.Store.start();
  S5.balance = 12345;
  b5.Store._persistNow();
  const t1 = S5.updatedAt;
  ok(t1 > 0, "первое сохранение ставит часы изменения");
  b5.Store._persistNow(); // повторная запись без изменений содержимого
  ok(S5.updatedAt === t1, "фоновая запись (эквити/цены) НЕ двигает updatedAt — прежняя причина вечного «я свежее»");
  S5.balance = 12346;
  while (Date.now() <= t1) {} // VM быстрый: гарантируем, что настенные часы ушли вперёд с t1
  b5.Store._persistNow();
  ok(S5.updatedAt > t1, "реальное изменение (баланс) двигает часы");
}

section("R31: дедупликация двойных исполнений закрытия в ленте событий");
{
  const base = { v: 3, rev: 1, updatedAt: 100, balance: 1000, startBalance: 1000, userPositions: [], userClosed: [], labPositions: [], labClosed: [], events: [], equityHist: [], clearedU: [], clearedL: [], pushSubs: [] };
  const eA = Object.assign({}, base, { events: [{ id: "xp1", ts: 10, tone: "bull", title: "закрыта" }] });
  const eB = Object.assign({}, base, { events: [{ id: "xp1", ts: 12, tone: "bull", title: "закрыта" }] });
  ok(Store._mergeArchives(eA, eB).events.length === 1, "одно закрытие, исполненное двумя устройствами, даёт ОДНО событие (детерминированный id)");
}

// ================= 10. Исходный контроль R29 + R30 + R31 =================
section("Исходники: контроль ключевых констант");
{
  const engineSrc = fs.readFileSync(path.join(REPO, "js", "engine.js"), "utf8");
  const storeSrc = fs.readFileSync(path.join(REPO, "js", "store.js"), "utf8");
  ok(/FAIL_SLACK = 0\.0006/.test(engineSrc), "гистерезис провала 0.06% на месте");
  ok(/confThreshold: 74,/.test(storeSrc), "база порога 74 в defaultBrain");
  ok(/Math\.min\(80, Math\.round\(br\.confThreshold\)\)/.test(storeSrc), "потолок калибровки 80");
  ok(/< 4 \* 60000\) return;/.test(storeSrc), "разгонка входов: окно 4 минуты");
  ok(/Engine\.catchExitOnBar\(pos, bar, state\.failPct\)/.test(storeSrc), "догоняет через единую Engine.catchExitOnBar");
  ok(/pid: pos\.id/.test(engineSrc), "закрытия несут pid исходной позиции (R30)");

  const binSrc = fs.readFileSync(path.join(REPO, "js", "binance.js"), "utf8");
  for (const host of ["data-api.binance.vision", "api.mexc.com", "api.bybit.com", "www.okx.com", "api.gateio.ws", "api.kucoin.com", "api.bitget.com", "min-api.cryptocompare.com", "api.coingecko.com"]) {
    ok(binSrc.indexOf(host) !== -1, "источник цен: " + host);
  }

  ok(/if \(state\.degraded \|\| \(bars\[bars\.length - 1\] && bars\[bars\.length - 1\]\.sim\)\) return;/.test(storeSrc), "движок не торгует при деградации и на помеченных сим-свечах (R30)");
  ok(!/simTick/.test(storeSrc), "симулятор цен simTick удалён (фейковый PnL больше не генерируется)");
  ok(/savePriceSnapshot\(\); \/\/ R30: цены последнего сеанса/.test(storeSrc), "снапшот цен пишется при выгрузке страницы");
  ok(/restorePriceSnapshot\(\); \/\/ R30: цены прошлого сеанса/.test(storeSrc), "снапшот цен восстанавливается при загрузке");

  // R31: серверный аккаунт — слияние перед каждой записью, один исполнитель, честные часы
  ok(/const merged = mergeArchives\(local, remote\);/.test(storeSrc) && !/remote\.updatedAt \|\| 0\)\) \{ syncPush/.test(storeSrc), "путь «записать облако без слияния» удалён (причина расхождения ПК/телефон)");
  ok(/if \(!serverMode\(\) && isAutoHost\(\)\) \{ try \{ aiAutoStep/.test(storeSrc), "входы ИИ — только у исполнителя (R32: или у сервера — тогда локально выключены)");
  ok(/Server\.bootstrap\(archiveAccount\(\)\)/.test(storeSrc) && /Server\.startPolling/.test(storeSrc), "R32: серверный режим — bootstrap + опрос состояния сервера");
  ok(/serverAction\("clearHistory"/.test(storeSrc), "R32: очистка истории исполняется НА СЕРВЕРЕ");
  ok(/if \(!isAutoHost\(\)\) continue; \/\/ R31: вход лаборатории/.test(storeSrc), "входы лаборатории — только у исполнителя");
  ok(/if \(!claimHost\("устройство · догон рынка"\)\) return/.test(storeSrc), "догон рынка — только у исполнителя");
  ok(/id: "x" \+ pidOfClosed\(e\.closed\)/.test(storeSrc), "детерминированные id событий закрытия (дедуп двойных исполнений)");
  ok(!/Синхронизация: архив аккаунта обновлён/.test(storeSrc), "облачное слияние молча (без событий-топлива для цикла записей)");
  ok(/syncPull\(\); \}, 20000\)/.test(storeSrc), "опрос сервера раз в 20 секунд");
  ok(/Date\.now\(\) - lastCycleOkAt > 25000/.test(storeSrc), "beacon пишет только свежее 25с состояние (без перетирания)");

  const guardSrcR31 = fs.readFileSync(path.join(REPO, "tools", "guardian.js"), "utf8");
  ok(/Store\.claimHost\("Страж \(GitHub Actions\)"\)/.test(guardSrcR31), "Страж берёт аренду и не мешает живому устройству");
  ok(/Store\.releaseHost\(true\)/.test(guardSrcR31), "Страж освобождает аренду перед выходом");

  const notifySrc = fs.readFileSync(path.join(REPO, "js", "notify.js"), "utf8");
  ok(/pushManager\.subscribe/.test(notifySrc) && /VAPID_PUBLIC = "BEwaH/.test(notifySrc), "нативная подписка Web Push с VAPID-ключом платформы");
  ok(notifySrc.indexOf("ntfy") === -1, "ntfy полностью убран из notify.js");
  ok(/tryEnsure\(3\)/.test(notifySrc), "авто-подписка при уже выданном разрешении (3 попытки + самозалечивание)");
  ok(/pushHealthLoop/.test(notifySrc), "R32: цикл здоровья пуши — умершая подписка восстанавливается сама");
  ok(/Server\.pushSub\(\{ endpoint: raw\.endpoint, keys: raw\.keys \}\)/.test(notifySrc), "R32: живая подписка перерегистрируется на сервере");

  const guardSrc = fs.readFileSync(path.join(REPO, "tools", "guardian.js"), "utf8");
  ok(/require\("\.\/webpush\.js"\)/.test(guardSrc), "Страж шлёт пуши через tools/webpush.js (нативный Web Push)");
  ok(guardSrc.indexOf("ntfy") === -1, "ntfy убран из Стража");
  ok(/deadSubs/.test(guardSrc), "мёртвые push-подписки вычищаются");
  const wpSrc = fs.readFileSync(path.join(REPO, "tools", "webpush.js"), "utf8");
  ok(/aes128gcm/.test(wpSrc) && /ES256|prime256v1/.test(wpSrc), "tools/webpush.js: RFC 8291/8292 на чистом Node crypto");

  const viewsSrc = fs.readFileSync(path.join(REPO, "js", "views-trade.js"), "utf8");
  ok(/ai:fail-apply/.test(viewsSrc) && /ai-fail-input/.test(viewsSrc), "UI провального порога на месте");
  ok(viewsSrc.indexOf("ntfy") === -1 && /notify:push-enable/.test(viewsSrc), "Кабинет: ntfy заменён на подписку Web Push");
  ok(/торговля стоит · цены заморожены/.test(viewsSrc), "честная плашка деградации в сделках");

  const swSrc = fs.readFileSync(path.join(REPO, "sw.js"), "utf8");
  ok(/VERSION = "xenoai-v15"/.test(swSrc), "SW поднят до v15");
  ok(/SKIP_WAITING/.test(swSrc), "R32: SKIP_WAITING — новая версия SW применяется сразу");
  const idx = fs.readFileSync(path.join(REPO, "index.html"), "utf8");
  ok(idx.indexOf("v=20261036") !== -1, "кэш-версии ?v=20261036");
  ok(idx.indexOf("js/backend.js") !== -1 && idx.indexOf("js/backend-config.js") !== -1, "R32: серверный клиент подключён в index.html");
  const yml = fs.readFileSync(path.join(REPO, ".github", "workflows", "guardian.yml"), "utf8");
  ok(yml.indexOf("npm install") === -1, "Стражу не нужны npm-зависимости (чистый Node crypto)");
}

console.log(`\n────────────────────────────\nИТОГО: ${passed} ✓ / ${failed} ✗`);
process.exit(failed ? 1 : 0);
