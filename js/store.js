// XenoAI Trade — глобальный store: реальные данные Binance + торговый движок
// + демо-счёт в ХРЮ (персистится в localStorage). При недоступности API —
// деградация в симуляцию, чтобы платформа оставалась живой.
"use strict";

const Store = (() => {
  const { WATCHLIST, BY_SYM, ENGINE_TF, TF_MAP, DEFAULT_PRICES, seedSpark } = DataLib;
  const WATCH_SYMS = WATCHLIST.map((i) => i.sym);

  const listeners = new Set();
  const state = {
    prices: {},
    bars: {},            // ключ `${sym}:${tf}`
    degraded: false,
    source: null,        // рабочий источник данных: binance / bybit / okx / null (симуляция)
    lastSync: 0,
    signals: [],
    labAccounts: Engine.mkLabAccounts(),
    labPositions: [],
    labClosed: [],
    autoTrade: false, // автоторговля лаборатории по умолчанию выключена: сделки открывают только David и Yura
    events: [],
    whales: {},
    whaleScannedAt: {},
    balance: 10000,
    startBalance: 10000,
    userPositions: [],
    userClosed: [],
    equityHist: [],
    started: false,
    activeSym: "BTC",
    mode: "demo",       // demo | live (реальный рынок)
    aiAuto: true,       // ИИ-автопилот: сам заходит в монеты и флипает, спот-only
    aiIdeas: [],        // сканер ИИ: лучшие идеи по всем монетам
    liveOrders: [],     // отправленные реальные ордера (заготовка реальной торговли)
    aiBrain: null,      // память ИИ: адаптивные веса, статистика монет, уроки (обучение на сделках)
    aiSession: null,    // сессия автопилота: { startEquity, openedAt } — база для авто-стопа ±лимит
    aiStop: null,       // причина авто-стопа сессии: { reason: profit|loss, pct, ts, threshold, closed }
    aiThreshold: 50,    // лимит сессии ИИ, % от базы: +50% профита или −50% просадки → стоп (настраивается)
    news: { items: [], ts: 0, source: null }, // реальная новостная лента (для ИИ и карточки фона)
  };

  // ------- память ИИ (обучение на результатах сделок) -------
  function defaultBrain() {
    return {
      v: 1,
      weights: null,       // null → базовые Engine.AI_BASE_WEIGHTS; далее — адаптивные
      rel: {},             // надёжность фактора (множитель веса) 0.55..1.5, старт 1
      symStats: {},        // sym → { n, wins, streak, avgPct } — опыт по монетам
      confThreshold: 76,   // динамический порог входа автопилота (калибруется результатами)
      trades: 0, wins: 0, losses: 0,
      lessons: [],         // что ИИ вынес из сделок (лента выводов)
      wFlags: {},          // защита уроков от повторов
      updatedAt: 0,
    };
  }
  state.aiBrain = defaultBrain();

  WATCH_SYMS.forEach((sym, i) => {
    const p = DEFAULT_PRICES[sym] != null ? DEFAULT_PRICES[sym] : 1;
    state.prices[sym] = { sym, price: p, prev: p, chg24h: 0, high24: p * 1.01, low24: p * 0.99, vol24: 0, open24: p, spark: seedSpark(p, i), ts: 0 };
  });

  // свежесть цены: монеты, которых нет на текущем источнике, докачиваются индивидуально
  // (у бирж разные листинги: ZEC нет на Bybit, GRASS/MNT нет на Binance)
  const PRICE_STALE_MS = 30000;
  function isPriceFresh(sym) {
    const p = state.prices[sym];
    return Boolean(p && p.ts && Date.now() - p.ts <= PRICE_STALE_MS);
  }

  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function emit() { listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } }); }

  // ---------- персистентность ----------
  // Версия v3: чистый старт — все сделки и статистики обнулены.
  const STORAGE_VER = "xenoai_v3";
  // Сделки может открывать только администратор David или Yura.
  const TRADE_ACCOUNTS = ["david", "yura"];
  let persistTimer = null;
  function dataKey() {
    const login = Auth.sessionLogin();
    return login ? `${STORAGE_VER}_${login.toLowerCase()}` : `${STORAGE_VER}_anon`;
  }
  function wipeOldStorages() {
    // одноразовая уборка демо-данных прошлой версии (xenoai_v2_*) — полный сброс сделок и статистик
    try {
      const kill = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.indexOf("xenoai_v2_") === 0 || k.indexOf("xenoai_v1_") === 0)) kill.push(k);
      }
      kill.forEach((k) => localStorage.removeItem(k));
    } catch (e) { /* noop */ }
  }
  function persist() {
    if (!Auth.sessionLogin()) return;
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      try {
        const s = state;
        const data = {
          balance: s.balance, startBalance: s.startBalance,
          userPositions: s.userPositions, userClosed: s.userClosed.slice(0, 200),
          labAccounts: s.labAccounts, labPositions: s.labPositions, labClosed: s.labClosed.slice(0, 300),
          events: s.events.slice(0, 60), autoTrade: s.autoTrade, equityHist: s.equityHist.slice(-300),
          mode: s.mode, aiAuto: s.aiAuto, liveOrders: s.liveOrders.slice(0, 50),
          aiBrain: s.aiBrain, aiSession: s.aiSession, aiStop: s.aiStop, aiThreshold: s.aiThreshold,
        };
        localStorage.setItem(dataKey(), JSON.stringify(data));
      } catch (e) { /* noop */ }
    }, 400);
  }
  function hydrate() {
    wipeOldStorages();
    try {
      const raw = localStorage.getItem(dataKey());
      if (!raw) { welcomeIfFresh(); return; }
      const d = JSON.parse(raw);
      if (typeof d.balance === "number") state.balance = d.balance;
      if (typeof d.startBalance === "number") state.startBalance = d.startBalance;
      if (Array.isArray(d.userPositions)) state.userPositions = d.userPositions;
      if (Array.isArray(d.userClosed)) state.userClosed = d.userClosed;
      if (Array.isArray(d.labAccounts) && d.labAccounts.length === Engine.STRATEGIES.length) state.labAccounts = d.labAccounts;
      if (Array.isArray(d.labPositions)) state.labPositions = d.labPositions;
      if (Array.isArray(d.labClosed)) state.labClosed = d.labClosed;
      if (Array.isArray(d.events)) state.events = d.events;
      if (Array.isArray(d.equityHist)) state.equityHist = d.equityHist;
      if (typeof d.autoTrade === "boolean") state.autoTrade = d.autoTrade;
      if (d.mode === "demo" || d.mode === "live") state.mode = d.mode;
      if (typeof d.aiAuto === "boolean") state.aiAuto = d.aiAuto;
      if (Array.isArray(d.liveOrders)) state.liveOrders = d.liveOrders;
      if (d.aiBrain && typeof d.aiBrain === "object" && d.aiBrain.v === 1) {
        state.aiBrain = { ...defaultBrain(), ...d.aiBrain };
        if (!state.aiBrain.rel || typeof state.aiBrain.rel !== "object") state.aiBrain.rel = {};
        if (!Array.isArray(state.aiBrain.lessons)) state.aiBrain.lessons = [];
        if (!state.aiBrain.symStats || typeof state.aiBrain.symStats !== "object") state.aiBrain.symStats = {};
      }
      if (d.aiSession && typeof d.aiSession.startEquity === "number") state.aiSession = d.aiSession;
      if (d.aiStop && (d.aiStop.reason === "profit" || d.aiStop.reason === "loss")) state.aiStop = d.aiStop;
      if (typeof d.aiThreshold === "number" && d.aiThreshold >= 5 && d.aiThreshold <= 500) state.aiThreshold = d.aiThreshold;
      // в реальном режиме после перезагрузки страницы соединение надо перепроверить
      if (state.mode === "live" && !(window.Live && Live.isConnected())) state.mode = "demo";
    } catch (e) { /* noop */ }
  }
  function switchUser() {
    const started = state.started;
    state.prices = {};
    WATCH_SYMS.forEach((sym, i) => {
      const p = DEFAULT_PRICES[sym] != null ? DEFAULT_PRICES[sym] : 1;
      state.prices[sym] = { sym, price: p, prev: p, chg24h: 0, high24: p * 1.01, low24: p * 0.99, vol24: 0, open24: p, spark: seedSpark(p, i), ts: 0 };
    });
    state.bars = {}; state.degraded = false; state.lastSync = 0;
    state.signals = []; state.labAccounts = Engine.mkLabAccounts();
    state.labPositions = []; state.labClosed = []; state.autoTrade = false;
    state.events = []; state.whales = {}; state.whaleScannedAt = {};
    state.balance = 10000; state.startBalance = 10000;
    state.userPositions = []; state.userClosed = []; state.equityHist = [];
    state._ai = null;
    state.aiIdeas = []; state.liveOrders = [];
    state.aiBrain = defaultBrain(); state.aiSession = null; state.aiStop = null;
    state.aiThreshold = 50; // дефолт до загрузки персист-данных пользователя
    state.started = started; state.activeSym = "BTC";
    hydrate();
  }

  // сделки может открывать/закрывать только аккаунт David или Yura
  function canTrade() {
    const login = Auth.sessionLogin();
    return Boolean(login && TRADE_ACCOUNTS.indexOf(login.toLowerCase()) !== -1);
  }

  function pushEvent(e) {
    state.events = [{ ...e, id: `e${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, ts: Date.now() }, ...state.events].slice(0, 60);
  }

  // первый запуск аккаунта: приветственная лента вместо пустого экрана
  function welcomeIfFresh() {
    pushEvent({
      tone: "neutral",
      title: "Счёт XenoAI Trade активирован: 10 000 ХРЮ",
      detail: "демо-средства · реальные рыночные цены · сделки открывает только владелец аккаунта",
    });
    pushEvent({
      tone: "neutral",
      title: "Как открыть первую сделку на базе ИИ",
      detail: "Рынок или Сделки → блок «Сделка на базе ИИ» → «Проанализировать» → «Открыть по сигналу ИИ»",
    });
    pushEvent({
      tone: "neutral",
      title: "ИИ-сканер ищет лучшие идеи по рынку",
      detail: "автопилот вкл: сам заходит в монеты · скам- и новостная защита · авто-стоп сессии при ±50% (лимит настраивается)",
    });
  }

  function klineToBars(rows) {
    return rows.map((k) => ({ o: k.o, h: k.h, l: k.l, c: k.c, v: k.v, t: Math.floor(k.openTime / 60000) }));
  }

  // ---------- действия ----------
  function setActiveSym(sym) {
    state.activeSym = sym;
    ensureBars(sym, "15м");
    loadWhales(sym);
    emit();
  }

  function getBars(sym, tf) { return state.bars[`${sym}:${tf}`] || []; }

  function ensureBars(sym, tf) {
    const key = `${sym}:${tf}`;
    if (state.bars[key]) return;
    const inst = BY_SYM[sym];
    if (!inst) return;
    const interval = (TF_MAP[tf] && TF_MAP[tf].binance) || "15m";
    Binance.fetchKlines(inst.pair, interval, 120)
      .then((rows) => {
        state.bars[key] = klineToBars(rows);
        state.degraded = false;
        state.lastSync = Date.now();
        emit();
      })
      .catch(() => {
        // деградация: синтетические свечи вокруг последней известной цены
        const p = (state.prices[sym] && state.prices[sym].price) || DEFAULT_PRICES[sym] || 1;
        const stepMin = (TF_MAP[tf] && TF_MAP[tf].stepMin) || 15;
        const sim = Candles.genCandles({ seed: sym.length * 31 + sym.charCodeAt(0), n: 110, start: p * 0.985, end: p, stepMin, volBase: 0.008 });
        state.bars[key] = sim;
        emit();
      });
  }

  function placeDemo(p) {
    if (!canTrade()) return { ok: false, error: "Сделки может открывать только аккаунт David или Yura" };
    const p0 = state.prices[p.sym];
    if (!p0 || !p0.price) return { ok: false, error: "Цена ещё не загружена — попробуйте через секунду" };
    if (!p0.ts || Date.now() - p0.ts > 120000) return { ok: false, error: "Цена по этой монете не обновляется — подождите или выберите другую" };
    const price = p0.price;
    const margin = Math.round(Number(p.size) || 0);
    if (!(margin > 0)) return { ok: false, error: "Некорректный размер сделки" };
    if (margin > state.balance) return { ok: false, error: `Недостаточно хрювен: свободно ${Fmt.fmtNum(state.balance)} ХРЮ` };
    const risk = price * 0.02; // стоп −2% по умолчанию (ИИ передаёт свои уровни)
    const pos = {
      id: `u${Date.now()}`, owner: "user", strategy: p.strategy || "manual", sym: p.sym, side: p.side,
      size: margin, lev: p.lev || 1, entry: price,
      stop: p.stop || (p.side === "лонг" ? price - risk : price + risk),
      target: p.target || (p.side === "лонг" ? price + risk * 2 : price - risk * 2),
      openedAt: Date.now(),
      ai: p.ai || null,
    };
    // ХРЮ реально списываются со счёта в момент открытия
    state.balance -= margin;
    state.userPositions = [pos, ...state.userPositions];
    pushEvent({
      tone: p.side === "лонг" ? "bull" : "bear",
      title: p.strategy === "ai" ? `ИИ-сделка открыта: ${p.sym} ${p.side} ×${pos.lev}` : `Демо-сделка открыта: ${p.sym} ${p.side} ×${pos.lev}`,
      detail: `${Fmt.fmtNum(margin)} ХРЮ по реальной цене ${price.toPrecision(6)}${p.ai ? ` · уверенность ИИ ${p.ai.confidence}%` : ""}`,
      sym: p.sym,
    });
    persist();
    emit();
    return { ok: true, pos };
  }

  function closeDemo(id) {
    if (!canTrade()) return { ok: false, error: "Закрывать сделки может только аккаунт David или Yura" };
    const pos = state.userPositions.find((p) => p.id === id);
    if (!pos) return { ok: false, error: "Позиция не найдена" };
    const price = (state.prices[pos.sym] && state.prices[pos.sym].price) || pos.entry;
    const closed = Engine.closeTrade(pos, price, "Вручную");
    state.userPositions = state.userPositions.filter((p) => p.id !== id);
    state.userClosed = [closed, ...state.userClosed].slice(0, 300);
    state.balance += pos.size + closed.pnl; // возврат маржи + результат (уже после комиссии 0.1%)
    learnFromClosed(closed); // ИИ учится на результате
    pushEvent({
      tone: closed.pnl >= 0 ? "bull" : "bear",
      title: `Демо-сделка закрыта: ${pos.sym} ${closed.pnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(closed.pnl)))} ХРЮ`,
      detail: closed.exitReason,
      sym: pos.sym,
    });
    persist();
    emit();
    return { ok: true, closed };
  }

  function setBalance(v) {
    state.balance = v; state.startBalance = v;
    // ввод/вывод не должен считаться результатом сессии ИИ — перебазируем
    if (state.aiAuto && state.aiSession) state.aiSession.startEquity = totalEquity();
    pushEvent({ tone: "neutral", title: `Баланс демо-счёта установлен: ${Fmt.fmtNum(v)} ХРЮ`, detail: "Кабинет пользователя" });
    persist(); emit();
  }

  function resetDemo() {
    state.balance = state.startBalance;
    state.userPositions = []; state.userClosed = [];
    state.labAccounts = Engine.mkLabAccounts();
    state.labPositions = []; state.labClosed = []; state.equityHist = [];
    state._ai = null;
    state.aiSession = { startEquity: totalEquity(), openedAt: Date.now() };
    state.aiStop = null;
    pushEvent({ tone: "neutral", title: "Демо-счёт сброшен", detail: "Все сделки и статистики обнулены · память ИИ сохранена" });
    persist(); emit();
  }

  function toggleAuto() { state.autoTrade = !state.autoTrade; persist(); emit(); }

  // ---------- режимы: демо / реальный рынок ----------
  function setMode(mode) {
    if (mode === "live" && !(window.Live && Live.isConnected())) return { ok: false, error: "Сначала подключите кошелёк или ключи биржи" };
    if (state.mode === mode) return { ok: true };
    state.mode = mode;
    pushEvent({ tone: "neutral", title: mode === "live" ? "Включён реальный рынок" : "Включена демо-торговля", detail: mode === "live" ? "Ордера идут на биржу от вашего имени · средства на бирже" : "Виртуальные ХРЮ · реальные цены" });
    persist(); emit();
    return { ok: true };
  }

  function recordLiveOrder(order, note) {
    state.liveOrders = [{ ...order, note: note || "", ts: Date.now() }, ...state.liveOrders].slice(0, 50);
    pushEvent({ tone: order.side === "лонг" ? "bull" : "bear", title: `Реальный ордер отправлен: ${order.sym} ${order.side === "лонг" ? "BUY" : "SELL"}`, detail: `${Fmt.fmtNum(Math.round(order.amountUSDT))} USDT · ${order.exchange}` });
    persist(); emit();
  }

  // ---------- ИИ-автопилот (спот-only) ----------
  // Тапович: спот без фьючерсов; ИИ заходит в любые монеты с потенциалом, мощная защита
  // от скама, флипает когда сам посчитает нужным, ультра-быстрые выходы.
  // Авто-стоп сессии: +лимит% профита или −лимит% просадки → автопилот закрывает ВСЕ ИИ-сделки
  // и выключается, ждёт возобновления. Лимит настраивается (по умолчанию 50%).
  const AI_MAX_POS = 5;      // максимум одновременных ИИ-позиций
  function aiLimitPct() {    // текущий лимит сессии, % (кламп 5..500)
    const v = Number(state.aiThreshold);
    return Number.isFinite(v) ? Math.max(5, Math.min(500, v)) : 50;
  }
  function setAiThreshold(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 5 || n > 500) return { ok: false, error: "Лимит сессии — от 5% до 500%" };
    state.aiThreshold = n;
    pushEvent({ tone: "neutral", title: `Лимит сессии ИИ изменён: ±${n}%`, detail: "Автопилот закроет все ИИ-сделки и выключится при +" + n + "% профита или −" + n + "% просадки от базы сессии" });
    persist(); emit();
    return { ok: true };
  }
  function scamFilter(sym) {
    const p = state.prices[sym];
    if (!p || !p.price) return { ok: false, why: "нет цены" };
    if (!p.ts || Date.now() - p.ts > 120000) return { ok: false, why: "цена не обновляется" };
    if (p.vol24 && p.vol24 < 3e6) return { ok: false, why: `низкий объём $${(p.vol24 / 1e6).toFixed(1)}M` };
    if (Math.abs(p.chg24h) > 35) return { ok: false, why: `аномалия 24ч ${p.chg24h > 0 ? "+" : "−"}${Math.abs(p.chg24h).toFixed(0)}%` };
    return { ok: true };
  }

  // новостная защита: сильный медвежий фон по монете или рынку — вход запрещён
  function newsGuard(sym) {
    if (!state.news.items || !state.news.items.length) return { ok: true, why: "" };
    const ns = Engine.newsSentiment(state.news.items, sym);
    if (ns.coinItems && ns.coin <= -0.55) return { ok: false, why: `новостной риск: медвежий фон по ${sym}` };
    if (ns.fresh && ns.global <= -0.7) return { ok: false, why: "новостной риск: медвежий фон всего рынка" };
    return { ok: true, why: "" };
  }

  function combineGuard(sym) {
    const g = scamFilter(sym);
    if (!g.ok) return g;
    const ng = newsGuard(sym);
    if (!ng.ok) return ng;
    return { ok: true, why: "ок" };
  }

  // ------- сессия автопилота: сколько ИИ наторговал с её старта -------
  function aiSessionInfo() {
    const sess = state.aiSession;
    if (!sess) return null;
    let pnl = 0, trades = 0;
    for (const c of state.userClosed) {
      if (c.strategy === "ai" && c.closedAt >= sess.openedAt) { pnl += c.pnl; trades++; }
    }
    let open = 0;
    for (const p of state.userPositions) {
      if (p.strategy !== "ai") continue;
      open++;
      pnl += Engine.positionPnl(p, (state.prices[p.sym] && state.prices[p.sym].price) || p.entry).pnl;
    }
    const pct = sess.startEquity > 0 ? (pnl / sess.startEquity) * 100 : 0;
    return { pnl, pct, trades, open, startBase: sess.startEquity };
  }

  // закрыть ВСЕ ИИ-позиции по рынку (при авто-стопе сессии — и удачные, и неудачные)
  function closeAllAiPositions(reason) {
    const positions = state.userPositions.filter((p) => p.strategy === "ai");
    const out = [];
    for (const pos of positions) {
      const price = (state.prices[pos.sym] && state.prices[pos.sym].price) || pos.entry;
      const closed = Engine.closeTrade(pos, price, reason);
      state.userPositions = state.userPositions.filter((p) => p.id !== pos.id);
      state.userClosed = [closed, ...state.userClosed].slice(0, 300);
      state.balance += closed.size + closed.pnl; // возврат маржи + результат
      learnFromClosed(closed); // ИИ учится и на принудительных закрытиях
      out.push(closed);
    }
    return out;
  }

  // авто-стоп: результат сессии достиг ±лимита → закрыть все ИИ-сделки, выключить автопилот, ждать возобновления
  function aiSessionCheck() {
    if (!state.aiAuto || !state.aiSession) return;
    const info = aiSessionInfo();
    if (!info) return;
    const th = aiLimitPct();
    if (Math.abs(info.pct) < th) return;
    const isProfit = info.pct > 0;
    const closedList = closeAllAiPositions(isProfit ? "Авто-стоп сессии: фиксация результата" : "Авто-стоп сессии: защита капитала");
    const sumPnl = closedList.reduce((a, c) => a + c.pnl, 0);
    state.aiAuto = false;
    state.aiStop = { reason: isProfit ? "profit" : "loss", pct: info.pct, ts: Date.now(), threshold: th, closed: closedList.length };
    pushEvent({
      tone: isProfit ? "bull" : "bear",
      title: isProfit
        ? `Авто-стоп сессии ИИ: +${info.pct.toFixed(1)}% ≥ +${th}%`
        : `Авто-стоп сессии ИИ: ${info.pct.toFixed(1)}% ≤ −${th}%`,
      detail: (isProfit
        ? `ИИ наторговал ${Fmt.fmtNum(Math.round(info.pnl))} ХРЮ (≈ $${Fmt.fmtNum(Math.abs(Math.round(info.pnl)))}) профита`
        : `просадка ${Fmt.fmtNum(Math.round(Math.abs(info.pnl)))} ХРЮ (≈ $${Fmt.fmtNum(Math.abs(Math.round(info.pnl)))})`)
        + ` — автопилот закрыл все ИИ-сделки по рынку (${closedList.length} шт., итог ${sumPnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(sumPnl)))} ХРЮ) и ждёт возобновления работы`,
    });
    persist();
    emit();
  }

  // ------- обучение: память ИИ обновляется по каждой закрытой ИИ-сделке -------
  function pushLesson(brain, text) {
    brain.lessons = [{ ts: Date.now(), text }, ...brain.lessons].slice(0, 24);
  }

  function learnFromClosed(c) {
    if (!c || c.strategy !== "ai") return;
    const brain = state.aiBrain;
    const won = c.pnl >= 0;
    brain.trades++;
    if (won) brain.wins++; else brain.losses++;

    // 1) надёжность факторов: кто был прав, а кто вёл в убыток
    if (c.ai && Array.isArray(c.ai.factors) && c.ai.factors.length) {
      // итоговое направление рынка с точки зрения сделки: лонг×профит или шорт×убыток = вверх
      const sideSign = c.side === "лонг" ? 1 : -1;
      const outcomeSign = sideSign * (won ? 1 : -1);
      for (const f of c.ai.factors) {
        if (!f || !f.key || !f.dir) continue; // нейтральный вклад не оцениваем
        const agree = (f.dir > 0 ? 1 : -1) === outcomeSign;
        const cur = brain.rel[f.key] == null ? 1 : brain.rel[f.key];
        const next = Math.max(0.55, Math.min(1.5, cur + (agree ? 0.045 : -0.075) * Math.min(1, Math.abs(f.dir))));
        brain.rel[f.key] = next;
      }
      // пересчёт адаптивных весов (нормировка к 1)
      const base = Engine.AI_BASE_WEIGHTS;
      let sum = 0;
      const weights = {};
      for (const k in base) { weights[k] = base[k] * (brain.rel[k] == null ? 1 : brain.rel[k]); sum += weights[k]; }
      if (sum > 0) for (const k in weights) weights[k] = weights[k] / sum;
      brain.weights = weights;
      // уроки: заметные сдвиги весов (не чаще одного на направление по фактору)
      const labels = { trend: "Тренд", rsi: "RSI", macd: "MACD", bb: "Боллинджер", ichi: "Ишимоку", vol: "Объём", roc: "Импульс", news: "Новости" };
      for (const k in base) {
        const d = weights[k] / base[k] - 1;
        if (Math.abs(d) < 0.1) continue;
        const flag = k + (d < 0 ? "dn" : "up");
        if (brain.wFlags[flag]) continue;
        brain.wFlags[flag] = 1;
        pushLesson(brain, d < 0
          ? `ослабил «${labels[k]}» (${base[k].toFixed(2)} → ${weights[k].toFixed(2)}): фактор ошибался в похожих сделках`
          : `усилил «${labels[k]}» (${base[k].toFixed(2)} → ${weights[k].toFixed(2)}): фактор чаще других был прав`);
      }
    }

    // 2) опыт по монете: серии убытков снижают уверенность на этой монете
    const st = brain.symStats[c.sym] || { n: 0, wins: 0, streak: 0, avgPct: 0 };
    st.n++;
    if (won) { st.wins++; st.streak = st.streak < 0 ? 1 : st.streak + 1; }
    else { st.streak = st.streak > 0 ? -1 : st.streak - 1; }
    st.avgPct = (st.avgPct * (st.n - 1) + (c.pnlPct || 0)) / st.n;
    brain.symStats[c.sym] = st;
    const sFlag = c.sym + "-streak" + st.streak;
    if (st.streak <= -3 && st.n >= 4 && !brain.wFlags[sFlag]) {
      brain.wFlags[sFlag] = 1;
      pushLesson(brain, `осторожнее с ${c.sym}: ${Math.abs(st.streak)} минуса подряд — уверенность на этой монете снижена`);
    }

    // 3) калибровка порога входа: если сигналы чаще закрываются в минус — ИИ требует больше уверенности
    const winrate = brain.wins / brain.trades;
    if (brain.trades >= 6) {
      if (winrate < 0.45 && brain.confThreshold < 88) {
        brain.confThreshold++;
        pushLesson(brain, `поднял порог входа до ${brain.confThreshold}%: сигналы слишком часто закрывались в минус`);
      } else if (winrate >= 0.62 && brain.confThreshold > 70) {
        brain.confThreshold--;
        pushLesson(brain, `снизил порог входа до ${brain.confThreshold}%: качество сигналов высокое`);
      }
    }
    brain.updatedAt = Date.now();
    persist();
  }

  function resetBrain() {
    state.aiBrain = defaultBrain();
    pushEvent({ tone: "neutral", title: "Память ИИ сброшена", detail: "Веса факторов вернулись к базовым — обучение начнётся заново" });
    persist(); emit();
  }

  // сдвиг уверенности по опыту монеты: серия минусов — осторожнее, серия плюсов — чуть смелее
  function symBias(sym) {
    const st = state.aiBrain.symStats[sym];
    if (!st || st.n < 3) return 0;
    if (st.streak >= 3) return 3;
    if (st.streak <= -3) return -Math.min(10, 2 * Math.abs(st.streak));
    return 0;
  }

  function updateIdeas(sym, res, guard) {
    const rest = state.aiIdeas.filter((i) => i.sym !== sym);
    if (res.verdict !== "wait") rest.push({ sym, res, guard, ts: Date.now() });
    rest.sort((a, b) => b.res.confidence - a.res.confidence);
    state.aiIdeas = rest.slice(0, 8);
  }

  function aiOpenInternal(res, size, isAuto, guardWhy) {
    const out = placeDemo({
      sym: res.sym, side: res.verdict, size, lev: 1,
      stop: res.stop, target: res.target, strategy: "ai",
      ai: { confidence: res.confidence, note: res.note, auto: !!isAuto, factors: res.factors, score: res.score },
    });
    if (out.ok && isAuto) {
      pushEvent({
        tone: res.verdict === "лонг" ? "bull" : "bear",
        title: `ИИ-автопилот вошёл: ${res.sym} ${res.verdict} ${res.confidence}%`,
        detail: `${Fmt.fmtNum(size)} ХРЮ · спот · защита: ${guardWhy} · стоп/цель по ATR`,
        sym: res.sym,
      });
    }
    return out;
  }

  function aiAutoStep(sym, bars) {
    if (!state.aiAuto || !bars || bars.length < 60) return;

    // сессия автопилота: ленивое создание базы + авто-стоп при ±лимите
    if (!state.aiSession) state.aiSession = { startEquity: totalEquity(), openedAt: Date.now() };
    aiSessionCheck();
    if (!state.aiAuto) return; // сессия только что остановилась

    const brain = state.aiBrain;
    const res = Engine.aiAnalyze(sym, bars, brain, state.news.items);
    if (!res) return;
    const guard = combineGuard(sym);
    updateIdeas(sym, res, guard);

    const aiPos = state.userPositions.find((p) => p.sym === sym && p.strategy === "ai");
    const aiCount = state.userPositions.filter((p) => p.strategy === "ai").length;
    const thr = brain.confThreshold || 76;
    const effConf = res.confidence + symBias(sym); // уверенность с поправкой на опыт монеты

    // флип: ИИ сам считает нужным развернуться (спот: продажа/выход в кэш)
    if (aiPos && res.verdict !== "wait" && res.verdict !== aiPos.side && effConf >= Math.max(66, thr - 8)) {
      const price = (state.prices[sym] && state.prices[sym].price) || aiPos.entry;
      const closed = Engine.closeTrade(aiPos, price, "ИИ-флип");
      state.userPositions = state.userPositions.filter((p) => p.id !== aiPos.id);
      state.userClosed = [closed, ...state.userClosed].slice(0, 300);
      state.balance += closed.size + closed.pnl;
      learnFromClosed(closed);
      pushEvent({
        tone: res.verdict === "лонг" ? "bull" : "bear",
        title: `ИИ флипнул ${sym}: ${aiPos.side} → ${res.verdict}`, detail: `закрыто по ${closed.pnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(closed.pnl)))} ХРЮ · разворот факторов`, sym,
      });
      const size = Math.min(1500, Math.max(200, Math.round(state.balance * 0.1)));
      if (guard.ok && state.balance >= 300 && size >= 200) aiOpenInternal(res, size, true, guard.ok ? "ок" : guard.why);
      persist();
      return;
    }

    // вход: уверенность ≥ обученного порога + защита прошла + лимит позиций + свободные ХРЮ
    if (!aiPos && res.verdict !== "wait" && effConf >= thr && aiCount < AI_MAX_POS) {
      if (!guard.ok) return;
      const size = Math.min(1500, Math.max(200, Math.round(state.balance * 0.1)));
      if (state.balance < 300 || size < 200) return;
      aiOpenInternal(res, size, true, "скам-фильтр и новости ок");
      persist();
    }
  }

  function toggleAiAuto() {
    state.aiAuto = !state.aiAuto;
    if (state.aiAuto) {
      // возобновление работы: новая сессия с чистой базой и текущим лимитом
      state.aiSession = { startEquity: totalEquity(), openedAt: Date.now() };
      state.aiStop = null;
      pushEvent({ tone: "neutral", title: "ИИ-автопилот включён: новая сессия", detail: `авто-стоп при +${aiLimitPct()}% профита или −${aiLimitPct()}% просадки (≈ $${Fmt.fmtNum(Math.round(state.aiSession.startEquity * aiLimitPct() / 100))} к базе) · база ${Fmt.fmtNum(Math.round(state.aiSession.startEquity))} ХРЮ` });
    } else {
      pushEvent({ tone: "neutral", title: "ИИ-автопилот выключен", detail: "ИИ только сканирует и подсказывает" });
    }
    persist(); emit();
  }

  function totalEquity() {
    let v = state.balance;
    for (const p of state.userPositions) {
      const price = (state.prices[p.sym] && state.prices[p.sym].price) || p.entry;
      v += p.size + Engine.positionPnl(p, price).pnl;
    }
    return v;
  }

  function loadWhales(sym) {
    const inst = BY_SYM[sym];
    if (!inst) return;
    if (state.whaleScannedAt[sym] && Date.now() - state.whaleScannedAt[sym] < 20000) return;
    Binance.fetchAggTrades(inst.pair, 500)
      .then((trades) => {
        const whales = trades
          .map((t) => ({ id: t.id, sym, price: t.price, qty: t.qty, notional: t.price * t.qty, time: t.time, side: t.isBuyerMaker ? "sell" : "buy" }))
          .filter((t) => t.notional >= 15000)
          .slice(0, 40);
        state.whales = { ...state.whales, [sym]: whales };
        state.whaleScannedAt = { ...state.whaleScannedAt, [sym]: Date.now() };
        for (const w of whales.slice(0, 4)) {
          if (w.notional >= 150000) {
            pushEvent({
              tone: w.side === "buy" ? "bull" : "bear",
              title: `Кит ${w.side === "buy" ? "купил" : "продал"} ${sym} на $${Math.round(w.notional / 1000)}K`,
              detail: `по реальной рыночной цене $${w.price.toPrecision(6)} · лента aggTrades Binance`,
              sym,
            });
          }
        }
        emit();
      })
      .catch(() => {
        // нет API — синтетическая лента китов
        if (state.whales[sym] && state.whales[sym].length) return;
        const price = (state.prices[sym] && state.prices[sym].price) || DEFAULT_PRICES[sym] || 1;
        const rand = Candles.rng(sym.length * 977 + Math.floor(Date.now() / 60000));
        const whales = [];
        for (let i = 0; i < 14; i++) {
          const notional = 15000 + Math.pow(rand(), 2.6) * 320000;
          const px = price * (1 + (rand() - 0.5) * 0.01);
          whales.push({
            id: 1000000 + i, sym, price: px,
            qty: notional / px, notional, time: Date.now() - Math.floor(rand() * 3_600_000),
            side: rand() > 0.48 ? "buy" : "sell",
          });
        }
        whales.sort((a, b) => b.time - a.time);
        state.whales = { ...state.whales, [sym]: whales };
        state.whaleScannedAt = { ...state.whaleScannedAt, [sym]: Date.now() };
        emit();
      });
  }

  // ---------- шаг движка по одному инструменту ----------
  let lastSignalKey = "";
  function engineStep(sym, bars) {
    if (!bars || !bars.length) return;
    const price = (state.prices[sym] && state.prices[sym].price) || bars[bars.length - 1].c;

    // 0) ИИ-автопилот: сканер всех монет, входы, флипы (спот-only, со скам-фильтром)
    try { aiAutoStep(sym, bars); } catch (e) { console.error(e); }

    // 1) сигналы стратегий
    for (const strat of Engine.STRATEGIES) {
      const sig = Engine.evalStrategy(strat.id, sym, bars);
      if (!sig) continue;
      const key = `${sig.strategy}-${sym}`;
      if (key === lastSignalKey) continue;
      if (state.labPositions.some((p) => p.sym === sym && p.strategy === strat.id)) continue;
      lastSignalKey = key;
      state.signals = [sig, ...state.signals.filter((x) => !(x.sym === sym && x.strategy === strat.id))].slice(0, 40);
      pushEvent({ tone: "bull", title: `${strat.name}: сигнал по ${sym} · ${sig.confidence}%`, detail: sig.note, sym });

      // 2) автоторговля лаборатории
      if (!state.autoTrade) continue;
      const acc = state.labAccounts.find((a) => a.strategy === strat.id);
      if (!acc || acc.balance < 500) continue;
      const size = Math.max(200, Math.min(1000, acc.balance * 0.1));
      const pos = {
        id: `l${Date.now()}-${strat.id}`, owner: "lab", strategy: strat.id, account: acc.id,
        sym, side: "лонг", size, lev: 1, entry: price,
        stop: sig.stop, target: sig.target, openedAt: Date.now(),
        ladder: sig.entry - sig.atr * 0.5,
      };
      state.labPositions = [pos, ...state.labPositions];
      state.labAccounts = state.labAccounts.map((a) => (a.id === acc.id ? { ...a, balance: a.balance - size } : a));
    }

    // 3) проверка выходов
    const exits = [];
    for (const p of state.labPositions) {
      if (p.sym !== sym) continue;
      const ex = Engine.evalExit(p, bars, price);
      if (ex) exits.push({ pos: p, closed: Engine.closeTrade(p, ex.price, ex.reason) });
    }
    for (const p of state.userPositions) {
      if (p.sym !== sym) continue;
      const ex = Engine.evalExit(p, bars, price);
      if (ex) exits.push({ pos: p, closed: Engine.closeTrade(p, ex.price, ex.reason) });
    }
    if (exits.length) {
      const labIds = new Set(exits.filter((e) => e.pos.owner === "lab").map((e) => e.pos.id));
      const userIds = new Set(exits.filter((e) => e.pos.owner === "user").map((e) => e.pos.id));
      const labClosedAdd = exits.filter((e) => e.pos.owner === "lab").map((e) => e.closed);
      const userClosedAdd = exits.filter((e) => e.pos.owner === "user").map((e) => e.closed);
      state.labPositions = state.labPositions.filter((p) => !labIds.has(p.id));
      state.labClosed = [...labClosedAdd, ...state.labClosed].slice(0, 300);
      state.userPositions = state.userPositions.filter((p) => !userIds.has(p.id));
      state.userClosed = [...userClosedAdd, ...state.userClosed].slice(0, 300);
      state.balance += userClosedAdd.reduce((sum, c) => sum + c.size + c.pnl, 0);
      for (const c of userClosedAdd) learnFromClosed(c); // ИИ учится на авто-выходах (стоп/цель/флип)
      if (labClosedAdd.length) {
        state.labAccounts = state.labAccounts.map((a) => {
          const adds = labClosedAdd.filter((c) => c.account === a.id);
          if (!adds.length) return a;
          const bal = a.balance + adds.reduce((sum, c) => sum + c.size + c.pnl, 0);
          return { ...a, balance: bal, equityHist: [...a.equityHist.slice(-40), bal], days: a.days + 1 / 5760 };
        });
      }
      for (const e of exits) {
        pushEvent({
          tone: e.closed.pnl >= 0 ? "bull" : "bear",
          title: `${e.pos.owner === "lab" ? "Лаборатория" : "Демо"}: ${e.pos.sym} закрыта ${e.closed.exitReason.toLowerCase()} · ${e.closed.pnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(e.closed.pnl)))} ХРЮ`,
          detail: `стратегия: ${(Engine.STRATEGIES.find((x) => x.id === e.pos.strategy) || { name: "вручную" }).name}`,
          sym: e.pos.sym,
        });
      }
      persist();
    }
    emit();
  }

  // ---------- симуляция при недоступности Binance ----------
  let simTimer = null;
  function simTick() {
    const rand = Math.random;
    const now = Date.now();
    for (const sym of WATCH_SYMS) {
      const p = state.prices[sym];
      const chg = (rand() - 0.5) * 0.0018;
      const np = p.price * (1 + chg);
      p.prev = p.price;
      p.price = np;
      p.chg24h = p.chg24h * 0.999 + (np / p.open24 - 1) * 100 * 0.001;
      p.high24 = Math.max(p.high24, np);
      p.low24 = Math.min(p.low24, np);
      p.vol24 += Math.abs(chg) * np * 50000;
      p.spark = [...p.spark.slice(1), np];
      p.ts = now;
    }
    // двигаем последнюю свечу 15м каждого инструмента
    for (const sym of WATCH_SYMS) {
      const key = `${sym}:15м`;
      const bars = state.bars[key];
      const np = state.prices[sym].price;
      if (bars && bars.length) {
        const last = bars[bars.length - 1];
        last.c = np;
        last.h = Math.max(last.h, np);
        last.l = Math.min(last.l, np);
        last.v += Math.random() * 900;
      } else {
        const p0 = np;
        state.bars[key] = Candles.genCandles({ seed: sym.length * 31 + sym.charCodeAt(0), n: 110, start: p0 * 0.985, end: p0, stepMin: 15, volBase: 0.008 });
      }
    }
    // каждые ~25 тиков (~40с) прогоняем движок по одному инструменту
    simCount++;
    if (simCount % 25 === 0) {
      const sym = WATCH_SYMS[simCount / 25 % WATCH_SYMS | 0];
      engineStep(sym, state.bars[`${sym}:15м`]);
    }
    emit();
  }
  let simCount = 0;

  // ---------- новости: бесплатная реальная лента (rss2json, без ключей) ----------
  function stripHtml(s) {
    return String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }
  function pollNews() {
    const feeds = [
      "https://api.rss2json.com/v1/api.json?rss_url=https%3A%2F%2Fcointelegraph.com%2Frss",
      "https://api.rss2json.com/v1/api.json?rss_url=https%3A%2F%2Fwww.coindesk.com%2Farc%2Foutboundfeeds%2Frss%2F",
    ];
    const tryFetch = (i) => {
      if (i >= feeds.length) return; // обе ленты недоступны — ИИ работает по индикаторам
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      fetch(feeds[i], { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((j) => {
          clearTimeout(timer);
          if (!j || j.status !== "ok" || !Array.isArray(j.items)) return Promise.reject(new Error("bad feed"));
          const items = j.items.slice(0, 30).map((it) => ({
            title: stripHtml(it.title),
            body: stripHtml(it.description || it.content).slice(0, 420),
            ts: Date.parse(it.pubDate) || Date.now(),
            link: it.link || "",
            source: (j.feed && j.feed.title) || "",
          })).filter((it) => it.title);
          if (!items.length) return Promise.reject(new Error("empty"));
          state.news = { items, ts: Date.now(), source: i === 0 ? "cointelegraph" : "coindesk" };
          emit();
        })
        .catch(() => { clearTimeout(timer); tryFetch(i + 1); });
    };
    tryFetch(0);
  }

  // ---------- старт платформы ----------
  function start() {
    if (state.started) return;
    state.started = true;
    hydrate();
    emit();

    // 1) тикеры каждые 4с
    const pollTickers = async () => {
      try {
        const raw = await Binance.fetchTickers(WATCHLIST.map((i) => i.pair));
        const now = Date.now();
        for (const t of raw) {
          const sym = t.symbol.replace(/USDT$/, "");
          const cur = state.prices[sym];
          if (!cur) continue;
          const price = Number(t.lastPrice);
          if (!Number.isFinite(price) || price <= 0) continue;
          state.prices[sym] = {
            sym, price, prev: cur.price,
            chg24h: Number(t.priceChangePercent),
            high24: Number(t.highPrice), low24: Number(t.lowPrice),
            vol24: Number(t.quoteVolume), open24: Number(t.openPrice),
            spark: [...cur.spark.slice(1), price],
            ts: now,
          };
        }
        state.degraded = false;
        state.lastSync = now;
        state.source = Binance.sourceName();
        if (simTimer) { clearInterval(simTimer); simTimer = null; }
        emit();
      } catch (e) {
        state.degraded = true;
        if (!simTimer) simTimer = setInterval(simTick, 1600);
        emit();
      }
      // монеты, которых нет на текущем источнике (или цена протухла), докачиваем отдельно
      fillMissingTickers();
    };

    let fillBusy = false;
    function fillMissingTickers() {
      if (fillBusy) return;
      const missing = WATCH_SYMS.filter((sym) => !isPriceFresh(sym) && BY_SYM[sym]);
      if (!missing.length) return;
      fillBusy = true;
      const jobs = missing.map((sym) =>
        Binance.fetchTickerOne(BY_SYM[sym].pair)
          .then((t) => {
            if (!t || !(Number(t.lastPrice) > 0)) return;
            const cur = state.prices[sym];
            const price = Number(t.lastPrice);
            state.prices[sym] = {
              sym, price, prev: cur.price,
              chg24h: Number(t.priceChangePercent) || 0,
              high24: Number(t.highPrice) || price, low24: Number(t.lowPrice) || price,
              vol24: Number(t.quoteVolume) || 0, open24: Number(t.openPrice) || price,
              spark: [...cur.spark.slice(1), price],
              ts: Date.now(),
            };
          })
          .catch(() => { /* этой монеты нет у всех источников — повторим в следующий тик */ })
      );
      Promise.all(jobs).then(() => { fillBusy = false; emit(); });
    }

    pollTickers();
    setInterval(pollTickers, 4000);

    // 2) сбор свечей для движка: по одному инструменту каждые 1.8с
    let idx = 0;
    const pollBars = () => {
      const sym = WATCH_SYMS[idx % WATCH_SYMS.length];
      idx++;
      const inst = BY_SYM[sym];
      Binance.fetchKlines(inst.pair, ENGINE_TF, 120)
        .then((rows) => {
          const bars = klineToBars(rows);
          state.bars[`${sym}:15м`] = bars;
          engineStep(sym, bars);
        })
        .catch(() => {
          // деградация: сим-свечи + шаг движка
          const p = (state.prices[sym] && state.prices[sym].price) || DEFAULT_PRICES[sym] || 1;
          if (!state.bars[`${sym}:15м`]) {
            state.bars[`${sym}:15м`] = Candles.genCandles({ seed: sym.length * 31 + sym.charCodeAt(0), n: 110, start: p * 0.985, end: p, stepMin: 15, volBase: 0.008 });
          }
          state.degraded = true;
          if (!simTimer) simTimer = setInterval(simTick, 1600);
          engineStep(sym, state.bars[`${sym}:15м`]);
        });
    };
    pollBars();
    setInterval(pollBars, 1800);

    // 3) киты BTC для ленты событий + портфельная история
    loadWhales("BTC");
    setInterval(() => loadWhales("BTC"), 60000);

    // 4) новостная лента: реальная крипто-новости (бесплатный rss2json → Cointelegraph)
    //    ИИ строит из неё 8-й фактор и новостную защиту от рисков
    pollNews();
    setInterval(pollNews, 300000);

    setInterval(() => {
      state.equityHist = [...state.equityHist, { ts: Date.now(), v: totalEquity() }].slice(-300);
      persist();
      emit();
    }, 30000);
  }

  return {
    state, subscribe, emit, start, getBars, ensureBars,
    placeDemo, closeDemo, setBalance, resetDemo, toggleAuto,
    loadWhales, setActiveSym, totalEquity, switchUser, canTrade,
    setMode, toggleAiAuto, recordLiveOrder, aiSessionInfo, resetBrain,
    setAiThreshold, closeAllAiPositions,
  };
})();

window.Store = Store;
