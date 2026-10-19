#!/usr/bin/env node
// XenoAI Trade — АВТОНОМНЫЙ СТРАЖ (serverless-раннер торгового движка).
//
// ЗАЧЕМ: платформа — чистый статический сайт, и пока браузер закрыт, исполнять сделки
// некому. Страж закрывает этот пробел: он запускается по расписанию (GitHub Actions,
// каждые 15 минут), подтягивает архив аккаунта из облака, ДОГОНЯЕТ рынок тем же
// догоняющим движком, что и браузер (стопы/цели/безубыток/входы/флипы ИИ — по реальным
// 15-минутным свечам, исполнение задним числом) и сохраняет результат обратно в облако.
// Итог: ИИ торгует, анализирует и закрывает сделки даже когда ВСЕ устройства выключены.
//
// ПУШИ: события прогона уходят нативным Web Push на подписанные устройства аккаунта
// (tools/webpush.js, RFC 8291/8292, без npm-зависимостей).
//
// РЕЖИМЫ: страж обслуживает то состояние, которое лежит в облаке: демо-счёт в ХРЮ —
// полностью; автопилот реального режима (aiAutoLive) — как и в браузере, симуляцией на
// реальных ценах (реальные ордера всегда отправляет только человек, ключи биржи на
// сервере не хранятся и сюда не попадают).
//
// ЗАПУСК:  node tools/guardian.js <логин> <код синхронизации>
//   логин — David или Yura (владелец счёта), код — код синхронизации аккаунта
//   (Кабинет → «Синхронизация устройств» → скопировать). На GitHub оба значения
//   кладутся в Secrets: XENOAI_LOGIN и XENOAI_SYNC_CODE (.github/workflows/guardian.yml).
//
// БЕЗОПАСНОСТЬ: только стандартная библиотека Node 18+ (fetch встроен), ноль npm-зависимостей;
// идемпотентность — детерминированные id закрытий/входов догоняющего движка + слияние
// архивов по union: параллельный прогон браузером не создаёт дублей.
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const LOGIN = String(process.argv[2] || process.env.XENOAI_LOGIN || "").trim();
const CODE = String(process.argv[3] || process.env.XENOAI_SYNC_CODE || "").trim();

if (!/^(david|yura)$/i.test(LOGIN)) {
  console.error("Страж: укажите логин владельца счёта (David или Yura) первым аргументом");
  process.exit(2);
}
if (!/^[A-Z0-9-]{8,24}$/.test(CODE.toUpperCase())) {
  console.error("Страж: укажите код синхронизации аккаунта вторым аргументом (8–24 симв. A-Z0-9-)");
  process.exit(2);
}

const JS_DIR = path.join(__dirname, "..", "js");
const BRAIN_URL = "https://textdb.online/xenoai-global-brain-a7x42";

// ---------- контекст: минимальные заглушки браузера + настоящие fetch/crypto ----------
const mem = {}; // in-memory localStorage (состояние живёт в облаке, не здесь)
const ctx = {
  console, Date, Math, JSON, Promise, URL,
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
  navigator: {},
};
ctx.window = ctx;
ctx.globalThis = ctx;
ctx.localStorage = {
  getItem: (k) => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[String(k)] = String(v); },
  removeItem: (k) => { delete mem[String(k)]; },
  get length() { return Object.keys(mem).length; },
  key: (i) => Object.keys(mem)[i] || null,
};
ctx.document = { addEventListener: () => {}, hidden: true };
ctx.addEventListener = () => {}; ctx.removeEventListener = () => {};
ctx.confirm = () => false; // страж ничего не подтверждает руками: реальный режим управляется флагом из архива
ctx.fetch = (url, opts) => fetch(url, opts); // Node 18+
// страж действует ОТ ИМЕНИ владельца счёта (торговать может только David/Yura)
ctx.Auth = {
  sessionLogin: () => LOGIN,
  readSession: () => ({ login: LOGIN, role: "admin", at: Date.now() }),
  syncCodeFor: () => null, // код задаётся явно аргументом, авто-вывод не нужен
};
vm.createContext(ctx);

const FILES = ["format.js", "data.js", "indicators.js", "candles.js", "binance.js", "engine.js", "store.js"];
for (const f of FILES) {
  vm.runInContext(fs.readFileSync(path.join(JS_DIR, f), "utf8"), ctx, { filename: f });
}

