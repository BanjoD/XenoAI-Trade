// XenoAI Trade — заготовка реальной торговли (режим «Реальный рынок»).
// Два коннектора: крипто-кошелёк (EIP-1193: MetaMask/Rabby/OKX Wallet) и API-ключи биржи
// (Binance / Bybit / OKX, подпись HMAC-SHA256 через WebCrypto).
// Деньги НЕ хранятся на платформе: средства остаются на бирже/в кошельке,
// платформа только читает баланс и отправляет подписанные ордера от имени владельца.
// Отправка ордеров включается ТОЛЬКО после явного подтверждения риска.
"use strict";

const Live = (() => {
  const KEYS_STORE = "xenoai_live_keys";   // локальное хранилище ключей (только этот браузер)
  const RISK_STORE = "xenoai_live_risk";   // флаг «я понимаю риски»
  const ORDERS_STORE = "xenoai_live_orders"; // разрешение отправки ордеров

  const EXCHANGES = [
    { id: "binance", name: "Binance", needsPass: false, note: "спот, ключ с правами «Чтение» + «Спот-торговля»" },
    { id: "bybit", name: "Bybit", needsPass: false, note: "спот, ключ с правами «Чтение» + «Ордера»" },
    { id: "okx", name: "OKX", needsPass: true, note: "спот, ключ + секрет + passphrase" },
  ];

  const state = {
    conn: null,          // { type: "wallet" | "keys", exchange, label, detail, balanceUSDT }
    wallet: null,        // { address, chainId, native, nativeSym, usdt }
    keys: null,          // { exchange, apiKeyMasked, tested }
    riskAccepted: false,
    ordersEnabled: false,
    lastError: null,
    connecting: false,
  };

  function loadPersisted() {
    try {
      const risk = localStorage.getItem(RISK_STORE) === "1";
      state.riskAccepted = risk;
      state.ordersEnabled = risk && localStorage.getItem(ORDERS_STORE) === "1";
      const raw = localStorage.getItem(KEYS_STORE);
      if (raw) {
        const d = JSON.parse(raw);
        if (d && d.exchange) {
          state.keys = { exchange: d.exchange, apiKeyMasked: d.apiKeyMasked, tested: !!d.tested };
          if (d.tested) state.conn = { type: "keys", exchange: d.exchange, label: `${exName(d.exchange)} · ключ …${d.apiKeyMasked}`, detail: "API-ключ (сохранён локально)" };
        }
      }
    } catch (e) { /* noop */ }
  }
  function exName(id) { const e = EXCHANGES.find((x) => x.id === id); return e ? e.name : id; }
  function maskKey(k) { return k.length > 8 ? k.slice(0, 4) + "…" + k.slice(-4) : "…"; }

  function persistKeys() {
    try {
      if (!state.keys) { localStorage.removeItem(KEYS_STORE); return; }
      localStorage.setItem(KEYS_STORE, JSON.stringify({
        exchange: state.keys.exchange, apiKeyMasked: state.keys.apiKeyMasked, tested: state.keys.tested ? 1 : 0,
      }));
    } catch (e) { /* noop */ }
  }

  const listeners = new Set();
  function emit() { listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } }); }
  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  // ================= WebCrypto: HMAC-SHA256 =================
  async function hmacHex(secret, msg) {
    const sig = await hmacRaw(secret, msg);
    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  async function hmacB64(secret, msg) {
    const sig = await hmacRaw(secret, msg);
    let s = "";
    new Uint8Array(sig).forEach((b) => { s += String.fromCharCode(b); });
    return btoa(s);
  }
  async function hmacRaw(secret, msg) {
    if (!window.crypto || !crypto.subtle) throw new Error("WebCrypto недоступен — откройте платформу по HTTPS");
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return crypto.subtle.sign("HMAC", key, enc.encode(msg));
  }

  async function signedRequest(exchange, creds, method, path, query, body) {
    const ts = Date.now();
    method = method.toUpperCase();
    if (exchange === "binance") {
      const host = "https://api.binance.com";
      const q = (query || "") + (query ? "&" : "") + `timestamp=${ts + binanceOffset()}&recvWindow=5000`;
      const sig = await hmacHex(creds.secret, q);
      const url = `${host}${path}?${q}&signature=${sig}`;
      const res = await fetch(url, {
        method, headers: { "X-MBX-APIKEY": creds.key },
        body: body ? JSON.stringify(body) : undefined, cache: "no-store",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(xplain("binance", json.msg || ("Binance HTTP " + res.status), json.code));
      return json;
    }
    if (exchange === "bybit") {
      const host = "https://api.bybit.com";
      const recv = "5000";
      const payload = method === "POST"
        ? ts + creds.key + recv + JSON.stringify(body || {})
        : ts + creds.key + recv + (query || "");
      const sig = await hmacHex(creds.secret, payload);
      const url = method === "POST" ? `${host}${path}` : `${host}${path}${query ? "?" + query : ""}`;
      const res = await fetch(url, {
        method, cache: "no-store",
        headers: {
          "X-BAPI-API-KEY": creds.key, "X-BAPI-TIMESTAMP": String(ts), "X-BAPI-RECV-WINDOW": recv,
          "X-BAPI-SIGN": sig, "Content-Type": "application/json",
        },
        body: method === "POST" ? JSON.stringify(body || {}) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      if (json.retCode !== 0) throw new Error(xplain("bybit", json.retMsg || ("Bybit " + res.status), json.retCode));
      return json;
    }
    if (exchange === "okx") {
      const host = "https://www.okx.com";
      // подпись OKX: GET — путь ВМЕСТЕ со строкой запроса; POST — путь + тело
      const fullPath = query ? path + "?" + query : path;
      const iso = new Date(ts + okxOffset()).toISOString();
      const bodyStr = body ? JSON.stringify(body) : "";
      const sign = await hmacB64(creds.secret, iso + method + fullPath + bodyStr);
      const res = await fetch(host + fullPath, {
        method, cache: "no-store",
        headers: {
          "OK-ACCESS-KEY": creds.key, "OK-ACCESS-SIGN": sign, "OK-ACCESS-TIMESTAMP": iso,
          "OK-ACCESS-PASSPHRASE": creds.pass || "", "Content-Type": "application/json",
        },
        body: body ? bodyStr : undefined,
      });
      const json = await res.json().catch(() => ({}));
      if (json.code !== "0") {
        const code = json.data && json.data[0] && json.data[0].sCode || (json.data && json.data[0] && json.data[0].code);
        const raw = (json.data && json.data[0] && (json.data[0].msg || json.data[0].sMsg)) || json.msg || ("OKX " + res.status);
        // 50102 — расхождение часов: корректируем смещение по серверному времени и повторяем ОДИН раз
        if (String(code) === "50102") {
          await syncOkxTime();
          throw new Error(xplain("okx", raw, code) + " — время синхронизировано с сервером OKX, повторите запрос");
        }
        throw new Error(xplain("okx", raw, code));
      }
      return json;
    }
    throw new Error("Неизвестная биржа");
  }

  // ---------- расшифровка ошибок бирж + авто-коррекция времени ----------
  // Часы устройства могут расходиться с сервером — тогда подпись «из будущего/прошлого»
  // отвергается. Раз в сессию спрашиваем серверное время OKX/Binance и дальше подписываем
  // с поправкой. Понятные тексты вместо голых кодов — чтобы пользователь знал, что чинить.
  let okxOffsetMs = 0, binanceOffsetMs = 0, offsetSynced = false;
  function okxOffset() { return okxOffsetMs; }
  function binanceOffset() { return binanceOffsetMs; }
  async function syncOkxTime() {
    try {
      const r = await fetch("https://www.okx.com/api/v5/public/time", { cache: "no-store" });
      const j = await r.json();
      const srv = Number(j.data && j.data[0] && j.data[0].ts);
      if (srv > 0) { okxOffsetMs = srv - Date.now(); offsetSynced = true; }
    } catch (e) { /* нет сети — подписываем локальным временем */ }
  }
  async function syncBinanceTime() {
    try {
      const r = await fetch("https://api.binance.com/api/v3/time", { cache: "no-store" });
      const j = await r.json();
      if (j && j.serverTime > 0) { binanceOffsetMs = j.serverTime - Date.now(); offsetSynced = true; }
    } catch (e) { /* нет сети */ }
  }
  function xplain(exchange, msg, code) {
    const c = String(code == null ? "" : code);
    const m = String(msg || "");
    const map = [
      [/50111|-2015|-2014|API.*invalid|Invalid API-key/i, "ключ не принят: проверьте API-ключ и что он действует (не удалён, не истёк, совпадает биржа)", ],
      [/50112|50113|passphrase/i, "неверная парольная фраза (passphrase) — та, что вы задали ПРИ СОЗДАНИИ ключа на OKX"],
      [/50102|-1021|timestamp/i, "расхождение времени устройства с сервером биржи"],
      [/33009|-2019|margin|insufficient/i, "недостаточно средств на бирже для операции"],
      [/51000|51001|instId|instrument/i, "инструмент не найден на этой бирже (проверьте пару, например BTC-USDT)"],
      [/permission|not.*allow|denied/i, "у ключа нет нужного права: включите «Чтение» (и «Торговля» для ордеров) при создании ключа"],
      [/IP|white|restricted|region/i, "биржа ограничила доступ с этого IP/региона — добавьте IP в белый список ключа"],
    ];
    for (const [re, txt] of map) if (re.test(m) || (c && re.test(c))) return txt + " [" + (c || exchange) + "]";
    return m;
  }

  // ================= кошелёк (EIP-1193) =================
  const CHAINS = { "0x1": "Ethereum", "0x38": "BNB Chain", "0x89": "Polygon", "0xa": "Optimism", "0xa4b1": "Arbitrum", "0xa86a": "Avalanche", "0x2105": "Base" };
  const USDT_ADDR = { "0x1": "0xdAC17F958D2ee523a2206206994597C13D831ec7", "0x38": "0x55d398326f99059fF775485246999027B3197955", "0x89": "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", "0xa": "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", "0xa4b1": "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", "0xa86a": "0x970229A125A0466942871530eec6A8E64E7748d6", "0x2105": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };

  function provider() { return window.ethereum || null; }

  async function connectWallet() {
    const eth = provider();
    if (!eth) throw new Error("Кошелёк не найден. Установите MetaMask / Rabby / OKX Wallet и обновите страницу");
    state.connecting = true; emit();
    try {
      const accounts = await eth.request({ method: "eth_requestAccounts" });
      if (!accounts || !accounts.length) throw new Error("Кошелёк не вернул адрес");
      state.wallet = { address: accounts[0], chainId: null, native: 0, nativeSym: "ETH", usdt: 0 };
      await refreshWallet();
      bindWalletEvents(eth);
      state.conn = { type: "wallet", label: shortAddr(state.wallet.address), detail: (CHAINS[state.wallet.chainId] || "сеть") + " · крипто-кошелёк", balanceUSDT: state.wallet.usdt };
      emit();
      return state.wallet;
    } finally {
      state.connecting = false;
    }
  }

  function bindWalletEvents(eth) {
    if (eth.__xenoaiBound) return;
    eth.__xenoaiBound = true;
    if (eth.on) {
      eth.on("accountsChanged", (accs) => {
        if (!accs || !accs.length) { disconnect(); return; }
        if (state.wallet) state.wallet.address = accs[0];
        refreshWallet().then(emit).catch(() => {});
      });
      eth.on("chainChanged", () => { refreshWallet().then(emit).catch(() => {}); });
    }
  }

  function shortAddr(a) { return a.slice(0, 6) + "…" + a.slice(-4); }

  async function refreshWallet() {
    const w = state.wallet, eth = provider();
    if (!w || !eth) return;
    try {
      w.chainId = await eth.request({ method: "eth_chainId" });
      const weiHex = await eth.request({ method: "eth_getBalance", params: [w.address, "latest"] });
      w.native = parseInt(weiHex, 16) / 1e18;
      w.nativeSym = (CHAINS[w.chainId] === "BNB Chain") ? "BNB" : "ETH";
      // USDT (ERC-20) balanceOf через eth_call
      const usdt = USDT_ADDR[w.chainId];
      w.usdt = 0;
      if (usdt) {
        const data = "0x70a08231" + "000000000000000000000000" + w.address.replace("0x", "").toLowerCase();
        const resHex = await eth.request({ method: "eth_call", params: [{ to: usdt, data }, "latest"] });
        w.usdt = parseInt(resHex, 16) / 1e6;
      }
      if (state.conn && state.conn.type === "wallet") {
        state.conn.detail = `${CHAINS[w.chainId] || "сеть"} · крипто-кошелёк`;
        state.conn.balanceUSDT = w.usdt;
      }
    } catch (e) {
      state.lastError = "Кошелёк: " + e.message;
    }
  }

  function disconnect() {
    state.conn = null;
    state.wallet = null;
    state.__creds = null; // подписанные запросы без активного подключения невозможны
    emit();
  }

  // ================= ключи биржи =================
  function saveKeys(exchange, key, secret, pass) {
    if (!key || !secret) throw new Error("Введите API-ключ и секрет");
    state.keys = { exchange, apiKeyMasked: maskKey(key), tested: false };
    persistKeys();
    return { exchange, key, secret, pass };
  }

  async function testKeys(creds) {
    // перед первым подписанным запросом синхронизируем время с биржей —
    // защищает от «подпись из будущего» при расхождении часов устройства
    if (!offsetSynced) {
      if (creds.exchange === "okx") await syncOkxTime();
      if (creds.exchange === "binance") await syncBinanceTime();
    }
    const res = await readBalance(creds.exchange, creds);
    state.keys = { exchange: creds.exchange, apiKeyMasked: maskKey(creds.key), tested: true };
    persistKeys();
    state.conn = {
      type: "keys", exchange: creds.exchange, label: `${exName(creds.exchange)} · ключ …${maskKey(creds.key)}`,
      detail: "API-ключ (сохранён локально)", balanceUSDT: res.usdt,
    };
    emit();
    return res;
  }

  async function readBalance(exchange, creds) {
    if (exchange === "binance") {
      const acc = await signedRequest(exchange, creds, "GET", "/api/v3/account", "", null);
      const usdt = (acc.balances || []).find((b) => b.asset === "USDT");
      return { usdt: usdt ? Number(usdt.free) : 0, canTrade: !!acc.canTrade };
    }
    if (exchange === "bybit") {
      const res = await signedRequest(exchange, creds, "GET", "/v5/account/wallet-balance", "accountType=UNIFIED", null);
      const coin = (((res.result || {}).list || [])[0] || {}).coin || [];
      const usdt = coin.find((c) => c.coin === "USDT");
      return { usdt: usdt ? Number(usdt.walletBalance) : 0 };
    }
    if (exchange === "okx") {
      const res = await signedRequest(exchange, creds, "GET", "/api/v5/account/balance", "", null);
      const details = (((res.data || [])[0] || {}).details) || [];
      const usdt = details.find((c) => c.ccy === "USDT");
      return { usdt: usdt ? Number(usdt.availEq || usdt.availBal || 0) : 0 };
    }
    throw new Error("Неизвестная биржа");
  }

  // ================= рыночный ордер =================
  // p = { sym: "BTCUSDT", side: "лонг"|"шорт", amountUSDT, price }
  async function placeOrder(p) {
    if (!state.ordersEnabled) throw new Error("Отправка ордеров запрещена — подтвердите риск в настройках реального режима");
    const creds = state.__creds;
    if (!creds) throw new Error("Нет активных API-ключей");
    const exchange = creds.exchange;
    const side = p.side === "лонг" ? "BUY" : "SELL";
    const qty = Math.max(0, p.amountUSDT / (p.price || 1));
    let res;
    if (exchange === "binance") {
      const q = side === "BUY"
        ? `symbol=${p.sym}&side=${side}&type=MARKET&quoteOrderQty=${p.amountUSDT}`
        : `symbol=${p.sym}&side=${side}&type=MARKET&quantity=${qty.toFixed(6)}`;
      res = await signedRequest(exchange, creds, "POST", "/api/v3/order", q, null);
    } else if (exchange === "bybit") {
      res = await signedRequest(exchange, creds, "POST", "/v5/order/create", "", {
        category: "spot", symbol: p.sym, side: side === "BUY" ? "Buy" : "Sell",
        orderType: "Market", qty: qty.toFixed(6),
      });
    } else {
      res = await signedRequest(exchange, creds, "POST", "/api/v5/trade/order", "", {
        instId: p.sym.replace("USDT", "-USDT"), tdMode: "cash",
        side: side === "BUY" ? "buy" : "sell", ordType: "market",
        sz: side === "BUY" ? String(p.amountUSDT) : qty.toFixed(6),
        tgtCcy: side === "BUY" ? "quote_ccy" : "base_ccy",
      });
    }
    // R49: фактическая цена исполнения (если биржа её вернула) — уезжает на сервер
    // для точного PnL реальных сделок; без неё сервер возьмёт свой живой кэш цены
    let fill = null;
    try {
      if (Array.isArray(res.fills) && res.fills.length) {
        let q = 0, sum = 0;
        for (const f2 of res.fills) { const px = Number(f2.price), qt = Number(f2.qty); if (px > 0 && qt > 0) { sum += px * qt; q += qt; } }
        if (q > 0) fill = sum / q;
      }
      if (fill == null && res.retExtInfo && res.retExtInfo.list && res.retExtInfo.list[0] && Number(res.retExtInfo.list[0].avgPrice) > 0) fill = Number(res.retExtInfo.list[0].avgPrice);
      if (fill == null && res.data && res.data[0] && Number(res.data[0].avgPx) > 0) fill = Number(res.data[0].avgPx);
    } catch (e) { /* цены нет — сервер возьмёт кэш */ }
    return { exchange, raw: res, side: p.side, sym: p.sym, amountUSDT: p.amountUSDT, qty, price: fill || p.price || null, ts: Date.now() };
  }

  function acceptRisk(on) {
    state.riskAccepted = on;
    try {
      localStorage.setItem(RISK_STORE, on ? "1" : "0");
      if (!on) localStorage.removeItem(ORDERS_STORE);
    } catch (e) { /* noop */ }
    if (!on) state.ordersEnabled = false;
    emit();
  }
  function setOrdersEnabled(on) {
    if (on && !state.riskAccepted) throw new Error("Сначала подтвердите риск");
    state.ordersEnabled = on;
    try { localStorage.setItem(ORDERS_STORE, on ? "1" : "0"); } catch (e) { /* noop */ }
    emit();
  }

  loadPersisted();

  return {
    state, onChange, EXCHANGES,
    connectWallet, refreshWallet, disconnect,
    saveKeys, testKeys, readBalance, placeOrder,
    acceptRisk, setOrdersEnabled,
    __setCreds(c) { state.__creds = c; },
    isConnected() { return Boolean(state.conn); },
    balanceUSDT() { return state.conn && state.conn.balanceUSDT != null ? state.conn.balanceUSDT : null; },
    ordersAllowed() { return state.ordersEnabled; },
  };
})();

window.Live = Live;
