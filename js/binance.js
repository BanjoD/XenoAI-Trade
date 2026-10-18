// XenoAI Trade — клиент публичного API Binance (без ключей, CORS разрешён).
// Три хоста с автопереключением; при полном отказе платформа деградирует в симуляцию.
"use strict";

const Binance = (() => {
  const HOSTS = ["https://data-api.binance.vision", "https://api.binance.com", "https://api1.binance.com"];
  let hostIdx = 0;
  let lastHostFail = 0;

  async function api(path, timeoutMs) {
    timeoutMs = timeoutMs || 7000;
    let lastErr = null;
    for (let attempt = 0; attempt < HOSTS.length; attempt++) {
      const host = HOSTS[(hostIdx + attempt) % HOSTS.length];
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetch(host + path, { signal: ctl.signal, cache: "no-store" });
        clearTimeout(t);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const json = await res.json();
        hostIdx = (hostIdx + attempt) % HOSTS.length;
        return json;
      } catch (e) {
        clearTimeout(t);
        lastErr = e;
        lastHostFail = Date.now();
      }
    }
    throw lastErr || new Error("Binance недоступен");
  }

  async function fetchTickers(pairs) {
    const q = encodeURIComponent(JSON.stringify(pairs));
    return api(`/api/v3/ticker/24hr?symbols=${q}`);
  }

  async function fetchKlines(pair, interval, limit) {
    limit = limit || 120;
    const rows = await api(`/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`);
    return rows.map((r) => ({
      openTime: Number(r[0]),
      o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]),
      closeTime: Number(r[6]),
    }));
  }

  async function fetchAggTrades(pair, limit) {
    limit = limit || 500;
    const rows = await api(`/api/v3/aggTrades?symbol=${pair}&limit=${limit}`);
    return rows.map((r) => ({ id: r.a, price: Number(r.p), qty: Number(r.q), time: r.T, isBuyerMaker: r.m }));
  }

  function binanceOk() {
    return Date.now() - lastHostFail > 30000;
  }

  return { fetchTickers, fetchKlines, fetchAggTrades, binanceOk };
})();

window.Binance = Binance;
