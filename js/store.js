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
    lastSync: 0,
    signals: [],
    labAccounts: Engine.mkLabAccounts(),
    labPositions: [],
    labClosed: [],
    autoTrade: true,
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
  };

  WATCH_SYMS.forEach((sym, i) => {
    const p = DEFAULT_PRICES[sym] != null ? DEFAULT_PRICES[sym] : 1;
    state.prices[sym] = { sym, price: p, prev: p, chg24h: 0, high24: p * 1.01, low24: p * 0.99, vol24: 0, open24: p, spark: seedSpark(p, i) };
  });

  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function emit() { listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } }); }

  // ---------- персистентность ----------
  let persistTimer = null;
  function dataKey() {
    const login = Auth.sessionLogin();
    return login ? `xenoai_v2_${login.toLowerCase()}` : "xenoai_v2_anon";
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
        };
        localStorage.setItem(dataKey(), JSON.stringify(data));
      } catch (e) { /* noop */ }
    }, 400);
  }
  function hydrate() {
    try {
      const raw = localStorage.getItem(dataKey());
      if (!raw) return;
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
    } catch (e) { /* noop */ }
  }
  function switchUser() {
    const started = state.started;
    state.prices = {};
    WATCH_SYMS.forEach((sym, i) => {
      const p = DEFAULT_PRICES[sym] != null ? DEFAULT_PRICES[sym] : 1;
      state.prices[sym] = { sym, price: p, prev: p, chg24h: 0, high24: p * 1.01, low24: p * 0.99, vol24: 0, open24: p, spark: seedSpark(p, i) };
    });
    state.bars = {}; state.degraded = false; state.lastSync = 0;
    state.signals = []; state.labAccounts = Engine.mkLabAccounts();
    state.labPositions = []; state.labClosed = []; state.autoTrade = true;
    state.events = []; state.whales = {}; state.whaleScannedAt = {};
    state.balance = 10000; state.startBalance = 10000;
    state.userPositions = []; state.userClosed = []; state.equityHist = [];
    state.started = started; state.activeSym = "BTC";
    hydrate();
  }

  function pushEvent(e) {
    state.events = [{ ...e, id: `e${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, ts: Date.now() }, ...state.events].slice(0, 60);
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
    const price = state.prices[p.sym] && state.prices[p.sym].price;
    if (!price || p.size <= 0) return;
    const margin = Math.min(p.size, state.balance);
    if (margin <= 0) return;
    const risk = price * 0.02; // стоп −2%
    const pos = {
      id: `u${Date.now()}`, owner: "user", strategy: "manual", sym: p.sym, side: p.side,
      size: margin, lev: p.lev, entry: price,
      stop: p.side === "лонг" ? price - risk : price + risk,
      target: p.side === "лонг" ? price + risk * 2 : price - risk * 2,
      openedAt: Date.now(),
    };
    state.balance -= margin;
    state.userPositions = [pos, ...state.userPositions];
    pushEvent({
      tone: p.side === "лонг" ? "bull" : "bear",
      title: `Демо-сделка открыта: ${p.sym} ${p.side} ×${p.lev}`,
      detail: `${Fmt.fmtNum(margin)} ХРЮ по реальной цене ${price.toPrecision(6)}`,
      sym: p.sym,
    });
    persist();
    emit();
  }

  function closeDemo(id) {
    const pos = state.userPositions.find((p) => p.id === id);
    if (!pos) return;
    const price = (state.prices[pos.sym] && state.prices[pos.sym].price) || pos.entry;
    const closed = Engine.closeTrade(pos, price, "Вручную");
    state.userPositions = state.userPositions.filter((p) => p.id !== id);
    state.userClosed = [closed, ...state.userClosed].slice(0, 300);
    state.balance += pos.size + closed.pnl;
    pushEvent({
      tone: closed.pnl >= 0 ? "bull" : "bear",
      title: `Демо-сделка закрыта: ${pos.sym} ${closed.pnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(closed.pnl)))} ХРЮ`,
      detail: closed.exitReason,
      sym: pos.sym,
    });
    persist();
    emit();
  }

  function setBalance(v) {
    state.balance = v; state.startBalance = v;
    pushEvent({ tone: "neutral", title: `Баланс демо-счёта установлен: ${Fmt.fmtNum(v)} ХРЮ`, detail: "Кабинет пользователя" });
    persist(); emit();
  }

  function resetDemo() {
    state.balance = state.startBalance;
    state.userPositions = []; state.userClosed = [];
    state.labAccounts = Engine.mkLabAccounts();
    state.labPositions = []; state.labClosed = []; state.equityHist = [];
    pushEvent({ tone: "neutral", title: "Демо-счёт сброшен", detail: "Позиции и история очищены" });
    persist(); emit();
  }

  function toggleAuto() { state.autoTrade = !state.autoTrade; persist(); emit(); }

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
          state.prices[sym] = {
            sym, price, prev: cur.price,
            chg24h: Number(t.priceChangePercent),
            high24: Number(t.highPrice), low24: Number(t.lowPrice),
            vol24: Number(t.quoteVolume), open24: Number(t.openPrice),
            spark: [...cur.spark.slice(1), price],
          };
        }
        state.degraded = false;
        state.lastSync = now;
        if (simTimer) { clearInterval(simTimer); simTimer = null; }
        emit();
      } catch (e) {
        state.degraded = true;
        if (!simTimer) simTimer = setInterval(simTick, 1600);
        emit();
      }
    };
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

    setInterval(() => {
      state.equityHist = [...state.equityHist, { ts: Date.now(), v: totalEquity() }].slice(-300);
      persist();
      emit();
    }, 30000);
  }

  return {
    state, subscribe, emit, start, getBars, ensureBars,
    placeDemo, closeDemo, setBalance, resetDemo, toggleAuto,
    loadWhales, setActiveSym, totalEquity, switchUser,
  };
})();

window.Store = Store;
