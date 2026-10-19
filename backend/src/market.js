// XenoAI Trade — СЕРВЕР: рыночные данные (порт js/binance.js без браузерных частей).
// Тот же каскад: Binance (4 хоста) → MEXC → Bybit → OKX → Gate → KuCoin → Bitget,
// крайние резервы CryptoCompare/CoinGecko. Все нормализаторы один-в-один с браузером.
"use strict";

const PROVIDERS = [
  { id: "binance", hosts: ["https://data-api.binance.vision", "https://api.binance.com", "https://api1.binance.com", "https://api2.binance.com"] },
  { id: "mexc", hosts: ["https://api.mexc.com"] },
  { id: "bybit", hosts: ["https://api.bybit.com", "https://api.bytick.com"] },
  { id: "okx", hosts: ["https://www.okx.com", "https://aws.okx.com"] },
  { id: "gate", hosts: ["https://api.gateio.ws"] },
  { id: "kucoin", hosts: ["https://api.kucoin.com"] },
  { id: "bitget", hosts: ["https://api.bitget.com"] },
];

let sticky = 0;

async function fetchJson(host, path, timeoutMs) {
  const res = await fetch(host + path, { signal: AbortSignal.timeout(timeoutMs || 6500), cf: { cacheTtl: 0 } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

// каскад по провайдерам, начиная с «липкого»; на каждом — перебор хостов
async function api(pathBuilders, timeoutMs, opts) {
  let lastErr = null;
  for (let attempt = 0; attempt < PROVIDERS.length; attempt++) {
    const pIdx = (sticky + attempt) % PROVIDERS.length;
    const provider = PROVIDERS[pIdx];
    const build = pathBuilders[provider.id];
    if (!build) continue;
    for (const host of provider.hosts) {
      try {
        const json = await fetchJson(host, build(host), timeoutMs);
        if (provider.id === "bybit" && json.retCode !== 0) throw new Error("bybit " + json.retCode);
        if (provider.id === "okx" && json.code !== "0") throw new Error("okx " + json.code);
        if (!(opts && opts.silent)) sticky = pIdx;
        return { data: json, provider: provider.id };
      } catch (e) { lastErr = e; }
    }
  }
  throw lastErr || new Error("нет доступных источников данных");
}

// ===== тикеры: единый формат Binance {symbol, lastPrice, priceChangePercent, ...} =====
export function normTickers(payload, provider, wanted) {
  const want = new Set(wanted || []);
  const out = [];
  const push = (t) => { if (!want.size || want.has(t.symbol)) out.push(t); };
  if (provider === "binance" || provider === "mexc") {
    for (const t of payload) push({
      symbol: t.symbol, lastPrice: Number(t.lastPrice), priceChangePercent: Number(t.priceChangePercent),
      highPrice: Number(t.highPrice), lowPrice: Number(t.lowPrice), quoteVolume: Number(t.quoteVolume), openPrice: Number(t.openPrice),
    });
  } else if (provider === "gate") {
    for (const t of (Array.isArray(payload) ? payload : [])) {
      const sym = String(t.currency_pair || "").replace("_", "");
      const last = Number(t.last), chg = Number(t.change_percentage) || 0;
      push({
        symbol: sym, lastPrice: last, priceChangePercent: chg,
        highPrice: Number(t.high_24h) || last, lowPrice: Number(t.low_24h) || last,
        quoteVolume: Number(t.quote_volume) || 0, openPrice: chg && last > 0 ? last / (1 + chg / 100) : last,
      });
    }
  } else if (provider === "kucoin") {
    for (const t of ((payload.data && payload.data.ticker) || [])) {
      const sym = String(t.symbol || "").replace("-", "");
      const last = Number(t.last), open = Number(t.open);
      push({
        symbol: sym, lastPrice: last,
        priceChangePercent: open > 0 ? (last / open - 1) * 100 : (Number(t.changeRate) || 0) * 100,
        highPrice: Number(t.high) || last, lowPrice: Number(t.low) || last,
        quoteVolume: Number(t.volValue) || 0, openPrice: open || last,
      });
    }
  } else if (provider === "bitget") {
    for (const t of ((payload.data) || [])) {
      const last = Number(t.lastPr), open = Number(t.open) || Number(t.openUtc) || last;
      push({
        symbol: t.symbol, lastPrice: last,
        priceChangePercent: open > 0 ? (last / open - 1) * 100 : (Number(t.change24h) || 0) * 100,
        highPrice: Number(t.high24h) || last, lowPrice: Number(t.low24h) || last,
        quoteVolume: Number(t.quoteVolume) || Number(t.usdtVolume) || 0, openPrice: open,
      });
    }
  } else if (provider === "bybit") {
    for (const t of ((payload.result && payload.result.list) || [])) push({
      symbol: t.symbol, lastPrice: Number(t.lastPrice), priceChangePercent: Number(t.price24hPcnt) * 100,
      highPrice: Number(t.highPrice24h), lowPrice: Number(t.lowPrice24h),
      quoteVolume: Number(t.turnover24h), openPrice: Number(t.prevPrice24h),
    });
  } else if (provider === "okx") {
    for (const t of (payload.data || [])) {
      const sym = String(t.instId || "").replace("-", "");
      const last = Number(t.last), open = Number(t.open24h);
      push({
        symbol: sym, lastPrice: last, priceChangePercent: open > 0 ? (last / open - 1) * 100 : 0,
        highPrice: Number(t.high24h), lowPrice: Number(t.low24h),
        quoteVolume: Number(t.volCcy24h), openPrice: open,
      });
    }
  }
  return out;
}

export async function fetchTickers(pairs) {
  const { data, provider } = await api({
    binance: () => `/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(pairs))}`,
    mexc: () => `/api/v3/ticker/24hr`,
    bybit: () => `/v5/market/tickers?category=spot`,
    okx: () => `/api/v5/market/tickers?instType=SPOT`,
    gate: () => `/api/v4/spot/tickers`,
    kucoin: () => `/api/v1/market/allTickers`,
    bitget: () => `/api/v2/spot/market/tickers`,
  });
  return { rows: normTickers(data, provider, pairs), provider };
}

const GECKO_IDS = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", XRP: "ripple", BNB: "binancecoin",
  NEAR: "near", SUI: "sui", ARB: "arbitrum", TAO: "bittensor", LINK: "chainlink",
  UNI: "uniswap", ZEC: "zcash", ONDO: "ondo-finance", ENA: "ethena", PHA: "phala-network",
  JUP: "jupiter-exchange-solana", FET: "artificial-superintelligence-alliance",
  ZRO: "layerzero", LTC: "litecoin", QNT: "quant-network", GRASS: "grass",
  EIGEN: "eigenlayer", KAITO: "kaito", MNT: "mantle", TON: "the-open-network",
};

// одиночная монета с агрегаторов (крайний резерв, когда молчат все биржи)
export async function fetchTickerAggregator(sym) {
  try {
    const j = await fetchJson("https://min-api.cryptocompare.com", `/data/pricemultifull?fsyms=${sym}&tsyms=USDT`, 6000);
    const row = j && j.RAW && j.RAW[sym] && j.RAW[sym].USDT;
    if (row && Number(row.PRICE) > 0) {
      return {
        symbol: sym + "USDT", lastPrice: Number(row.PRICE), priceChangePercent: Number(row.CHANGEPCT24HOUR) || 0,
        highPrice: Number(row.HIGH24HOUR) || Number(row.PRICE), lowPrice: Number(row.LOW24HOUR) || Number(row.PRICE),
        quoteVolume: Number(row.TOTALVOLUME24HTO) || 0, openPrice: Number(row.OPEN24HOUR) || Number(row.PRICE),
      };
    }
  } catch (e) { /* next */ }
  const id = GECKO_IDS[sym];
  if (!id) return null;
  try {
    const j = await fetchJson("https://api.coingecko.com", `/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true`, 7000);
    const r = j && j[id];
    if (!r || !(Number(r.usd) > 0)) return null;
    const price = Number(r.usd), chg = Number(r.usd_24h_change) || 0;
    return {
      symbol: sym + "USDT", lastPrice: price, priceChangePercent: chg,
      highPrice: price, lowPrice: price, quoteVolume: 0,
      openPrice: chg ? price / (1 + chg / 100) : price,
    };
  } catch (e) { return null; }
}

// докачка одного тикера (монеты, которых нет на рабочем источнике)
export async function fetchTickerOne(pair) {
  try {
    const { data, provider } = await api({
      binance: () => `/api/v3/ticker/24hr?symbol=${pair}`,
      mexc: () => `/api/v3/ticker/24hr?symbol=${pair}`,
      bybit: () => `/v5/market/tickers?category=spot&symbol=${pair}`,
      okx: () => `/api/v5/market/ticker?instId=${pair.replace("USDT", "-USDT")}`,
      gate: () => `/api/v4/spot/tickers?currency_pair=${pair.replace("USDT", "_USDT")}`,
      kucoin: () => `/api/v1/market/allTickers`,
      bitget: () => `/api/v2/spot/market/tickers?symbol=${pair}`,
    }, 6000, { silent: true });
    const rows = normTickers(data, provider, [pair]);
    if (rows[0]) return rows[0];
  } catch (e) { /* агрегаторы */ }
  return fetchTickerAggregator(pair.replace(/USDT$/, ""));
}

// ===== свечи: единый формат Binance klines {openTime, o, h, l, c, v} =====
const TF = {
  binance: { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h" },
  mexc: { "15m": "15m" },
  bybit: { "15m": "15" },
  okx: { "15m": "15m" },
  gate: { "15m": "15m" },
  kucoin: { "15m": "15min" },
};

export function normKlines(payload, provider) {
  if (provider === "binance" || provider === "mexc") {
    return payload.map((r) => ({ openTime: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]) }));
  }
  if (provider === "bybit") {
    const list = (payload.result && payload.result.list) || [];
    return list.slice().reverse().map((r) => ({ openTime: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]) }));
  }
  if (provider === "gate") {
    const list = Array.isArray(payload) ? payload : [];
    return list.map((r) => ({ openTime: Number(r[0]) * 1000, o: Number(r[5]), h: Number(r[3]), l: Number(r[4]), c: Number(r[2]), v: Number(r[1]) }));
  }
  if (provider === "kucoin") {
    const list = (payload.data) || [];
    return list.slice().reverse().map((r) => ({ openTime: Number(r[0]) * 1000, o: Number(r[1]), h: Number(r[3]), l: Number(r[4]), c: Number(r[2]), v: Number(r[5]) }));
  }
  const list = (payload.data) || [];
  return list.slice().reverse().map((r) => ({ openTime: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]) }));
}

