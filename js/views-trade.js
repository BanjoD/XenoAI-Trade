// XenoAI Trade — экраны: Рынок, Сделки, Счета, Портфель + форма сделки и кабинет
"use strict";

const ViewsTrade = (() => {
  const S = () => Store.state;
  const h = UI;
  const fmtPrice = (v) => Fmt.fmtPrice(v);
  const ago = (ts) => Fmt.fmtTimeAgo((Date.now() - ts) / 60000);

  // ================= РЫНОК =================
  function market() {
    const s = S();
    const st = s._mkt || (s._mkt = { tf: "15м", emaOn: true, whalesOn: false, gapsOn: false });
    const sym = s.activeSym;
    const inst = DataLib.BY_SYM[sym];
    const p = s.prices[sym] || { price: 0, chg24h: 0, low24: 0, high24: 0, vol24: 0 };
    const bars = Store.getBars(sym, st.tf);
    const whalesArr = s.whales[sym] || [];

    // вкладки инструментов
    const tabs = `<div class="chip-row scroll">` + DataLib.WATCHLIST.map((i) => {
      const chg = (s.prices[i.sym] && s.prices[i.sym].chg24h) || 0;
      return `<button class="chip ${i.sym === sym ? "active" : ""}" data-action="mkt:sym" data-arg="${i.sym}">
        ${h.coin(i.sym, 16)} ${i.sym}
        <span class="num ${chg >= 0 ? "text-green" : "text-red"}" style="font-size:11px">${chg >= 0 ? "+" : "−"}${Math.abs(chg).toFixed(1)}%</span>
      </button>`;
    }).join("") + `</div>`;

    // маркеры китов на графике
    let markers = [];
    if (st.whalesOn && bars.length && whalesArr.length) {
      const stepMin = (DataLib.TF_MAP[st.tf] && DataLib.TF_MAP[st.tf].stepMin) || 15;
      const t0 = bars[0].t;
      for (const w of whalesArr.slice(0, 25)) {
        const idx = Math.round((w.time / 60000 - t0) / stepMin);
        if (idx < 0 || idx >= bars.length) continue;
        const big = w.notional >= 150000;
        markers.push({
          idx, price: w.price,
          kind: w.side === "buy" ? (big ? "buyplus" : "buy") : (big ? "sellplus" : "sell"),
          label: big ? (w.side === "buy" ? "кит покупает" : "кит продаёт") : undefined,
        });
      }
    }

    const levels = [
      { price: p.high24, label: "24ч макс", color: "gray", dashed: true },
      { price: p.low24, label: "24ч мин", color: "gray", dashed: true },
    ];

    // лента китов под графиком
    const whaleFeed = whalesArr.length === 0
      ? `<div style="padding:8px 0;font-size:12px;color:#52525b">Загружаю ленту aggTrades…</div>`
      : `<div class="mkt-whales-grid">` + whalesArr.slice(0, 8).map((w) => `
          <div class="mkt-witem num">
            <span class="${w.side === "buy" ? "text-green" : "text-red"}">${w.side === "buy" ? "купил" : "продал"} $${Math.round(w.notional / 1000)}K</span>
            <span style="color:#71717a">${fmtPrice(w.price)}</span>
            <span style="margin-left:auto;color:#52525b">${Fmt.fmtClockShort(w.time)}</span>
          </div>`).join("") + `</div>`;

    // «В движении»
    const movers = DataLib.WATCHLIST
      .map((i) => ({ sym: i.sym, chg: (s.prices[i.sym] && s.prices[i.sym].chg24h) || 0 }))
      .sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg))
      .slice(0, 6);
    const moversHtml = `<div class="rows row-divide">` + movers.map((m) => `
      <button class="mover" data-action="mkt:sym" data-arg="${m.sym}">
        ${h.coin(m.sym, 30)}
        <span style="font-size:13.5px;font-weight:500">${m.sym}</span>
        ${h.tag(m.chg >= 1 ? "green" : m.chg <= -1 ? "red" : "gray", m.chg >= 1 ? "тренд вверх" : m.chg <= -1 ? "тренд вниз" : "спокойно")}
        <span class="chg num ${m.chg >= 0 ? "text-green" : "text-red"}">${m.chg >= 0 ? "+" : "−"}${Math.abs(m.chg).toFixed(2)}%</span>
      </button>`).join("") + `</div>`;

    // топ по объёму
    const topVol = [...DataLib.WATCHLIST]
      .sort((a, b) => ((s.prices[b.sym] && s.prices[b.sym].vol24) || 0) - ((s.prices[a.sym] && s.prices[a.sym].vol24) || 0))
      .slice(0, 5);
    const topVolHtml = topVol.map((i) => {
      const pi = s.prices[i.sym] || { price: 0, spark: [] };
      return `<div class="volrow">
        ${h.coin(i.sym, 24)}
        <span style="font-size:12.5px">${i.sym}</span>
        ${Charts.spark(pi.spark.slice(-14), { w: 56, h: 16, dot: false })}
        <span class="p num">$${fmtPrice(pi.price)}</span>
      </div>`;
    }).join("");

    const volStr = (p.vol24 || 0) >= 1e6 ? `${((p.vol24 || 0) / 1e6).toFixed(1)}M` : `${((p.vol24 || 0) / 1e3).toFixed(0)}K`;

    const html = `
    <div class="stack-16">
      ${tabs}
      <div class="mkt-grid">
        <section class="card">
          <div class="mkt-head">
            ${h.coin(sym, 36)}
            <div>
              <div style="display:flex;align-items:center;gap:8px">
                <span style="font-size:16px;font-weight:600">${sym}</span>
                ${h.tag("blue", inst ? inst.pair : sym)}
                ${s.degraded ? h.tag("orange", "симуляция") : ""}
              </div>
              <div class="mkt-sub num">за сутки <span class="${(p.chg24h || 0) >= 0 ? "text-green" : "text-red"}">${(p.chg24h || 0) >= 0 ? "+" : "−"}${Math.abs(p.chg24h || 0).toFixed(2)}%</span> · диапазон ${fmtPrice(p.low24 || 0)} — ${fmtPrice(p.high24 || 0)}</div>
            </div>
            <div class="px">
              <div class="mkt-price num">${fmtPrice(p.price || 0)}</div>
              <div class="mkt-sub num">объём 24ч $${volStr}</div>
            </div>
          </div>

          <div class="mkt-tools">
            <div style="display:flex;align-items:center;gap:2px">
              ${h.togglePill(st.emaOn, "Скользящие", "mkt:ema")}
              ${h.togglePill(st.whalesOn, "Киты", "mkt:whales")}
              ${h.togglePill(st.gapsOn, "Гэпы", "mkt:gaps")}
            </div>
            ${h.tfBar(st.tf, "mkt:tf", Object.keys(DataLib.TF_MAP))}
          </div>

          <div class="chart-box">
            ${bars.length
              ? (st.emaOn
                ? `<div id="candle-chart" style="height:460px"></div>`
                : `<div style="position:relative"><div id="line-chart" style="height:460px"></div>
                    <div class="chart-legend">
                      <span><span class="lg-line" style="background:${(p.chg24h || 0) >= 0 ? "#ff4fa3" : "#f87171"}"></span> Цена</span>
                      <span><span class="lg-sq" style="background:#a78bfa"></span> Объём</span>
                    </div></div>`)
              : `<div class="chart-ph">Загружаю свечи Binance…</div>`}
          </div>

          <div class="mkt-whales">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;font-size:12px;color:#71717a">
              <span>Что делали киты · реальные крупные сделки ${sym}</span>
              <button class="link-btn" style="color:var(--accent-2)" data-action="mkt:whales-on">показать на графике</button>
            </div>
            ${whaleFeed}
          </div>
        </section>

        <aside class="mkt-right">
          <div class="card">
            <div class="card-head" style="padding:12px 16px">
              <span class="card-head-title">В движении</span>
              <span style="font-size:12px;color:#71717a">24ч</span>
            </div>
            ${moversHtml}
          </div>

          <div class="card" style="padding:12px 16px">
            <div style="margin-bottom:8px;font-size:12px;color:#71717a">Топ по объёму 24ч</div>
            ${topVolHtml}
          </div>

          ${tradeForm(sym, true)}
        </aside>
      </div>
    </div>`;

    return {
      html,
      mount() {
        if (!bars.length) return;
        if (st.emaOn) {
          const el = document.getElementById("candle-chart");
          if (el) Charts.candleChart(el, bars, { levels, markers, currentPrice: p.price, emas: [9, 21], timeEvery: 5, rightPad: window.innerWidth < 640 ? 62 : 96 });
        } else {
          const el = document.getElementById("line-chart");
          if (el) {
            Charts.lineVolume(el, bars.map((b) => b.c), {
              volumes: bars.map((b) => b.v),
              lineColor: (p.chg24h || 0) >= 0 ? "#ff4fa3" : "#f87171",
              volColor: "#a78bfa",
              timeLabels: bars.filter((_, i) => i % Math.floor(bars.length / 3) === 0).slice(0, 3).map((b) => {
                const d = new Date(b.t * 60000);
                return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
              }),
            });
          }
        }
      },
    };
  }

  // ================= блок ИИ-сделки =================
  function aiBlock(sym) {
    const s = S();
    const live = s.mode === "live";
    const fresh = s._ai && s._ai.sym === sym && (Date.now() - s._ai.ts < 240000) ? s._ai : null;

    const head = `
      <div class="ai-head">
        <span class="ai-ico">${h.icon("sparkles", 17)}</span>
        <div style="min-width:0;flex:1">
          <div class="ai-title">Сделка на базе ИИ</div>
          <div class="ai-sub">ML-ансамбль 8 индикаторов · новости · учится на каждой сделке</div>
        </div>
        ${live ? "" : `<button class="ai-auto-pill ${s.aiAuto ? "on" : ""}" data-action="ai:auto" title="ИИ сам заходит в монеты и флипает">
          <span class="d"></span> автопилот ${s.aiAuto ? "вкл" : "выкл"}
        </button>`}
      </div>`;

    // ---- сессия автопилота: прогресс к авто-стопу ±лимит (по умолчанию 50%) ----
    let sessionHtml = "";
    const sess = Store.aiSessionInfo();
    const th = s.aiThreshold || 50;
    if (sess && (s.aiAuto || s.aiStop)) {
      const pct = Math.max(-th, Math.min(th, sess.pct));
      const markerPos = 50 + (pct / th) * 50;
      const n = sess.trades;
      const plural = (n % 10 === 1 && n % 100 !== 11) ? "ка" : ([2, 3, 4].indexOf(n % 10) !== -1 && (n % 100 < 10 || n % 100 >= 20)) ? "ки" : "ок";
      sessionHtml = `
      <div class="ai-session${s.aiStop ? " stopped" : ""}">
        <div class="row">
          <span>сессия ИИ · ${n} сдел${plural}${sess.open ? ` · ${sess.open} в рынке` : ""}</span>
          <span class="num ${sess.pct >= 0 ? "text-green" : "text-red"}">${sess.pct >= 0 ? "+" : "−"}${Math.abs(sess.pct).toFixed(2)}% · ${Fmt.fmtUsdSigned(sess.pnl)}</span>
          <span class="lim num">авто-стоп ±${th}%</span>
        </div>
        <div class="bar"><i class="m" style="left:${markerPos}%"></i><i class="z"></i></div>
      </div>`;
    }

    // ---- настройка лимита сессии: пресеты + свой ввод ----
    const presets = [10, 15, 25, 50, 75, 100];
    const limitHtml = `
      <div class="ai-limit-row">
        <span class="lbl">${h.icon("shield", 12)} стоп сессии</span>
        <div class="limit-chips">${presets.map((v) => `<button class="limit-chip num ${th === v ? "active" : ""}" data-action="ai:limit" data-arg="${v}">±${v}%</button>`).join("")}</div>
        <span class="custom-wrap">
          <input id="ai-limit-input" class="inp num" data-role="ai-limit" inputmode="numeric" placeholder="${th}" value="" title="Свой лимит сессии, % от 5 до 500">
          <span class="pct">%</span>
          <button class="limit-apply" data-action="ai:limit-apply" title="Применить свой лимит">OK</button>
        </span>
      </div>
      <div class="ai-limit-note">Курс ХРЮ = $1: при базе ${Fmt.fmtUsd(sess ? sess.startBase || 0 : 0)} лимит ±${th}% — это ±${Fmt.fmtUsd(sess ? (sess.startBase || 0) * th / 100 : 0)} к результату сессии. При его достижении автопилот закроет все ИИ-сделки по рынку и выключится.</div>`;

    // ---- авто-стоп сработал: баннер с причиной и возобновлением ----
    let stopHtml = "";
    if (s.aiStop) {
      const p = s.aiStop.pct;
      const sth = s.aiStop.threshold || th;
      stopHtml = `
      <div class="ai-stop-banner">
        <div class="t">${h.icon("shield", 14)} ${s.aiStop.reason === "profit" ? "Цель сессии достигнута — профит зафиксирован" : "Сработала защита от просадки"}</div>
        <div class="d">Результат ИИ-сессии <b class="num ${p >= 0 ? "text-green" : "text-red"}">${p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(2)}% (${Fmt.fmtUsdSigned(sess ? sess.pnl : 0)})</b> ${p >= 0 ? `≥ +${sth}%` : `≤ −${sth}%`} — автопилот закрыл все ИИ-сделки по рынку${s.aiStop.closed != null ? ` (${s.aiStop.closed} шт.)` : ""} и ждёт возобновления работы. Возобновите — начнётся новая сессия с чистой базой ±${sth}%.</div>
        <button class="ai-open" data-action="ai:auto">Возобновить автопилот · новая сессия</button>
      </div>`;
    }

    // ---- мини-статистика памяти ИИ ----
    const brain = s.aiBrain || {};
    const wr = brain.trades ? Math.round((brain.wins / brain.trades) * 100) : null;
    const brainMini = `<div class="ai-brain-mini num">${h.icon("cpu", 11)} опыт: ${brain.trades || 0} сделок${wr != null ? ` · винрейт ${wr}%` : ""} · порог входа ${brain.confThreshold || 76}% · память ${brain.weights ? "адаптирована" : "базовая"}</div>`;

    let body = "";
    if (!fresh) {
      body = `
        <button class="ai-cta" data-action="ai:analyze" data-arg="${sym}">${h.icon("sparkles", 14)} Проанализировать ${sym} и дать вердикт</button>
        <div class="ai-help">ИИ взвешивает тренд, RSI, MACD, Боллинджера, Ишимоку, объём, импульс и новостной фон,
        сам выбирает направление, стоп и цель. Только спот: «лонг» — тренд вверх, «шорт» — тренд вниз. Мощная защита:
        скам-фильтр, новостные риски и авто-стоп сессии ±${th}% (лимит настраивается ниже). После каждой закрытой сделки ИИ корректирует веса факторов —
        с каждой сделкой становится аккуратнее. ${live ? "В реальном режиме вердикт подскажет вход — ордер отправите кнопкой ниже." : "Автопилот может открывать и флипать сделки сам."}</div>`;
    } else {
      const r = fresh.res;
      if (r.verdict === "wait") {
        body = `
        <div class="ai-verdict">
          <div class="ai-v-head"><span class="ai-v-side" style="color:#d4cbd8">ожидание</span><span class="ai-v-sym">${sym} · 15м</span><span class="ai-conf-num">${r.confidence}%</span></div>
          <div class="ai-conf"><i style="width:${r.confidence}%"></i></div>
          <div class="ai-wait">ИИ не видит уверенного входа: ${h.esc(r.note)}.<br>Вход пропущен — капитал не рискует.</div>
          <div class="ai-ts"><span>${Fmt.fmtClock(fresh.ts)}</span><button class="link-btn" data-action="ai:analyze" data-arg="${sym}">пересчитать</button></div>
        </div>`;
      } else {
        const isLong = r.verdict === "лонг";
        const size = Math.max(200, Math.min(1000, Math.round(s.balance * 0.1)));
        const sizeStr = Fmt.fmtNum(Math.min(size, Math.max(0, Math.round(s.balance))));
        const factorRows = r.factors.map((f) => {
          const d = f.dir > 0 ? "up" : f.dir < 0 ? "down" : "flat";
          const arrow = f.dir > 0 ? "▲" : f.dir < 0 ? "▼" : "•";
          return `<div class="ai-factor"><span class="dir ${d}">${arrow}</span><span class="lbl">${h.esc(f.label)}</span><span class="det">${h.esc(f.detail)}</span></div>`;
        }).join("");
        body = `
        <div class="ai-verdict ${isLong ? "long" : "short"}">
          <div class="ai-v-head"><span class="ai-v-side">${r.verdict}</span><span class="ai-v-sym">${sym} · 15м</span><span class="ai-conf-num num">${r.confidence}%</span></div>
          <div class="ai-conf"><i style="width:${r.confidence}%"></i></div>
          <div class="ai-levels num">
            <div><div class="k">вход</div><div>${fmtPrice(r.price)}</div></div>
            <div><div class="k">стоп −${r.riskPct.toFixed(1)}%</div><div class="text-red">${fmtPrice(r.stop)}</div></div>
            <div><div class="k">цель +${r.targetPct.toFixed(1)}%</div><div class="text-green">${fmtPrice(r.target)}</div></div>
          </div>
          <div class="ai-factors">${factorRows}</div>
          ${live
            ? `<button class="ai-open" data-action="live:order-ai">Отправить рыночный ордер по сигналу ИИ</button>`
            : s.balance >= 200
              ? `<button class="ai-open" data-action="ai:open">Открыть ${r.verdict} по сигналу ИИ · ${sizeStr} ХРЮ (≈ ${Fmt.fmtUsd(Math.min(size, Math.max(0, Math.round(s.balance))))})</button>`
              : `<div class="ai-wait">Минимум для ИИ-сделки — 200 ХРЮ. Пополните демо-счёт в кабинете.</div>`}
          <div class="ai-ts"><span>расчёт ${Fmt.fmtClock(fresh.ts)} · RR 1:2 · спот · веса ИИ ${s.aiBrain && s.aiBrain.weights ? "адаптированы" : "базовые"}</span><button class="link-btn" data-action="ai:analyze" data-arg="${sym}">пересчитать</button></div>
        </div>`;
      }
    }

    return `<div class="ai-block">${head}${sessionHtml}${live ? "" : limitHtml}${stopHtml}${brainMini}${body}</div>`;
  }

  // ================= форма сделки (демо ХРЮ / реальный рынок) =================
  function tradeForm(defaultSym, compact) {
    const s = S();
    const f = s._form || (s._form = { sym: defaultSym, side: "лонг", size: "500", lev: 1 });
    if (defaultSym && !compact) f.sym = f.sym || defaultSym;

    // ---- реальный режим ----
    if (s.mode === "live") return liveForm(f);
    return demoForm(f, compact);
  }

  function demoForm(f, compact) {
    const s = S();
    const price = (s.prices[f.sym] && s.prices[f.sym].price) || 0;
    const sizeNum = Number(String(f.size).replace(",", ".")) || 0;
    const risk = price * 0.02;
    const stop = f.side === "лонг" ? price - risk : price + risk;
    const target = f.side === "лонг" ? price + risk * 2 : price - risk * 2;

    const syms = `<div class="chip-row scroll" style="margin-bottom:8px">` + DataLib.WATCHLIST.slice(0, 12).map((i) => `
      <button class="chip ${f.sym === i.sym ? "active" : ""}" style="padding:6px 10px;font-size:12px" data-action="form:sym" data-arg="${i.sym}">${h.coin(i.sym, 16)} ${i.sym}</button>`).join("") + `</div>`;

    return `<div class="tform">
      ${aiBlock(f.sym)}
      <div class="tform-head">
        <span class="tform-title">Новая демо-сделка</span>
        <span class="tform-free num">свободно ${Fmt.fmtNum(s.balance)} ХРЮ ≈ ${Fmt.fmtUsd(s.balance)}</span>
      </div>
      ${syms}
      <div class="seg2">
        <button class="seg-btn ${f.side === "лонг" ? "long-on" : ""}" data-action="form:side" data-arg="лонг">лонг · тренд вверх</button>
        <button class="seg-btn ${f.side === "шорт" ? "short-on" : ""}" data-action="form:side" data-arg="шорт">шорт · тренд вниз</button>
      </div>
      <div class="tform-row">
        <div class="inp-wrap">
          <input class="inp num" id="form-size" data-role="form-size" value="${h.esc(f.size)}" inputmode="decimal" style="padding-left:36px">
          <span class="inp-hru">${h.hru(13)}</span>
          <span class="inp-suffix">ХРЮ</span>
        </div>
      </div>
      <div class="tform-stats num">
        <div><div class="k">цена</div><div style="color:#d4d4d8">${fmtPrice(price)}</div></div>
        <div><div class="k">стоп −2%</div><div class="text-red">${fmtPrice(stop)}</div></div>
        <div><div class="k">цель +4%</div><div class="text-green">${fmtPrice(target)}</div></div>
      </div>
      <button class="btn-open ${f.side === "лонг" ? "long" : "short"}" data-action="form:submit">
        ${f.side === "лонг" ? "Открыть лонг" : "Открыть шорт"} · ${sizeNum ? Fmt.fmtNum(sizeNum) : "0"} ХРЮ${sizeNum ? ` (≈ ${Fmt.fmtUsd(sizeNum)})` : ""}
      </button>
      <p class="tform-note">Спот · без плеча · курс 1 ХРЮ = $1 — профит/убыток в хрювнах равен долларовому · исполнение по реальной рыночной цене</p>
    </div>`;
  }

  // форма реального рынка: кошелёк/ключи → рыночный ордер со счёта биржи
  function liveForm(f) {
    const s = S();
    const conn = window.Live ? Live.state.conn : null;
    const price = (s.prices[f.sym] && s.prices[f.sym].price) || 0;
    const usdt = Live.balanceUSDT();
    const sizeNum = Number(String(f.size).replace(",", ".")) || 0;

    const head = conn
      ? `<div class="tform-head">
          <span class="tform-title">Реальный ордер · спот</span>
          <span class="tform-free num" style="color:var(--accent-2)">${h.esc(conn.label)}</span>
        </div>
        <div class="live-bal num">баланс биржи: ${usdt != null ? Fmt.fmtNum(usdt, 2) + " USDT" : "читаю…"}</div>`
      : `<div class="tform-head">
          <span class="tform-title">Реальный рынок</span>
        </div>
        <div class="ai-wait" style="margin-top:0;margin-bottom:8px">Нет подключения. Средства хранятся у вас на бирже/в кошельке — платформа только отправляет ордера от вашего имени.</div>
        <button class="ai-cta" data-action="live:open">${h.icon("wallet", 14)} Подключить кошелёк или биржу</button>`;

    if (!conn) return `<div class="tform">${aiBlock(f.sym)}${head}</div>`;

    const syms = `<div class="chip-row scroll" style="margin-bottom:8px">` + DataLib.WATCHLIST.slice(0, 12).map((i) => `
      <button class="chip ${f.sym === i.sym ? "active" : ""}" style="padding:6px 10px;font-size:12px" data-action="form:sym" data-arg="${i.sym}">${h.coin(i.sym, 16)} ${i.sym}</button>`).join("") + `</div>`;

    return `<div class="tform">
      ${aiBlock(f.sym)}
      ${head}
      ${syms}
      <div class="seg2">
        <button class="seg-btn ${f.side === "лонг" ? "long-on" : ""}" data-action="form:side" data-arg="лонг">купить · лонг</button>
        <button class="seg-btn ${f.side === "шорт" ? "short-on" : ""}" data-action="form:side" data-arg="шорт">продать · выход</button>
      </div>
      <div class="tform-row">
        <div class="inp-wrap">
          <input class="inp num" id="form-size" data-role="form-size" value="${h.esc(f.size)}" inputmode="decimal" style="padding-left:12px">
          <span class="inp-suffix">USDT</span>
        </div>
      </div>
      <div class="tform-stats num">
        <div><div class="k">цена</div><div style="color:#d4d4d8">${fmtPrice(price)}</div></div>
        <div><div class="k">≈ объём</div><div style="color:#d4d4d8">${price && sizeNum ? fmtPrice(sizeNum / price) : "—"} ${f.sym}</div></div>
        <div><div class="k">тип</div><div style="color:#d4d4d8">маркет</div></div>
      </div>
      <button class="btn-open ${f.side === "лонг" ? "long" : "short"}" data-action="live:order">
        ${Live.ordersAllowed() ? `${f.side === "лонг" ? "Купить" : "Продать"} ${f.sym} · ${sizeNum ? Fmt.fmtNum(sizeNum) : "0"} USDT` : "Ордера запрещены — подтвердите риск"}
      </button>
      <p class="tform-note">Спот · без плеча · деньги на бирже, не на платформе · рыночный ордер по реальной цене</p>
    </div>`;
  }

  // ================= СДЕЛКИ =================
  // ================= моя статистика (мои демо-сделки) =================
  function myStatsBlock() {
    const s = S();
    const closed = s.userClosed;
    const wins = closed.filter((c) => c.pnl > 0);
    const losses = closed.filter((c) => c.pnl <= 0);
    const total = closed.reduce((sum, c) => sum + c.pnl, 0);
    const winrate = closed.length ? (wins.length / closed.length) * 100 : 0;
    const avg = closed.length ? total / closed.length : 0;
    const best = closed.length ? Math.max.apply(null, closed.map((c) => c.pnl)) : 0;
    const worst = closed.length ? Math.min.apply(null, closed.map((c) => c.pnl)) : 0;
    let unreal = 0, volume = 0, holdSum = 0;
    for (const p of s.userPositions) {
      const price = (s.prices[p.sym] && s.prices[p.sym].price) || p.entry;
      unreal += Engine.positionPnl(p, price).pnl;
      volume += p.size;
      holdSum += Date.now() - p.openedAt;
    }
    const heldMid = s.userPositions.length ? holdSum / s.userPositions.length / 60000 : 0;
    return `<div class="stat-grid cols4">
      ${h.statCard("Реализовано", h.hruAmount(total, true, total >= 0 ? "text-green" : "text-red"), "",
        closed.length ? `${closed.length} закрытых · ≈ ${Fmt.fmtUsdSigned(total)} · комиссия 0.1% учтена` : "нет закрытых сделок")}
      ${h.statCard("Винрейт", closed.length ? `${Math.round(winrate)}%` : "—", closed.length ? (winrate >= 50 ? "text-green" : "text-red") : "text-dim",
        closed.length ? `${wins.length} в плюс · ${losses.length} в минус` : "откройте первую сделку")}
      ${h.statCard("Средняя сделка", closed.length ? h.hruAmount(avg, true, avg >= 0 ? "text-green" : "text-red") : "—", "",
        closed.length ? `лучшая ${h.hruAmount(best, true)} · худшая ${h.hruAmount(worst, true)}` : "статистика появится после закрытия")}
      ${h.statCard("В рынке", h.hruAmount(unreal, true, unreal >= 0 ? "text-green" : "text-red"), "",
        `${s.userPositions.length} позиц. · объём ${Fmt.fmtNum(Math.round(volume))} ХРЮ ≈ ${Fmt.fmtUsd(Math.round(volume))}${s.userPositions.length ? ` · в среднем ${Fmt.fmtHeld(heldMid)}` : ""}`)}
    </div>`;
  }

  function trades() {
    const s = S();
    const tab = s._tradesTab || "user";
    const closed = tab === "user" ? s.userClosed : s.labClosed;

    const userPosRows = s.userPositions.length === 0
      ? `<div class="empty">Нет открытых сделок — откройте через форму справа или возьмите сигнал</div>`
      : `<div class="rows row-divide">` + s.userPositions.map((p) => {
          const price = (s.prices[p.sym] && s.prices[p.sym].price) || p.entry;
          const { pnl, pct } = Engine.positionPnl(p, price);
          return `<div class="trow" data-pos-sym="${p.sym}" data-pos-side="${p.side}" data-pos-entry="${p.entry}" data-pos-size="${p.size}" data-pos-lev="${p.lev || 1}">
            ${h.coin(p.sym, 36)}
            <div style="min-width:0;flex:1">
              <div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px">
                <span style="font-size:14px;font-weight:600">${p.sym}</span>
                ${h.sideTag(p.side)}
                ${p.strategy === "ai" ? h.tag("blue", p.ai && p.ai.auto ? "ИИ · автопилот" : "сигнал ИИ") : ""}
                ${h.tag("orange", "в работе")}
              </div>
              <div class="num" style="margin-top:2px;font-size:11.5px;color:#71717a">${Fmt.fmtNum(p.size)} ХРЮ · вход ${fmtPrice(p.entry)} · стоп ${fmtPrice(p.stop)} · цель ${fmtPrice(p.target)} · ${Fmt.fmtHeld((Date.now() - p.openedAt) / 60000)}</div>
            </div>
            <div class="row-right">
              <div data-pnl-main class="num ${pnl >= 0 ? "text-green" : "text-red"}" style="font-size:14.5px;font-weight:600">${h.hruAmount(pnl, true)} <span style="font-size:11px;opacity:.75">(${Fmt.fmtUsdSigned(pnl)})</span></div>
              <div data-pnl-pct class="num ${pct >= 0 ? "text-green" : "text-red"}" style="font-size:12px">${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(2)}%</div>
            </div>
            <button class="btn-close" data-action="pos:close" data-arg="${p.id}">Закрыть</button>
          </div>`;
        }).join("") + `</div>`;

    const labPosRows = s.labPositions.length === 0
      ? `<div class="empty">Движок ждёт подходящих условий по своим 5 стратегиям</div>`
      : `<div class="rows row-divide">` + s.labPositions.map((p) => {
          const price = (s.prices[p.sym] && s.prices[p.sym].price) || p.entry;
          const { pnl, pct } = Engine.positionPnl(p, price);
          const strat = Engine.STRATEGIES.find((x) => x.id === p.strategy);
          return `<div class="trow" data-pos-sym="${p.sym}" data-pos-side="${p.side}" data-pos-entry="${p.entry}" data-pos-size="${p.size}" data-pos-lev="${p.lev || 1}">
            ${h.coin(p.sym, 36)}
            <div style="min-width:0;flex:1">
              <div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px">
                <span style="font-size:14px;font-weight:600">${p.sym}</span>
                ${h.sideTag(p.side, p.lev)}
                ${h.tag("gray", strat ? strat.short : p.strategy)}
              </div>
              <div class="num" style="margin-top:2px;font-size:11.5px;color:#71717a">${Fmt.fmtNum(p.size)} ХРЮ · вход ${fmtPrice(p.entry)} · цель ${fmtPrice(p.target)} · ${Fmt.fmtHeld((Date.now() - p.openedAt) / 60000)}</div>
            </div>
            <div class="row-right">
              <div data-pnl-main class="num ${pnl >= 0 ? "text-green" : "text-red"}" style="font-size:14px;font-weight:600">${h.hruAmount(pnl, true)} <span style="font-size:10.5px;opacity:.75">(${Fmt.fmtUsdSigned(pnl)})</span></div>
              <div data-pnl-pct class="num ${pct >= 0 ? "text-green" : "text-red"}" style="font-size:11.5px">${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(2)}%</div>
            </div>
          </div>`;
        }).join("") + `</div>`;

    const closedRows = closed.length === 0
      ? `<div class="empty">Закрытых сделок пока нет</div>`
      : `<div class="rows row-divide">` + closed.slice(0, 12).map((c) => {
          const strat = Engine.STRATEGIES.find((x) => x.id === c.strategy);
          return `<div class="trow" style="padding-top:12px;padding-bottom:12px">
            ${h.coin(c.sym, 30)}
            <div style="min-width:0;flex:1">
              <div style="font-size:13px"><span style="font-weight:500">${c.sym}</span> <span style="color:#71717a">${c.side} · ${Fmt.fmtNum(c.size)} ХРЮ · ${c.strategy === "ai" ? (c.ai && c.ai.auto ? "ИИ · автопилот" : "сигнал ИИ") : strat ? strat.short : "вручную"}</span></div>
              <div class="num" style="font-size:11.5px;color:#52525b">${fmtPrice(c.entry)} → ${fmtPrice(c.exit)} · держали ${Fmt.fmtHeld((c.closedAt - c.openedAt) / 60000)}</div>
            </div>
            ${h.tag(c.exitReason === "Стоп" ? "red" : c.exitReason === "Цель" ? "green" : "gray", c.exitReason)}
            <div style="width:104px;text-align:right">
              <div class="num ${c.pnl >= 0 ? "text-green" : "text-red"}" style="font-size:13.5px;font-weight:500">${h.hruAmount(c.pnl, true)}</div>
              <div style="font-size:11px;color:#52525b">${ago(c.closedAt)}</div>
            </div>
          </div>`;
        }).join("") + `</div>`;

    const html = `
    <div class="stack">
      <div>
        <h1 class="page-title">Сделки</h1>
        <p class="page-sub">Демо-торговля хрювнами по реальным ценам · открытых: ${s.userPositions.length + s.labPositions.length}</p>
      </div>
      ${myStatsBlock()}
      <div class="trades-grid">
        <div class="stack-16">
          <section class="card">
            <div style="padding:12px 20px;border-bottom:1px solid var(--border);font-size:13.5px;font-weight:500;color:#d4d4d8">Мои демо-позиции · ${s.userPositions.length}</div>
            ${userPosRows}
          </section>

          <section class="card">
            <div style="padding:12px 20px;border-bottom:1px solid var(--border);font-size:13.5px;font-weight:500;color:#d4d4d8">Позиции лаборатории · ${s.labPositions.length}</div>
            ${labPosRows}
          </section>

          <section class="card">
            <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:12px 20px;border-bottom:1px solid var(--border)">
              <div style="display:flex;align-items:center;gap:8px">
                ${h.tfBar(tab === "user" ? "мои" : "лаборатория", "trades:tab", ["мои", "лаборатория"])}
                <span class="num" style="font-size:12px;color:#71717a">· ${closed.length}</span>
              </div>
              <div style="display:flex;align-items:center;gap:10px">
                <span style="font-size:11.5px;color:#52525b">прибыль после условной комиссии 0.1%</span>
                ${tab === "user" && s.userClosed.length ? `<button class="btn-ghost" style="padding:5px 10px;font-size:11.5px" data-action="stats:export" title="Скачать историю сделок в CSV">${h.icon("download", 12)} CSV</button>` : ""}
              </div>
            </div>
            ${closedRows}
          </section>

          ${s.mode === "live" ? liveOrdersCard() : ""}
        </div>
        <aside>${tradeForm("BTC", false)}</aside>
      </div>
    </div>`;
    return { html, mount() {} };
  }

  // ================= реальные ордера (заготовка) =================
  function liveOrdersCard() {
    const s = S();
    const rows = s.liveOrders.length === 0
      ? `<div class="empty">Реальных ордеров ещё не было — отправьте первый из формы справа</div>`
      : `<div class="rows row-divide">` + s.liveOrders.slice(0, 8).map((o) => `
          <div class="trow">
            ${h.coin(o.sym ? o.sym.replace("USDT", "") : "BTC", 30)}
            <div style="min-width:0;flex:1">
              <div style="font-size:13px"><span style="font-weight:500">${o.sym}</span> <span class="${o.side === "лонг" ? "text-green" : "text-red"}">${o.side === "лонг" ? "BUY" : "SELL"} · маркет</span> <span style="color:#71717a">· ${Fmt.fmtNum(Math.round(o.amountUSDT))} USDT</span></div>
              <div class="num" style="font-size:11.5px;color:#52525b">${o.exchange} · ${Fmt.fmtClock(o.ts)}${o.note ? " · " + h.esc(o.note) : ""}</div>
            </div>
            ${h.tag("blue", "отправлен")}
          </div>`).join("") + `</div>`;
    return `
    <section class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 20px;border-bottom:1px solid var(--border)">
        <span style="font-size:13.5px;font-weight:500;color:#d4d4d8">Реальные ордера · спот</span>
        <span class="num" style="font-size:11.5px;color:#71717a">${Live.ordersAllowed() ? "отправка разрешена" : "отправка запрещена (подтвердите риск)"}</span>
      </div>
      ${rows}
    </section>`;
  }

  // ================= модалка «Реальный рынок» =================
  function liveModal() {
    const s = S();
    const st = window.Live ? Live.state : { conn: null, riskAccepted: false, ordersEnabled: false, connecting: false, lastError: null };
    const sel = s._liveEx || "binance";
    const ex = (window.Live ? Live.EXCHANGES : []).find((e) => e.id === sel) || { id: "binance", name: "Binance", needsPass: false, note: "" };
    const conn = st.conn;

    const statusHtml = conn
      ? `<div class="lm-conn ok">
          <span class="online-dot"></span>
          <div style="min-width:0;flex:1">
            <div style="font-weight:600;font-size:13.5px">Подключено: ${h.esc(conn.label)}</div>
            <div style="font-size:11.5px;color:#8d8098">${h.esc(conn.detail)}${conn.balanceUSDT != null ? ` · ${Fmt.fmtNum(conn.balanceUSDT, 2)} USDT` : ""}</div>
          </div>
          <button class="btn-ghost" data-action="live:disconnect">Отключить</button>
        </div>`
      : `<div class="lm-conn">${h.icon("lock", 14)}<span style="font-size:12.5px;color:#8d8098">Нет активного подключения — выберите способ ниже</span></div>`;

    const walletCard = `
      <div class="lm-card">
        <div class="lm-card-head">${h.icon("wallet", 16)} Крипто-кошелёк</div>
        <p class="lm-note">MetaMask / Rabby / OKX Wallet. Адрес, сеть и баланс USDT читаются прямо в браузере; сделки — через смарт-контракты DEX (шаг 2 интеграции).</p>
        <button class="lm-btn" data-action="live:wallet" ${st.connecting ? "disabled" : ""}>${st.connecting ? "Подключаю…" : "Подключить кошелёк"}</button>
      </div>`;

    const keysCard = `
      <div class="lm-card">
        <div class="lm-card-head">${h.icon("lock", 16)} Ключи биржи</div>
        <div class="lm-tabs">${(window.Live ? Live.EXCHANGES : [{ id: "binance", name: "Binance" }, { id: "bybit", name: "Bybit" }, { id: "okx", name: "OKX" }]).map((e) => `
          <button class="chip ${e.id === sel ? "active" : ""}" style="padding:5px 12px;font-size:12px" data-action="live:ex" data-arg="${e.id}">${e.name}</button>`).join("")}</div>
        <input class="auth-inp lm-inp" id="live-key" placeholder="API key" autocomplete="off">
        <input class="auth-inp lm-inp" id="live-secret" type="password" placeholder="Secret" autocomplete="off">
        ${ex.needsPass ? `<input class="auth-inp lm-inp" id="live-pass" type="password" placeholder="Passphrase (OKX)" autocomplete="off">` : ""}
        <div class="lm-exnote">${h.esc(ex.note)}</div>
        <button class="lm-btn" data-action="live:keys">Проверить ключи и подключить</button>
      </div>`;

    const riskHtml = `
      <div class="lm-risk">
        <div class="lm-card-head">${h.icon("shield", 16)} Безопасность</div>
        <p class="lm-note">Деньги не хранятся на платформе — они остаются на вашей бирже/в кошельке. Ключи сохраняются
        только в этом браузере и шлются напрямую на биржу. Рыночные спот-ордера без плеча.</p>
        <label class="lm-check"><input type="checkbox" id="live-risk" ${st.riskAccepted ? "checked" : ""} data-action="live:risk">
          Я понимаю риски реальной торговли и подтверждаю, что торгую собственными средствами</label>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px">
          <span style="font-size:12px;color:#8d8098">Отправка ордеров:</span>
          <button class="toggle-pill ${st.ordersEnabled ? "active" : ""}" data-action="live:orders-toggle">${st.ordersEnabled ? "разрешена" : "запрещена"}</button>
        </div>
      </div>`;

    return `
    <div>
      <div class="cab-head">
        <span class="cab-icon" style="background:rgba(255,45,120,.15);color:var(--accent-2)">${h.icon("candles", 22)}</span>
        <div>
          <h2 class="cab-title">Реальный рынок · подключение</h2>
          <p class="cab-sub">Тумблер «Демо / Реальный» в сайдбаре переключает режимы · демо-ХРЮ не тратятся</p>
        </div>
      </div>
      <div class="cab-body" style="display:flex;flex-direction:column;gap:12px">
        ${statusHtml}
        ${conn ? "" : `<div class="lm-grid">${walletCard}${keysCard}</div>`}
        ${riskHtml}
        ${st.lastError ? `<div class="auth-error" style="margin:0">${h.esc(st.lastError)}</div>` : ""}
      </div>
      <div class="cab-foot">
        <p>Дорожная карта реальной торговли: 1) подключение — готово ✓ · 2) чтение баланса — готово ✓ ·
        3) подписанные рыночные ордера Binance/Bybit/OKX — готово ✓ · 4) DEX-смарт-контракты и трекинг позиций — следующий шаг.</p>
        <button class="btn-ghost" data-action="modal:close">Закрыть</button>
      </div>
    </div>`;
  }

  // ================= СЧЕТА =================
  function accounts() {
    const s = S();
    const cards = s.labAccounts.map((a) => {
      const pct = (a.balance / a.start - 1) * 100;
      const pos = s.labPositions.filter((p) => p.account === a.id);
      const unreal = pos.reduce((sum, p) => sum + Engine.positionPnl(p, (s.prices[p.sym] && s.prices[p.sym].price) || p.entry).pnl, 0);
      const closed = s.labClosed.filter((c) => c.account === a.id);
      const wins = closed.filter((c) => c.pnl > 0).length;
      const strat = Engine.STRATEGIES.find((x) => x.id === a.strategy);
      const posRows = pos.length > 0 ? `<div class="acc-pos">` + pos.map((p) => {
        const price = (s.prices[p.sym] && s.prices[p.sym].price) || p.entry;
        const { pnl } = Engine.positionPnl(p, price);
        return `<div class="acc-pos-row num">
          <span style="font-weight:500;color:#e4e4e7">${p.sym}</span>
          <span style="color:#71717a">вход ${fmtPrice(p.entry)}</span>
          <span class="${pnl >= 0 ? "text-green" : "text-red"}" style="margin-left:auto">${h.hruAmount(pnl, true)}</span>
        </div>`;
      }).join("") + `</div>` : "";

      return `<section class="card card-pad">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
          <div>
            <div style="display:flex;align-items:center;gap:8px">
              <span style="font-size:14.5px;font-weight:600">${h.esc(a.name)}</span>
              ${a.isProtected ? h.tag("gray", "ЗАЩ") : ""}
            </div>
            <div style="margin-top:2px;font-size:11.5px;color:#71717a">${strat ? strat.desc : ""} · ${strat ? strat.tf : "15м"}</div>
          </div>
          <div class="row-right">
            <div class="num ${pct >= 0 ? "text-green" : "text-red"}" style="font-size:18px;font-weight:600">${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(2)}%</div>
            <div class="num" style="font-size:12px;color:#71717a">${Fmt.fmtNum(Math.round(a.balance + unreal))} ХРЮ</div>
          </div>
        </div>
        <div class="eq-chart" data-eq="${a.id}" style="margin-top:12px;height:74px"></div>
        <div class="mini-stats num">
          <div><div class="k">в рынке</div><div class="v">${pos.length}</div></div>
          <div><div class="k">закрыто</div><div class="v">${closed.length}</div></div>
          <div><div class="k">винрейт</div><div class="v">${closed.length ? Math.round((wins / closed.length) * 100) : "—"}%</div></div>
        </div>
        ${posRows}
      </section>`;
    }).join("");

    const html = `
    <div class="stack">
      <div class="page-head" style="flex-wrap:wrap">
        <div>
          <h1 class="page-title">Счета</h1>
          <p class="page-sub">Каждый счёт торгует свою стратегию на реальных свечах Binance · старт 10 000 ХРЮ</p>
        </div>
        <button class="btn-autotrade ${s.autoTrade ? "on" : ""}" data-action="account:auto">${s.autoTrade ? "Автоторговля: вкл" : "Автоторговля: выкл"}</button>
      </div>
      <div class="acc-grid">${cards}</div>
      <section class="card card-pad">
        ${h.sectionTitle("Как устроена лаборатория", `<span style="display:flex;align-items:center;gap:8px;font-size:12px;color:#71717a">${h.onlineDot()} работает на 15м свечах</span>`)}
        <p style="font-size:12.5px;line-height:1.7;color:#71717a">
          Каждый счёт получает стартовые 10 000 ХРЮ и торгует ровно одну стратегию: на сигнал движка открывает лонг
          размером ~10% баланса, стоп — 1.2×ATR, цель — 2R. По умолчанию автоторговля выключена: сделки открываете
          только вы — аккаунты David и Yura (форма на Рынке, сигнал ИИ или кнопка «Взять в демо» в Сигналах).
          Если включить тумблер сверху, счета лаборатории начнут торговать сами. Результаты считаются по реальным
          свечам Binance — валюта виртуальная, поэтому экспериментировать безопасно.
        </p>
      </section>
    </div>`;

    return {
      html,
      mount() {
        for (const a of s.labAccounts) {
          const el = document.querySelector(`[data-eq="${a.id}"]`);
          if (el) Charts.equity(el, a.equityHist.length > 1 ? a.equityHist : [a.start, a.balance]);
        }
      },
    };
  }

  // ================= ПОРТФЕЛЬ =================
  function portfolio() {
    const s = S();
    const equity = Store.totalEquity();
    const inTrades = s.userPositions.reduce((a, p) => a + p.size, 0);
    const inTradesPct = equity > 0 ? Math.round((inTrades / equity) * 100) : 0;
    const unreal = s.userPositions.reduce((a, p) => a + Engine.positionPnl(p, (s.prices[p.sym] && s.prices[p.sym].price) || p.entry).pnl, 0);
    const realized = s.userClosed.reduce((a, c) => a + c.pnl, 0);
    const wins = s.userClosed.filter((c) => c.pnl > 0).length;
    let peak = -Infinity, maxDd = 0;
    for (const pt of s.equityHist) {
      peak = Math.max(peak, pt.v);
      maxDd = Math.min(maxDd, (pt.v / peak - 1) * 100);
    }

    const posRows = s.userPositions.length === 0
      ? `<div class="empty">Позиций нет — торговайте на Рынке или берите сигналы движка</div>`
      : `<div class="rows row-divide">` + s.userPositions.map((p) => {
          const price = (s.prices[p.sym] && s.prices[p.sym].price) || p.entry;
          const { pnl, pct } = Engine.positionPnl(p, price);
          const spark = [];
          for (let i = 0; i < 12; i++) {
            const x = i / 11;
            spark.push(p.entry + (price - p.entry) * Math.pow(x, 1.3));
          }
          return `<div class="row" style="flex-wrap:wrap" data-pos-sym="${p.sym}" data-pos-side="${p.side}" data-pos-entry="${p.entry}" data-pos-size="${p.size}" data-pos-lev="${p.lev || 1}">
            ${h.coin(p.sym, 34)}
            <div style="min-width:0;flex:1">
              <div style="font-size:13.5px;font-weight:600">${p.sym} <span style="font-size:11px;color:#71717a">${p.side}${p.strategy === "ai" && p.ai && p.ai.auto ? " · ИИ-автопилот" : p.strategy === "ai" ? " · ИИ" : ""}</span></div>
              <div class="num" style="font-size:11.5px;color:#71717a">${Fmt.fmtNum(p.size)} ХРЮ · ${fmtPrice(p.entry)} → <span data-pnl-price>${fmtPrice(price)}</span></div>
            </div>
            <div style="width:110px;text-align:right">
              <span data-pnl-main class="num ${pnl >= 0 ? "text-green" : "text-red"}" style="font-size:13.5px;font-weight:500">${h.hruAmount(pnl, true)} <span style="font-size:11px;opacity:.75">(${Fmt.fmtUsdSigned(pnl)})</span></span>
              <span data-pnl-pct class="num block ${pct >= 0 ? "text-green" : "text-red"}" style="font-size:11.5px">${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(2)}%</span>
            </div>
            ${Charts.spark(spark, { w: 70, h: 24, color: pct >= 0 ? "#ff4fa3" : "#f87171" })}
            <button class="btn-close" data-action="pos:close" data-arg="${p.id}">Закрыть</button>
          </div>`;
        }).join("") + `</div>`;

    const donut = Charts.donut(
      [{ value: Math.max(1, inTradesPct), color: "#f5c542" }, { value: Math.max(0, 100 - inTradesPct), color: "#ff2d78" }],
      `<div style="font-size:11px;color:#71717a">в сделках</div><div class="num" style="font-size:18px;font-weight:600">${inTradesPct}%</div>`
    );

    const html = `
    <div class="stack-16">
      <div class="page-head">
        <h1 class="page-title">Портфель</h1>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="num hidden-sm" style="display:flex;align-items:center;gap:6px;border-radius:999px;background:rgba(255,255,255,.05);padding:6px 12px;font-size:13px">${h.hru(13)} ${Fmt.fmtNum(equity)} ХРЮ</span>
          <button class="btn-lime" style="width:auto;margin:0;padding:8px 16px" data-action="cabinet:open">Кабинет · пополнить</button>
        </div>
      </div>

      <section class="card" style="padding:20px">
        <div>
          <div style="font-size:13px;color:#71717a">Демо-кошелёк · хрювны (курс 1 ХРЮ = $1)</div>
          <div class="port-big num">${Fmt.fmtNum(equity)} ${h.hru(22)} <span style="font-size:15px;color:#a1a1aa;font-weight:500">≈ ${Fmt.fmtUsd(equity)}</span></div>
          <div class="num" style="margin-top:8px;font-size:13px">
            <span class="${equity >= s.startBalance ? "text-green" : "text-red"}">${equity >= s.startBalance ? "+" : "−"}${Fmt.fmtNum(Math.abs(equity - s.startBalance))} ХРЮ (${equity >= s.startBalance ? "+" : "−"}${Fmt.fmtUsd(Math.abs(equity - s.startBalance))})</span>
            <span style="color:#71717a"> · старт ${Fmt.fmtNum(s.startBalance)} ХРЮ ≈ ${Fmt.fmtUsd(s.startBalance)}</span>
          </div>
        </div>
        <div style="margin-top:12px;display:flex;align-items:center;gap:16px;font-size:12px">
          <span style="display:flex;align-items:center;gap:6px;color:#a1a1aa"><span class="legend-line"></span> Эквити демо-счёта</span>
        </div>
        ${s.equityHist.length > 1
          ? `<div id="portfolio-chart" style="margin-top:8px;height:200px"></div>`
          : `<div style="margin-top:8px;display:flex;height:200px;align-items:center;justify-content:center;background:rgba(255,255,255,.02);border-radius:12px;font-size:12.5px;color:#52525b">График эквити строится каждые 30 секунд — скоро здесь будет история</div>`}
      </section>

      <div class="port-stats">
        <div class="stat-card"><div class="stat-label">Свободно</div><div class="num" style="margin-top:4px;font-size:21px;font-weight:600" ><span class="text-gold">${Fmt.fmtNum(Math.round(s.balance))}</span></div><div class="stat-sub num">ХРЮ на балансе</div></div>
        <div class="stat-card"><div class="stat-label">Нереализовано</div><div class="num ${unreal >= 0 ? "text-green" : "text-red"}" style="margin-top:4px;font-size:21px;font-weight:600">${unreal >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(unreal)))}</div><div class="stat-sub num">${s.userPositions.length} поз. в рынке</div></div>
        <div class="stat-card"><div class="stat-label">Реализовано</div><div class="num ${realized >= 0 ? "text-green" : "text-red"}" style="margin-top:4px;font-size:21px;font-weight:600">${realized >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(realized)))}</div><div class="stat-sub num">${s.userClosed.length} закрытых сделок</div></div>
        <div class="stat-card"><div class="stat-label">Винрейт</div><div class="num" style="margin-top:4px;font-size:21px;font-weight:600">${s.userClosed.length ? Math.round((wins / s.userClosed.length) * 100) + "%" : "—"}</div><div class="stat-sub num">${wins} из ${s.userClosed.length} в плюсе</div></div>
        <div class="stat-card"><div class="stat-label">Худшая просадка</div><div class="num ${maxDd < 0 ? "text-red" : ""}" style="margin-top:4px;font-size:21px;font-weight:600">${maxDd.toFixed(2)}%</div><div class="stat-sub">по истории эквити</div></div>
      </div>

      <div class="port-grid">
        <section class="card card-pad">
          ${h.sectionTitle(`Открытые позиции · ${s.userPositions.length}`, `<span style="font-size:12.5px;color:#a1a1aa">закрытие по рыночной цене</span>`)}
          ${posRows}
        </section>

        <aside class="card" style="padding:20px">
          ${h.sectionTitle("Где деньги")}
          <div style="display:flex;justify-content:center;padding:12px 0">${donut}</div>
          <div class="donut-legend">
            <div class="lr"><span style="display:flex;align-items:center;gap:8px;color:#a1a1aa"><span class="sw" style="background:#f5c542"></span> В позициях</span><span class="num" style="color:#e4e4e7">${Fmt.fmtNum(Math.round(inTrades))} ХРЮ</span></div>
            <div class="lr"><span style="display:flex;align-items:center;gap:8px;color:#a1a1aa"><span class="sw" style="background:#ff2d78"></span> Свободно</span><span class="num" style="color:#e4e4e7">${Fmt.fmtNum(Math.round(s.balance))} ХРЮ</span></div>
          </div>
          <div class="info-box">
            ХРЮ — виртуальная валюта с курсом 1:1 к доллару: 10 000 ХРЮ = $10 000, профит/убыток в хрювнах
            равен долларовому. Сделка списывает хрювны со счёта, закрытие возвращает их с результатом (комиссия 0.1% учтена).
            В режиме «Реальный рынок» деньги не попадают на платформу — они остаются на вашей бирже/в кошельке,
            а платформа только отправляет подписанные рыночные ордера от вашего имени.
          </div>
        </aside>
      </div>
    </div>`;

    return {
      html,
      mount() {
        if (s.equityHist.length > 1) {
          const el = document.getElementById("portfolio-chart");
          if (el) Charts.lineVolume(el, s.equityHist.map((p) => p.v), { lineColor: "#f5c542" });
        }
      },
    };
  }

  // ================= КАБИНЕТ (модалка) =================
  function cabinet() {
    const s = S();
    const wins = s.userClosed.filter((c) => c.pnl > 0).length;
    const totalPnl = s.userClosed.reduce((a, c) => a + c.pnl, 0);
    return `
    <div>
      <div class="cab-head">
        <span class="cab-icon">${h.hru(26)}</span>
        <div>
          <h2 class="cab-title">Кабинет · демо-торговля</h2>
          <p class="cab-sub">Виртуальные хрювны · курс 1 ХРЮ = $1 · реальные цены Binance</p>
        </div>
      </div>
      <div class="cab-body">
        <div style="font-size:12.5px;color:#71717a">Текущий баланс</div>
        <div class="cab-balance num">${Fmt.fmtNum(s.balance)} ${h.hru(20)} <span class="cur">ХРЮ</span></div>
        <div class="num" style="margin-top:4px;font-size:13px;color:#a1a1aa">≈ ${Fmt.fmtUsd(s.balance)} · курс ХРЮ привязан к доллару 1:1 — профит/убыток в хрювнах равен долларовому</div>
        <div style="margin-top:16px">
          <label style="font-size:12.5px;color:#a1a1aa" for="hru-input">Впишите любую сумму хрювен на демо-счёт</label>
          <div style="margin-top:6px;display:flex;gap:8px">
            <div class="cab-inp-wrap">
              <input id="hru-input" class="cab-inp num" data-role="cab-balance" inputmode="decimal" placeholder="10 000" value="${Fmt.fmtNum(Math.round(s.balance))}">
              <span style="position:absolute;left:12px;top:10px;opacity:.7">${h.hru(16)}</span>
              <span style="position:absolute;right:12px;top:10px;font-size:12px;font-weight:500;color:#71717a">ХРЮ</span>
            </div>
            <button class="cab-apply" data-action="cabinet:apply">Выставить</button>
          </div>
          <div class="cab-presets">
            ${[1000, 10000, 50000, 100000].map((v) => `<button class="cab-preset num" data-action="cabinet:preset" data-arg="${v}">${Fmt.fmtNum(v)}</button>`).join("")}
          </div>
        </div>
      </div>
      <div class="cab-stats">
        <div><div class="num v">${s.userClosed.length}</div><div class="k">сделок</div></div>
        <div><div class="num v">${s.userClosed.length ? Math.round((wins / s.userClosed.length) * 100) : 0}%</div><div class="k">винрейт</div></div>
        <div><div class="num v ${totalPnl >= 0 ? "text-green" : "text-red"}">${totalPnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(totalPnl)))}</div><div class="k">реализовано ХРЮ</div></div>
        <div><div class="num v">${s.userPositions.length}</div><div class="k">в рынке</div></div>
      </div>
      <div class="cab-foot">
        <p>Стартовый баланс: ${Fmt.fmtNum(s.startBalance)} ХРЮ. Выгода и убытки считаются по реальным рыночным ценам — но это виртуальные деньги, реальные средства не задействованы.</p>
        <div style="display:flex;gap:8px;flex-shrink:0">
          ${s.userClosed.length ? `<button class="btn-ghost" data-action="stats:export" title="Скачать историю сделок в CSV">${h.icon("download", 13)} CSV</button>` : ""}
          <button class="btn-ghost" data-action="cabinet:reset">Сбросить</button>
        </div>
      </div>
    </div>`;
  }

  // ================= УВЕДОМЛЕНИЯ (модалка настроек push + полный экран PWA) =================
  function nrRow(action, id, label, desc, on) {
    return `<button class="notify-row ${on ? "on" : ""}" data-action="${action}" data-arg="${id}" role="switch" aria-checked="${on ? "true" : "false"}">
      <span class="nr-txt"><span class="nr-l">${h.esc(label)}</span><span class="nr-d">${h.esc(desc)}</span></span>
      <span class="nr-sw"><i></i></span>
    </button>`;
  }

  function notifyModal() {
    if (!window.Notify) return "<div style=\"padding:20px\">Модуль уведомлений не загружен</div>";
    const st = Notify.getSettings();
    const perm = Notify.permission();
    const iosFix = Notify.iosNeedsInstall();
    const fsOn = Boolean(Notify.fsElement());
    const canAsk = Notify.supported() && !iosFix;

    const permBadge = {
      granted: '<span class="np-ok">разрешение выдано</span>',
      default: '<span class="np-warn">разрешение не запрошено</span>',
      denied: '<span class="np-bad">разрешение заблокировано в браузере</span>',
      unsupported: '<span class="np-bad">браузер не поддерживает уведомления</span>',
    }[perm];

    const master = !canAsk
      ? `<div class="notify-master"><div class="nm-state"><b>Системные уведомления недоступны здесь.</b>${iosFix
          ? " На iPhone/iPad сначала добавьте XenoAI Trade на экран «Домой» (кнопка «Поделиться» → «На экран Домой»), затем включите уведомления уже в установленном приложении — так требует iOS 16.4+."
          : " Откройте платформу по https или localhost."}</div></div>`
      : st.on
        ? `<div class="notify-master">
            <div class="nm-state"><b>Уведомления включены</b> · ${permBadge}</div>
            <button class="btn-ghost" data-action="notify:master">Выключить</button>
          </div>`
      : perm === "denied"
        ? `<div class="notify-master">
            <div class="nm-state">${permBadge} — разрешите уведомления для этого сайта в настройках браузера (значок замка слева в адресной строке), затем нажмите «Повторить»</div>
            <button class="btn-ghost" data-action="notify:master">Повторить</button>
          </div>`
        : `<div class="notify-master">
            <div class="nm-state">Готово к включению · ${permBadge}</div>
            <button class="btn-lime" data-action="notify:master">Включить уведомления</button>
          </div>`;

    const eventsHtml = Notify.EVENTS.map(([id, l, d]) => nrRow("notify:ev", id, l, d, st.events[id])).join("");

    const minpnlPresets = [0, 10, 25, 50, 100];
    const filterHtml = `
      <div class="ai-limit-row">
        <span class="lbl">${h.icon("swap", 12)} порог закрытий</span>
        <div class="limit-chips">${minpnlPresets.map((v) => `<button class="limit-chip num ${st.minPnl === v ? "active" : ""}" data-action="notify:minpnl" data-arg="${v}">${v === 0 ? "все" : "≥ " + v}</button>`).join("")}</div>
        <span class="custom-wrap">
          <input id="notify-minpnl" class="inp num" data-role="notify-minpnl" inputmode="numeric" placeholder="0" value="${st.minPnl || ""}" title="Свой порог профита/минуса в ХРЮ">
          <span class="pct">ХРЮ</span>
          <button class="limit-apply" data-action="notify:minpnl-apply" title="Применить свой порог">OK</button>
        </span>
      </div>
      <div class="ai-limit-note">Курс 1 ХРЮ = $1: порог 25 — присылать закрытия только с профитом или минусом от $25, более мелкие пропускать. Порог применяется к сделкам ИИ, вашим сделкам, флипам и авто-стопу сессии.</div>`;

    const extraHtml = [
      nrRow("notify:opt", "sound", "Звук", "системный звук уведомления", st.sound),
      nrRow("notify:opt", "vibro", "Вибрация", "вибросигнал вместе с уведомлением (Android)", st.vibro),
      nrRow("notify:opt", "quiet", "Тишина на экране", "не беспокоить, когда приложение открыто на переднем плане", st.quiet),
    ].join("");

    const actionsHtml = `
      <div class="notify-actions">
        <button class="btn-ghost" data-action="notify:test" ${st.on && perm === "granted" ? "" : "disabled"} title="Показать пробное системное уведомление">${h.icon("radio", 13)} Проверить уведомление</button>
        ${Notify.fsSupported() ? `<button class="btn-ghost" data-action="fs:toggle"><span class="fs-icon">${h.icon(fsOn ? "minimize" : "maximize", 13)}</span> ${fsOn ? "Выйти из полного экрана" : "Во весь экран"}</button>` : ""}
      </div>
      <div class="notify-install">
        <b>Установить как приложение:</b> Android · Chrome — меню ⋮ → «Установить приложение»; iPhone/iPad · Safari — «Поделиться» → «На экран Домой»; macOS · Safari — «Файл» → «Добавить в Dock», Chrome — значок установки в адресной строке. В установленном приложении XenoAI Trade открывается на весь экран — без адресной строки и системных панелей (на Android скрываются и статус-бар, и кнопки навигации).
      </div>`;

    return `
    <div>
      <div class="cab-head">
        <span class="cab-icon" style="background:rgba(255,45,120,0.13)">${h.icon("bell", 22)}</span>
        <div>
          <h2 class="cab-title">Уведомления и приложение</h2>
          <p class="cab-sub">push-оповещения о сделках ИИ · полный экран PWA</p>
        </div>
      </div>
      <div class="cab-body">
        ${master}
        <div class="notify-sec">О чём присылать</div>
        ${eventsHtml}
        <div class="notify-sec">Фильтр мелких сделок</div>
        ${filterHtml}
        <div class="notify-sec">Режим доставки</div>
        ${extraHtml}
        ${actionsHtml}
      </div>
    </div>`;
  }

  return { market, trades, accounts, portfolio, tradeForm, cabinet, liveModal, liveOrdersCard, aiBlock, notifyModal };
})();

window.ViewsTrade = ViewsTrade;
