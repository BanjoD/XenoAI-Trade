// XenoAI Trade — СЕРВЕР: клиент OKX (REST v5) для ПОЛНОЙ СИНХРОНИЗАЦИИ реального режима.
// R51: пользователь попросил «полную синхронизацию с OKX, всё по-настоящему»:
//   баланс аккаунта = реальные USDT биржи, принятие сигнала/автопилот = РЕАЛЬНАЯ покупка
//   на OKX-споте (USDT → токен), закрытие сделки = РЕАЛЬНАЯ продажа (токен → USDT),
//   PnL считается по фактическим ценам исполнения биржи.
// Ключи хранятся ТОЛЬКО в storage Durable Object (в архив /state не попадают —
// устройства их никогда не видят). Подпись — HMAC-SHA256/base64 через WebCrypto,
// как требует OKX: string = timestamp + method + requestPath + body.
// Всё асинхронное сосредоточено ЗДЕСЬ и в drainRealQueue (account.js): торговое ядро
// остаётся синхронным и лишь ставит задачи в персист-очередь a.realQueue.
"use strict";

const HOSTS = ["https://www.okx.com", "https://aws.okx.com"];
const DEFAULT_TIMEOUT = 9000;

// ---------- подпись ----------
function b64(bytes) {
  let s = "";
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

async function hmacB64(secret, msg) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

// ---------- время OKX (расхождение часов = ошибка 50102) ----------
let _offsetMs = 0;
let _offsetAt = 0;
export function okxOffset() { return _offsetMs; }

export async function syncTime(fetchImpl) {
  const f = fetchImpl || fetch;
  for (const host of HOSTS) {
    try {
      const r = await f(host + "/api/v5/public/time", { signal: AbortSignal.timeout(5000) });
      const j = await r.json();
      const ts = Number(j && j.data && j.data[0] && j.data[0].ts);
      if (ts > 0) { _offsetMs = ts - Date.now(); _offsetAt = Date.now(); return _offsetMs; }
    } catch (e) { /* следующий хост */ }
  }
  return 0;
}

// ---------- человекопонятные ошибки OKX (по мотивам live.js/xplain) ----------
export function okxExplain(code, msg) {
  const c = String(code == null ? "" : code);
  const m = String(msg || "");
  const map = [
    [/50111|invalid.*key|API.*invalid/i, "ключ не принят: проверьте API-ключ (не удалён, не истёк, биржа OKX)"],
    [/50112|50113|passphrase/i, "неверная парольная фраза (passphrase) — та, что задана ПРИ СОЗДАНИИ ключа на OKX"],
    [/50102|timestamp/i, "расхождение времени сервера с OKX (повторите — время синхронизируется автоматически)"],
    [/51008|insufficient|balance/i, "недостаточно USDT на балансе OKX для этой операции"],
    [/51000|51001|51003|instId|instrument|пар/i, "инструмент не найден на OKX (проверьте пару, например BTC-USDT)"],
    [/50100|permission|not.*allow|denied/i, "у ключа нет нужного права: при создании включите «Чтение» + «Торговля»"],
    [/IP|white|restricted|region/i, "OKX ограничил доступ с этого IP — добавьте сервер в белый список ключа"],
    [/51119|51098|lotSz|minSz|размер/i, "размер ордера меньше минимума или не кратен шагу лота"],
    [/51169|51175|51092|51127|risk|restriction/i, "OKX ограничил торговлю по этому инструменту/аккаунту"],
  ];
  for (const [re, txt] of map) if (re.test(m) || (c && re.test(c))) return txt + " [" + (c || "okx") + "]";
  return m || ("OKX " + c);
}

// ---------- подписанный запрос ----------
// creds = { apiKey, secret, pass }; тесты подменяют fetchImpl/nowImpl.
export async function signedRequest(creds, method, path, query, body, opts) {
  const o = opts || {};
  const f = o.fetchImpl || fetch;
  const now = o.nowImpl || Date.now;
  const methodUp = String(method).toUpperCase();
  if (!creds || !creds.apiKey || !creds.secret) throw new Error("нет ключей OKX (подключите их в модалке «Реальный рынок»)");
  const fullPath = query ? path + "?" + query : path;
  const bodyStr = body ? JSON.stringify(body) : "";
  // свежесть смещения часов: пересинхронизация не чаще раза в 30 минут
  if (!_offsetAt || Date.now() - _offsetAt > 30 * 60000) {
    try { await syncTime(f); } catch (e) { /* подписываем локальным временем */ }
  }
  let lastErr = null;
  for (let hostIdx = 0; hostIdx < HOSTS.length; hostIdx++) {
    const host = HOSTS[hostIdx];
    for (let attempt = 0; attempt < 2; attempt++) {
      const iso = new Date(now() + _offsetMs).toISOString();
      const sign = await hmacB64(creds.secret, iso + methodUp + fullPath + bodyStr);
      let res, json;
      try {
        res = await f(host + fullPath, {
          method: methodUp,
          headers: {
            "OK-ACCESS-KEY": creds.apiKey,
            "OK-ACCESS-SIGN": sign,
            "OK-ACCESS-TIMESTAMP": iso,
            "OK-ACCESS-PASSPHRASE": creds.pass || "",
            "Content-Type": "application/json",
          },
          body: methodUp === "POST" || methodUp === "PUT" ? bodyStr : undefined,
          signal: AbortSignal.timeout(o.timeoutMs || DEFAULT_TIMEOUT),
        });
        json = await res.json().catch(() => ({}));
      } catch (e) { lastErr = e; continue; } // сеть/таймаут — второй хост
      if (json && json.code === "0") return json;
      const d0 = (json && json.data && json.data[0]) || {};
      const code = d0.sCode || d0.code || (json && json.code) || String(res.status);
      const raw = d0.sMsg || d0.msg || (json && json.msg) || ("HTTP " + res.status);
      // 50102 — расхождение часов: синхронизируем и повторяем ОДИН раз
      if (String(code) === "50102" && attempt === 0) {
        await syncTime(f);
        continue;
      }
      const err = new Error(okxExplain(code, raw));
      err.code = String(code);
      throw err;
    }
  }
  throw lastErr || new Error("OKX недоступен (оба хоста)");
}

// ---------- публичные правила инструмента (lotSz/minSz для округления) ----------
const instCache = new Map(); // instId → { lotSz, minSz, tickSz, ts }
export function instRules(instId) { return instCache.get(String(instId).toUpperCase()) || null; }

export async function fetchInstrument(instId, fetchImpl) {
  const key = String(instId).toUpperCase();
  const cur = instCache.get(key);
  if (cur && Date.now() - cur.ts < 24 * 3600e3) return cur;
  const f = fetchImpl || fetch;
  let lastErr = null;
  for (const host of HOSTS) {
    try {
      const r = await f(`${host}/api/v5/public/instruments?instType=SPOT&instId=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(6000) });
      const j = await r.json();
      const d = j && j.data && j.data[0];
      if (!d) throw new Error("инструмент не найден");
      const rules = {
        lotSz: Number(d.lotSz) || 0.0001,
        minSz: Number(d.minSz) || 0,
        tickSz: Number(d.tickSz) || 0,
        maxMktSz: Number(d.maxMktSz) || 0,
        minMktSz: Number(d.minMktSz) || 0,
        ctVal: d.ctVal ? Number(d.ctVal) : 1,
        ts: Date.now(),
      };
      instCache.set(key, rules);
      return rules;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("правила инструмента недоступны");
}

// floor до шага лота без поплавкового мусора: 0.00046 при lotSz 0.0001 → "0.0004"
export function roundToLot(qty, lotSz) {
  const lot = Number(lotSz) > 0 ? Number(lotSz) : 0.0001;
  const n = Math.floor(Number(qty) / lot + 1e-9) * lot;
  // число десятичных знаков — из самого шага (0.1→1, 0.0001→4, 1→0)
  const dec = Math.max(0, Math.min(10, (String(lot).split(".")[1] || "").length));
  return n > 0 ? n.toFixed(dec) : "0";
}

// ---------- баланс (реальные USDT) ----------
export async function fetchUsdtBalance(creds, opts) {
  const j = await signedRequest(creds, "GET", "/api/v5/account/balance", "", null, opts);
  const details = (((j.data || [])[0] || {}).details) || [];
  const usdt = details.find((c) => c.ccy === "USDT");
  return {
    usdt: usdt ? Number(usdt.availEq || usdt.availBal || 0) : 0,
    total: usdt ? Number(usdt.eq || usdt.cashBal || 0) : 0,
  };
}

// ---------- рыночный ордер + фактическое исполнение ----------
// side: "buy" — sz в USDT (quote_ccy); "sell" — sz в токене (base_ccy, округлён к лоту)
export async function placeMarketOrder(creds, instId, side, sz, opts) {
  const o = opts || {};
  const body = { instId: String(instId).toUpperCase(), tdMode: "cash", side, ordType: "market" };
  if (side === "buy") { body.sz = String(Number(sz).toFixed(2)); body.tgtCcy = "quote_ccy"; }
  else {
    const rules = instRules(instId) || (o.fetchImpl ? await fetchInstrument(instId, o.fetchImpl).catch(() => null) : null);
    body.sz = roundToLot(sz, rules ? rules.lotSz : 0.0001);
    body.tgtCcy = "base_ccy";
  }
  if (!(Number(body.sz) > 0)) { const e = new Error("размер ордера после округления к лоту — 0"); e.code = "sz"; throw e; }
  const j = await signedRequest(creds, "POST", "/api/v5/trade/order", "", body, o);
  const d0 = (j.data || [])[0] || {};
  if (d0.sCode && String(d0.sCode) !== "0") {
    const err = new Error(okxExplain(d0.sCode, d0.sMsg));
    err.code = String(d0.sCode);
    throw err;
  }
  return { ordId: d0.ordId, instId: body.instId, sz: body.sz, tgtCcy: body.tgtCcy, side };
}

// статус/исполнение ордера: OKX исполняет маркет мгновенно — достаточно одного
// запроса через небольшую паузу; если ещё live — вернётся { filled: false } и
// drainRealQueue повторит на следующем тике.
export async function orderState(creds, instId, ordId, opts) {
  const j = await signedRequest(creds, "GET", "/api/v5/trade/order", `instId=${encodeURIComponent(String(instId).toUpperCase())}&ordId=${encodeURIComponent(String(ordId))}`, null, opts);
  const d = (j.data || [])[0] || {};
  const avgPx = Number(d.avgPx) || Number(d.fillPx) || 0;
  const fillSz = Number(d.accFillSz) || 0;
  const fillUsd = avgPx > 0 ? avgPx * fillSz : 0;
  return {
    state: d.state || "",                       // live / partially_filled / filled / canceled
    filled: d.state === "filled",
    avgPx, fillSz, fillUsd,
    fee: Number(d.fee) || 0,                    // OKX: отрицательное = платим; берём как есть
    sz: Number(d.sz) || 0,
    side: d.side || "",
  };
}

// унифицированный «купить N USDT → вернуть исполнение» с ожиданием фила
export async function marketBuyWithFill(creds, instId, usdt, opts) {
  const placed = await placeMarketOrder(creds, instId, "buy", usdt, opts);
  const st = await waitFill(creds, placed.instId, placed.ordId, opts);
  return { ...placed, ...st, ok: st.filled && st.avgPx > 0 };
}

export async function marketSellWithFill(creds, instId, qty, opts) {
  const placed = await placeMarketOrder(creds, instId, "sell", qty, opts);
  const st = await waitFill(creds, placed.instId, placed.ordId, opts);
  return { ...placed, ...st, ok: st.filled && st.avgPx > 0, szSent: placed.sz };
}

async function waitFill(creds, instId, ordId, opts) {
  const o = opts || {};
  const delay = Number(o.fillDelayMs) != null ? Number(o.fillDelayMs) : 700;
  const tries = Number(o.fillTries) || 3;
  if (delay > 0 && typeof setTimeout === "function") await new Promise((r) => setTimeout(r, delay));
  let last = { filled: false, avgPx: 0, fillSz: 0 };
  for (let i = 0; i < tries; i++) {
    try {
      last = await orderState(creds, instId, ordId, o);
      if (last.filled && last.avgPx > 0) return last;
    } catch (e) { /* повторим */ }
    if (delay > 0 && typeof setTimeout === "function") await new Promise((r) => setTimeout(r, Math.max(300, delay)));
  }
  return last;
}

// ---------- тестовый прогон ключей (кнопка «Подключить OKX») ----------
export async function testKeys(creds, fetchImpl) {
  const bal = await fetchUsdtBalance(creds, { fetchImpl });
  return { ok: true, usdt: bal.usdt, total: bal.total };
}

// нормализация пары: "BTC" → "BTC-USDT", "BTCUSDT" → "BTC-USDT", "BTC-USDT" → как есть
export function toInstId(symOrPair) {
  const s = String(symOrPair || "").toUpperCase().trim();
  if (s.includes("-")) return s;
  if (s.endsWith("USDT")) return s.slice(0, -4) + "-USDT";
  return s + "-USDT";
}