export async function fetchKlines(pair, interval, limit) {
  limit = limit || 120;
  const { data, provider } = await api({
    binance: () => `/api/v3/klines?symbol=${pair}&interval=${TF.binance[interval] || "15m"}&limit=${limit}`,
    mexc: () => `/api/v3/klines?symbol=${pair}&interval=${TF.mexc[interval] || "15m"}&limit=${limit}`,
    bybit: () => `/v5/market/kline?category=spot&symbol=${pair}&interval=${TF.bybit[interval] || "15"}&limit=${Math.min(limit, 200)}`,
    okx: () => `/api/v5/market/candles?instId=${pair.replace("USDT", "-USDT")}&bar=${TF.okx[interval] || "15m"}&limit=${Math.min(limit, 300)}`,
    gate: () => `/api/v4/spot/candlesticks?currency_pair=${pair.replace("USDT", "_USDT")}&interval=${TF.gate[interval] || "15m"}&limit=${Math.min(limit, 500)}`,
    kucoin: () => `/api/v1/market/candles?type=${TF.kucoin[interval] || "15min"}&symbol=${pair.replace("USDT", "-USDT")}`,
  });
  return { bars: normKlines(data, provider), provider };
}

// лента сделок для китового фактора: {id, price, qty, time, isBuyerMaker}
export async function fetchAggTrades(pair, limit) {
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
    return list.map((r, i) => ({ id: i, price: Number(r.price), qty: Number(r.size), time: Number(r.time), isBuyerMaker: r.side === "Sell" })).reverse();
  }
  const list = (data.data) || [];
  return list.map((r) => ({ id: Number(r.tradeId), price: Number(r.px), qty: Number(r.sz), time: Number(r.ts), isBuyerMaker: r.side === "sell" }));
}
