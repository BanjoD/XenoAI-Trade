// XenoAI Trade — источники рыночных данных: Binance (включая data-api.binance.vision,
// который не блокируется по регионам) → Bybit → OKX. Все публичные, без ключей, CORS открыт.
// Порядок провайдеров «липкий»: рабочий источник запоминается и опрашивается первым.
// При отказе текущего источника следующий пробуется на этом же запросе.
"use strict";

const Binance = (() => {
  // --- хосты провайдеров ---
  const PROVIDERS = [
    {
      id: "binance",
      label: "binance",
      hosts: [
        "https://data-api.binance.vision",
        "https://api.binance.com",
        "https://api1.binance.com",
        "https://api2.binance.com",
      ],
    },
    { id: "bybit", label: "bybit", hosts: ["https://api.bybit.com", "https://api.bytick.com"] },
    { id: "okx", label: "okx", hosts: ["https://www.okx.com", "https://aws.okx.com"] },
  ];

  let sticky = 0;            // индекс провайдера, который ответил последним
  let sourceId = null;       // текущий рабочий источник ("binance"/"bybit"/"okx")
  let lastOk = 0;
  const sourceListeners = new Set();

  function sourceName() { return sourceId ? PROVIDERS[PROVIDERS.findIndex((p) => p.id === sourceId)].label : null; }
  function onSourceChange(fn) { sourceListeners.add(fn); return () => sourceListeners.delete(fn); }
  function markSource(id) {
    if (sourceId !== id) {
      sourceId = id;
      try { sourceListeners.forEach((fn) => fn(id)); } catch (e) { /* noop */ }
    }
    lastOk = Date.now();
  }

  async function fetchJson(host, path, timeoutMs) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs || 6500);
    try {
      const res = await fetch(host + path, { signal: ctl.signal, cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  // пробует провайдеров по кругу, начиная с липкого; на каждом провайдере перебирает хосты
  // opts.silent — не переключать «липкий» источник (для одиночных докачек монет)
  async function api(pathBuilders, timeoutMs, opts) {
    let lastErr = null;
    for (let attempt = 0; attempt < PROVIDERS.length; attempt++) {
      const pIdx = (sticky + attempt) % PROVIDERS.length;
      const provider = PROVIDERS[pIdx];
      for (const host of provider.hosts) {
        const path = pathBuilders[provider.id](host);
        try {
          const json = await fetchJson(host, path, timeoutMs);
          if (provider.id === "bybit" && json.retCode !== 0) throw new Error("bybit " + json.retCode);
          if (provider.id === "okx" && json.code !== "0") throw new Error("okx " + json.code);
          if (!(opts && opts.silent)) { sticky = pIdx; markSource(provider.id); }
          return { data: json, provider: provider.id };
        } catch (e) {
          lastErr = e;
        }
      }
    }
    throw lastErr || new Error("Нет доступных источников данных");
  }

  // ================= нормализация тикеров =================
  // на выходе — единый формат Binance: {symbol, lastPrice, priceChangePercent, highPrice, lowPrice, quoteVolume, openPrice}
  function normTickers(payload, provider, wanted) {
    const want = new Set(wanted || []);
    const out = [];
    if (provider === "binance") {
      for (const t of payload) {
        if (want.size && !want.has(t.symbol)) continue;
        out.push({
          symbol: t.symbol, lastPrice: Number(t.lastPrice),
          priceChangePercent: Number(t.priceChangePercent),
          highPrice: Number(t.highPrice), lowPrice: Number(t.lowPrice),
          quoteVolume: Number(t.quoteVolume), openPrice: Number(t.openPrice),
        });
      }
    } else if (provider === "bybit") {
      const list = (payload.result && payload.result.list) || [];
      for (const t of list) {
        if (want.size && !want.has(t.symbol)) continue;
        out.push({
          symbol: t.symbol, lastPrice: Number(t.lastPrice),
          priceChangePercent: Number(t.price24hPcnt) * 100,
          highPrice: Number(t.highPrice24h), lowPrice: Number(t.lowPrice24h),
          quoteVolume: Number(t.turnover24h), openPrice: Number(t.prevPrice24h),
        });
      }
    } else if (provider === "okx") {
      const list = (payload.data) || [];
      for (const t of list) {
        const sym = t.instId.replace("-", "");
        if (want.size && !want.has(sym)) continue;
        const last = Number(t.last), open = Number(t.open24h);
        out.push({
          symbol: sym, lastPrice: last,
          priceChangePercent: open > 0 ? (last / open - 1) * 100 : 0,
          highPrice: Number(t.high24h), lowPrice: Number(t.low24h),
          quoteVolume: Number(t.volCcy24h), openPrice: open,
        });
      }
    }
    return out;
  }

  async function fetchTickers(pairs) {
    const wanted = pairs;
    const { data, provider } = await api({
      binance: () => `/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(pairs))}`,
      bybit: () => `/v5/market/tickers?category=spot`,
      okx: () => `/api/v5/market/tickers?instType=SPOT`,
    });
    return normTickers(data, provider, wanted);
  }

  // одиночный тикер по паре: каскад по всем провайдерам без смены «липкого» источника.
  // нужен, когда монета недоступна на текущем источнике (у бирж разные наборы листингов:
  // ZEC нет на Bybit, GRASS/MNT нет на Binance) — докачивает её с той биржи, где она есть.
  async function fetchTickerOne(pair, timeoutMs) {
    const { data, provider } = await api({
      binance: () => `/api/v3/ticker/24hr?symbol=${pair}`,
      bybit: () => `/v5/market/tickers?category=spot&symbol=${pair}`,
      okx: () => `/api/v5/market/ticker?instId=${pair.replace("USDT", "-USDT")}`,
    }, timeoutMs || 6000, { silent: true });
    const rows = normTickers(data, provider, [pair]);
    return rows[0] || null;
  }

  // ================= свечи =================
  const TF = {
    binance: { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" },
    bybit: { "1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D" },
    okx: { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D" },
  };

  // на выходе — формат Binance klines: {openTime, o, h, l, c, v}
  function normKlines(payload, provider) {
    if (provider === "binance") {
      return payload.map((r) => ({
        openTime: Number(r[0]),
        o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]),
      }));
    }
    if (provider === "bybit") {
      const list = (payload.result && payload.result.list) || [];
      return list.slice().reverse().map((r) => ({
        openTime: Number(r[0]),
        o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]),
      }));
    }
    const list = (payload.data) || [];
    return list.slice().reverse().map((r) => ({
      openTime: Number(r[0]),
      o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]),
    }));
  }

  async function fetchKlines(pair, interval, limit) {
    limit = limit || 120;
    const { data, provider } = await api({
      binance: () => `/api/v3/klines?symbol=${pair}&interval=${TF.binance[interval] || "15m"}&limit=${limit}`,
      bybit: () => `/v5/market/kline?category=spot&symbol=${pair}&interval=${TF.bybit[interval] || "15"}&limit=${Math.min(limit, 200)}`,
      okx: () => `/api/v5/market/candles?instId=${pair.replace("USDT", "-USDT")}&bar=${TF.okx[interval] || "15m"}&limit=${Math.min(limit, 300)}`,
    });
    return normKlines(data, provider);
  }

  // ================= лента сделок (для китов) =================
  // единый формат aggTrades: {id, price, qty, time, isBuyerMaker}
  async function fetchAggTrades(pair, limit) {
    limit = limit || 500;
    const { data, provider } = await api({
      binance: () => `/api/v3/aggTrades?symbol=${pair}&limit=${limit}`,
      bybit: () => `/v5/market/recent-trade?category=spot&symbol=${pair}&limit=60`,
      okx: () => `/api/v5/market/trades?instId=${pair.replace("USDT", "-USDT")}&limit=500`,
    });
    if (provider === "binance") {
      return data.map((r) => ({ id: r.a, price: Number(r.p), qty: Number(r.q), time: r.T, isBuyerMaker: r.m }));
    }
    if (provider === "bybit") {
      const list = (data.result && data.result.list) || [];
      return list.map((r, i) => ({
        id: i, price: Number(r.price), qty: Number(r.size),
        time: Number(r.time), isBuyerMaker: r.side === "Sell",
      })).reverse();
    }
    const list = (data.data) || [];
    return list.map((r) => ({
      id: Number(r.tradeId), price: Number(r.px), qty: Number(r.sz),
      time: Number(r.ts), isBuyerMaker: r.side === "sell",
    }));
  }

  function binanceOk() { return Date.now() - lastOk < 30000 || sourceId !== null; }

  // ================= WebSocket-стрим цен: реальное время, ~1 тик в секунду =================
  // Публичные потоки Binance без ключей (@miniTicker по каждой паре). Даёт мгновенные
  // цены между REST-опросами: PnL позиций и цены обновляются каждую секунду, а не раз
  // в 4с. Хост data-stream.binance.vision (зеркало рыночных данных), резерв — stream.binance.com.
  // При обрыве — авто-реконнект с чередованием хостов; REST-опрос при этом продолжает работать.
  const WS_HOSTS = ["wss://data-stream.binance.vision/stream", "wss://stream.binance.com:9443/stream"];
  let ws = null, wsHostIdx = 0, wsPairs = [], wsListeners = new Set(), wsAlive = false, wsReconnectTimer = null;
  function onFastTick(fn) { wsListeners.add(fn); return () => wsListeners.delete(fn); }
  function wsEmit(t) { wsListeners.forEach((fn) => { try { fn(t); } catch (e) { /* noop */ } }); }
  function wsConnected() { return wsAlive; }
  function openTickerStream(pairs) {
    if (typeof WebSocket === "undefined" || !pairs || !pairs.length) return;
    if (ws && wsPairs.join() === pairs.join()) return; // уже открыт для этих пар
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    try { if (ws) { ws.onclose = null; try { ws.close(); } catch (e) {} ws = null; } } catch (e) {}
    wsPairs = pairs.slice();
    const url = WS_HOSTS[wsHostIdx % WS_HOSTS.length] + "?streams=" + wsPairs.map((p) => p.toLowerCase() + "@miniTicker").join("/");
    try { ws = new WebSocket(url); } catch (e) { ws = null; return; }
    ws.onopen = () => { wsAlive = true; };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        const d = msg && msg.data;
        if (!d || d.e !== "24hrMiniTicker" || !d.s) return;
        const c = Number(d.c), o = Number(d.o);
        if (!(c > 0)) return;
        wsEmit({
          sym: d.s.replace(/USDT$/, ""),
          price: c, open24: o,
          chg24h: o > 0 ? (c / o - 1) * 100 : 0,
          high24: Number(d.h) || c, low24: Number(d.l) || c,
          vol24: Number(d.q) || 0,
          ts: Date.now(),
        });
      } catch (e) { /* битый кадр — игнорируем */ }
    };
    ws.onclose = () => {
      wsAlive = false;
      ws = null;
      wsHostIdx++; // в следующий раз пробуем другой хост
      if (typeof setTimeout === "function" && !wsReconnectTimer) {
        wsReconnectTimer = setTimeout(() => { wsReconnectTimer = null; openTickerStream(wsPairs); }, 5000);
      }
    };
    ws.onerror = () => { try { if (ws) ws.close(); } catch (e) { /* noop */ } };
  }

  return { fetchTickers, fetchTickerOne, fetchKlines, fetchAggTrades, binanceOk, sourceName, onSourceChange, openTickerStream, onFastTick, wsConnected };
})();

window.Binance = Binance;
