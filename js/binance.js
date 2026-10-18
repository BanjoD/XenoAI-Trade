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
  async function api(pathBuilders, timeoutMs) {
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
          sticky = pIdx;
          markSource(provider.id);
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

  return { fetchTickers, fetchKlines, fetchAggTrades, binanceOk, sourceName, onSourceChange };
})();

window.Binance = Binance;