const Store = ctx.window.Store;
const Fmt = ctx.window.Fmt || { fmtNum: (v) => String(Math.round(v)) };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const t0 = Date.now();
  const S = Store.state;
  // рантайм стража: состояние из облака, синк на наш ключ, платформа «запущена»
  S.sync.code = CODE.toUpperCase();
  S.sync.enabled = true;
  S.sync.sawRemote = true; // облако — источник истины: пустое локальное состояние ничего не затрёт
  S.started = true;

  // 1) архив аккаунта из облака (слияние с дефолтом: данные облака главнее)
  await Store.syncPull();
  console.log(`Страж: аккаунт ${LOGIN} загружен из облака · баланс ${Fmt.fmtNum(Math.round(S.balance))} ХРЮ · открытых позиций ${S.userPositions.length} · автопилот ${S.mode === "live" ? "реальный режим, " + (S.aiAutoLive ? "ВКЛ" : "выкл (правило безопасности)") : "демо, " + (S.aiAuto ? "ВКЛ" : "выкл")}`);

  // 2) глобальный мозг ИИ (общая память всех устройств и пользователей)
  try {
    const r = await fetch(BRAIN_URL, { signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined });
    const txt = (await r.text()).trim();
    if (txt) {
      const brain = JSON.parse(txt);
      if (brain && brain.v === 1 && (!S.aiBrain || (brain.trades || 0) > (S.aiBrain.trades || 0))) S.aiBrain = brain;
    }
  } catch (e) { /* мозг недоступен — ИИ поработает на локальной копии из архива */ }

  // 3) ДОГОН РЫНКА тем же движком, что и в браузере: стопы/цели/безубыток/входы/флипы
  //    по реальным 15-минутным свечам за период отсутствия (до ~10 суток покрытия)
  const evBefore = new Set((S.events || []).map((e) => e.id)); // снимок до прогона: новыми считаем только события этого запуска
  const caught = await Store.catchUp();
  const recent = S.userClosed.slice(0, 5).map((c) => `  ${c.sym} ${c.side} ${c.pnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(c.pnl)))} ХРЮ (${c.exitReason})`);
  console.log(`Страж: догон рынка ${caught ? "выполнен" : "не потребовался"} · последних закрытий: ${recent.length ? "\n" + recent.join("\n") : "0"} · позиций в рынке: ${S.userPositions.length} · эквити ${Fmt.fmtNum(Math.round(Store.totalEquity()))} ХРЮ`);

  // 4) PUSH НА СМАРТФОН (нативный Web Push): события этого прогона уходят на ВСЕ
  //    устройства аккаунта, чьи подписки лежат в архиве (pushSubs). Подписку устройство
  //    создаёт само после разрешения уведомлений (нативный Push API, VAPID-ключ вшит в
  //    платформу) и синхронизирует в облако — Стражу ничего дополнительно не нужно.
  //    Мёртвые подписки (404/410 — приложение переустановили, endpoint сменился)
  //    вычищаются из архива. Сбой канала НЕ роняет прогон: торговля важнее уведомлений.
  let pushOk = 0, pushFail = 0;
  const deadSubs = [];
  const freshEvents = (S.events || []).filter((e) => e && e.id && !evBefore.has(e.id)).slice(0, 10); // потолок 10 за прогон
  const subs = (S.pushSubs || []).filter((s) => s && s.endpoint && s.keys).slice(0, 8);
  if (subs.length && freshEvents.length) {
    const wp = require("./webpush.js"); // ноль npm-зависимостей: чистый Node crypto (RFC 8291/8292)
    for (const ev of freshEvents) {
      const payload = {
        title: String(ev.title || "XenoAI Trade").slice(0, 120),
        body: String(ev.detail || "").slice(0, 300),
        tag: ev.tone === "bear" ? "xenoai-bear" : "xenoai",
        url: "./",
      };
      for (const sub of subs) {
        const r = await wp.sendPush(sub, payload, { urgency: ev.tone === "bear" ? "high" : "normal", ttl: 3600 });
        if (r.ok) pushOk++;
        else if (r.dead && !deadSubs.includes(sub.endpoint)) deadSubs.push(sub.endpoint);
        else if (!r.ok) pushFail++;
      }
      await sleep(250); // push-сервисы не любят очереди мгновенных POST
    }
    console.log(`Страж: Web Push — доставлено ${pushOk}, сбоев ${pushFail}${deadSubs.length ? `, мёртвых подписок ${deadSubs.length}` : ""}`);
  }
  if (deadSubs.length) {
    S.pushSubs = subs.filter((s) => !deadSubs.includes(s.endpoint));
    console.log(`Страж: вычищено мёртвых push-подписок: ${deadSubs.length} (переустановленное приложение создаст новую при первом запуске)`);
  }

  // 5) сохранить результат в облако (архив + мозг, если учился)
  await Store.syncPush("seed");
  await sleep(13000); // даём отработать пушу мозга (debounce 4с + защитное чтение облака + запись)
  console.log(`Страж: результат сохранён в облако (${((Date.now() - t0) / 1000).toFixed(1)} с) · след. прогон по расписанию`);
  process.exit(0);
})().catch((e) => {
  console.error("Страж: сбой прогона —", (e && e.message) || e);
  process.exit(1);
});
