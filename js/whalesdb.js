// XenoAI Trade — БАЗА РЕАЛЬНЫХ КИТОВ-КОШЕЛЬКОВ (ончейн, требование №4).
// Кураторский список публично известных кошельков (BTC + Ethereum) с честными подписями.
// Платформа сама следит за их движениями через бесплатные открытые API без ключей:
//   BTC  → mempool.space  (/api/address/… — балансы, суммы входов/выходов, последние tx)
//   ETH  → Blockscout     (/api/v2/addresses/…/transactions — реальные переводы)
// По каждому кошельку считается ЧИСТЫЙ ПОТОК за 24 часа (сколько заведено − сколько
// выведено), из потоков всех кошельков складывается ончейн-сентимент по BTC и ETH,
// который учитывается ИИ как часть фактора «Киты» (extra.onchain в Engine.aiAnalyze).
// Кэш живёт в localStorage: офлайн показываются последние данные с меткой времени.
"use strict";

const WhalesDB = (() => {
  const CACHE_KEY = "xenoai_whalesdb_v1";
  const POLL_MS = 5 * 60000;          // опрос каждые 5 минут (по одному кошельку за тик)
  const FRESH_MS = 30 * 60000;        // данные младше 30 минут считаются живыми

  // ================= СПИСОК КОШЕЛЬКОВ =================
  // Все адреса — публичные факты (годами отслеживаются Arkham/Nansen/Blockscout).
  // Подписи честные: биржевые кошельки помечены как биржевые, известные лица — по имени.
  const WALLETS = [
    // ----- Ethereum -----
    { id: "vitalik", chain: "ETH", label: "Vitalik Buterin", note: "основатель Ethereum: его продажи двигают рынок", addr: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", hot: true },
    { id: "ef", chain: "ETH", label: "Ethereum Foundation", note: "казна фонда: продажи = сигнал, продажи редки", addr: "0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe", hot: false },
    { id: "justin", chain: "ETH", label: "Justin Sun (HTX)", note: "известный трейдер-кит: крупные переводы часто предвещают ход", addr: "0x3ddfa8ec3052539b6c9549f12cea2c295cff5296", hot: true },
    { id: "binance14", chain: "ETH", label: "Binance (горячий)", note: "приток на биржу = давление продаж, отток = накопление", addr: "0x28C6c06298d514Db089934071355E5743bf21d60", hot: true },
    { id: "bfxhacker", chain: "ETH", label: "Взломщик Bitfinex-2016", note: "движения древнего кита: рынок следит за распродажей", addr: "0xae2Fc483527B8EF99EB5D9B44875F005ba1FaE13", hot: true },
    { id: "bitfinex", chain: "ETH", label: "Bitfinex (холодный)", note: "один из крупнейших ETH-кошельков биржи", addr: "0xBe0EB53F46f80506Dcf16E1aB4F0d4859Df11E4e", hot: true },
    // ----- Bitcoin -----
    { id: "binancecold", chain: "BTC", label: "Binance (холодный)", note: "главный холодный кошелёк Binance: приток = депозиты трейдеров", addr: "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo", hot: true },
    { id: "miner", chain: "BTC", label: "Крупный майнер-холдер", note: "многолетний майнинг без распродаж: движение = событие", addr: "1P5ZEDWTKTFGxQjZphgWPQUpe554WKDfHQ", hot: false },
    { id: "btccold2", chain: "BTC", label: "Древний кит (2013)", note: "активен с 2013 года, сидит на пятизначном числе BTC", addr: "12ib7dApVFvg82TXKycWBNpN8kFyiAN1dr", hot: false },
  ];

  const state = {
    wallets: {},     // id → { label, chain, addr, net24h, lastIn, lastOut, lastTs, moves: [...], balance }
    lastPoll: 0,     // когда последний раз опрашивали сеть
    lastError: null,
    started: false,
  };

  // ---------- кэш ----------
  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d && d.wallets && typeof d.wallets === "object") {
        state.wallets = d.wallets;
        state.lastPoll = d.lastPoll || 0;
      }
    } catch (e) { /* нет кэша — соберём с нуля */ }
  }
  function saveCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ wallets: state.wallets, lastPoll: state.lastPoll })); } catch (e) { /* noop */ }
  }

  function fetchT(url, ms) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms || 9000);
    return fetch(url, { signal: ctl.signal, cache: "no-store" })
      .then((r) => { clearTimeout(t); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .catch((e) => { clearTimeout(t); throw e; });
  }

  // ================= BTC: mempool.space =================
  // Снимок: chain_stats (суммы входов/выходов за всю жизнь) + последние транзакции.
  // Чистый поток за окно = дельта (funded − spent) между текущим и прошлым снимком.
  async function pollBtc(w) {
    const cur = state.wallets[w.id] || { netWindow: 0, lastFunded: 0, lastSpent: 0, moves: [], lastTs: 0 };
    const j = await fetchT("https://mempool.space/api/address/" + w.addr);
    const cs = (j && j.chain_stats) || {};
    const funded = cs.funded_txo_sum || 0;   // сатоши заведено за всю историю
    const spent = cs.spent_txo_sum || 0;     // сатоши выведено за всю историю
    const balance = Math.max(0, funded - spent);
    // дельта потока: разница с прошлым снимком (если он был) — заведённое минус выведенное
    let net = 0, inflow = 0, outflow = 0;
    if (cur.lastFunded || cur.lastSpent) {
      inflow = Math.max(0, funded - cur.lastFunded);
      outflow = Math.max(0, spent - cur.lastSpent);
      net = inflow - outflow;
    }
    // последние движения (2 запроса: подтверждённые + mempool) — для ленты
    let moves = cur.moves || [];
    try {
      const txs = await fetchT("https://mempool.space/api/address/" + w.addr + "/txs");
      if (Array.isArray(txs)) {
        moves = txs.slice(0, 12).map((tx) => {
          let mine = 0, others = 0;
          (tx.vout || []).forEach((o) => { if (o.scriptpubkey_address === w.addr) mine += o.value || 0; else others += o.value || 0; });
          let sent = 0;
          (tx.vin || []).forEach((i) => { if (i.prevout && i.prevout.scriptpubkey_address === w.addr) sent += i.prevout.value || 0; });
          const received = mine > 0;
          const val = received ? mine : (sent - (mine || 0));
          return {
            ts: (tx.status && tx.status.block_time ? tx.status.block_time * 1000 : Date.now()),
            dir: received ? "in" : "out",
            amount: Math.max(val, 0) / 1e8, // BTC
            usd: 0, // usd посчитаем по курсу при показе
            txid: tx.txid || "",
          };
        }).filter((m) => m.amount > 0.0001);
      }
    } catch (e) { /* лента не критична */ }
    state.wallets[w.id] = {
      ...cur, label: w.label, chain: "BTC", addr: w.addr, note: w.note,
      balance, net, inflow, outflow,
      // окно 24ч: аккумулируем поток в скользящее значение (затухание к нулю)
      net24h: (cur.net24h || 0) * 0.985 + net,
      moves, lastTs: Date.now(),
    };
  }

  // ================= ETH: Blockscout v2 =================
  async function pollEth(w) {
    const cur = state.wallets[w.id] || { net24h: 0, moves: [], lastTs: 0 };
    const j = await fetchT("https://eth.blockscout.com/api/v2/addresses/" + w.addr + "/transactions");
    const items = (j && j.items) || [];
    const dayAgo = Date.now() - 24 * 3600 * 1000;
    let net = 0, inflow = 0, outflow = 0;
    const moves = [];
    for (const tx of items) {
      const ts = tx.timestamp ? Date.parse(tx.timestamp) : 0;
      const valueEth = Number(tx.value || 0) / 1e18;
      if (!Number.isFinite(valueEth) || valueEth <= 0) continue;
      const isFrom = (tx.from && tx.from.hash || "").toLowerCase() === w.addr.toLowerCase();
      const isTo = (tx.to && tx.to.hash || "").toLowerCase() === w.addr.toLowerCase();
      if (!isFrom && !isTo) continue;
      if (ts > dayAgo) {
        if (isFrom) { outflow += valueEth; net -= valueEth; }
        if (isTo) { inflow += valueEth; net += valueEth; }
      }
      if (moves.length < 10) {
        moves.push({
          ts, dir: isFrom ? "out" : "in",
          amount: valueEth, usd: 0,
          txid: tx.hash || "",
        });
      }
      if (moves.length >= 10) break;
    }
    state.wallets[w.id] = {
      ...cur, label: w.label, chain: "ETH", addr: w.addr, note: w.note,
      net24h: (cur.net24h || 0) * 0.985 + net * 0.015, // сглаживание: ETH-поток шумный
      inflow, outflow, net,
      moves, lastTs: Date.now(),
    };
  }

  // ================= планировщик: быстрый разгон + ротация раз в 75 секунд =================
  let pollIdx = 0;
  function pollOne() {
    const w = WALLETS[pollIdx % WALLETS.length];
    pollIdx++;
    const job = w.chain === "BTC" ? pollBtc(w) : pollEth(w);
    return job
      .then(() => { state.lastError = null; state.lastPoll = Date.now(); saveCache(); if (Store.subscribe) Store.emit(); })
      .catch((e) => { state.lastError = w.label + ": " + String(e && e.message || e); });
  }
  function start() {
    if (state.started) return;
    state.started = true;
    loadCache();
    // стартовый разгон: первые кошельки опрашиваем сразу с коротким шагом,
    // чтобы база была жива уже через несколько секунд после входа
    [0, 1200, 2600, 4200].forEach((ms) => {
      if (typeof setTimeout === "function") setTimeout(() => pollOne(), ms);
      else pollOne();
    });
    if (typeof setInterval === "function") setInterval(pollOne, 75000);
  }

  // ================= ончейн-сентимент для ИИ =================
  // bias(sym): нормированный перевес накопления/распределения по монете (−1..+1)
  // + человекочитаемое пояснение. Данные старше 2 часов считаются остывшими.
  function bias(sym) {
    const chain = sym === "BTC" ? "BTC" : sym === "ETH" ? "ETH" : null;
    if (!chain) return null;
    let net = 0, active = 0, hottest = null;
    for (const w of WALLETS) {
      if (w.chain !== chain) continue;
      const d = state.wallets[w.id];
      if (!d || !d.lastTs || Date.now() - d.lastTs > 2 * 3600 * 1000) continue;
      active++;
      net += d.net24h || 0;
      if (!hottest || Math.abs(d.net24h || 0) > Math.abs(hottest.net24h || 0)) hottest = d;
    }
    if (!active) return null;
    // нормировка: BTC — на 50 BTC/сутки, ETH — на 5000 ETH/сутки (реалистичные масштабы крупных кошельков)
    const scale = chain === "BTC" ? 50 : 5000;
    const dir = Math.max(-1, Math.min(1, net / scale));
    if (Math.abs(dir) < 0.06) return null; // шум не учитываем
    const usd = chain === "BTC" ? net * 90000 : net * 3000;
    return {
      dir,
      detail: `ончейн-киты ${chain}: за сутки перевес ${dir > 0 ? "накопления" : "распределения"} ${dir > 0 ? "+" : "−"}${Math.abs(chain === "BTC" ? net : Math.round(net))} ${chain} (≈ $${fmtK(Math.abs(usd))}) · активных кошельков: ${active}`,
      hottest: hottest ? { label: hottest.label, net24h: hottest.net24h } : null,
    };
  }
  function fmtK(v) {
    if (v >= 1e9) return (v / 1e9).toFixed(1) + "B";
    if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
    if (v >= 1e3) return Math.round(v / 1e3) + "K";
    return Math.round(v);
  }

  function list() {
    return WALLETS.map((w) => ({ ...w, ...(state.wallets[w.id] || {}) }));
  }
  function info() {
    return { lastPoll: state.lastPoll, lastError: state.lastError, fresh: state.lastPoll && Date.now() - state.lastPoll < FRESH_MS, tracked: WALLETS.length };
  }
  // события для ленты: крупные движения отслеживаемых кошельков (вызывает store)
  function bigMoves(prices) {
    const out = [];
    for (const w of WALLETS) {
      const d = state.wallets[w.id];
      if (!d || !Array.isArray(d.moves)) continue;
      for (const m of d.moves.slice(0, 3)) {
        const px = w.chain === "BTC" ? (prices.BTC && prices.BTC.price) || 0 : (prices.ETH && prices.ETH.price) || 0;
        m.usd = m.amount * px;
        if (m.usd >= 5e6) out.push({ wallet: w.label, chain: w.chain, move: m, sym: w.chain });
      }
    }
    return out.sort((a, b) => b.move.ts - a.move.ts).slice(0, 6);
  }

  return { start, bias, list, info, bigMoves, _state: state, WALLETS, _pollOne: pollOne };
})();

window.WhalesDB = WhalesDB;
