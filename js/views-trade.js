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

    // лента китов под графиком (у GRAM она обычная биржевая — TON/USDT)
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
                ${s.degraded ? h.tag("orange", "торговля стоит · цены заморожены") : ""}
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
          <div class="ai-sub">ансамбль 13 факторов · ADX, HTF, киты, GLM · учится на каждой сделке</div>
        </div>
        <button class="ai-auto-pill ${s.mode === "live" ? (s.aiAutoLive ? "on" : "") : (s.aiAuto ? "on" : "")}" data-action="ai:auto" title="${s.mode === "live" ? "В реальном режиме автопилот по умолчанию выключен — включается только явно" : "ИИ сам заходит в монеты и флипает"}">
          <span class="d"></span> автопилот ${s.mode === "live" ? (s.aiAutoLive ? "вкл · симуляция" : "выкл") : (s.aiAuto ? "вкл" : "выкл")}
        </button>
      </div>`;

    // ---- сессия автопилота: прогресс к авто-стопу ±лимит (по умолчанию 50%) ----
    let sessionHtml = "";
    // пауза после серии минусов: честно показываем состояние и сколько осталось
    const pauseMs = (s.aiCooldownUntil || 0) - Date.now();
    const pauseHtml = pauseMs > 0
      ? `<div class="ai-limit-note" style="border:1px solid rgba(248,113,113,.35);border-radius:10px;padding:8px 12px;color:#fca5a5">${h.icon("shield", 12)} Автопилот на паузе после серии минусов — новые входы через ~${Math.max(1, Math.round(pauseMs / 60000))} мин. Открытые позиции обслуживаются (стопы, цели, безубыток), идеи и сигналы продолжают обновляться. Очистка истории сделок в «Сделках» снимает серию и возвращает автопилот к работе сразу.</div>`
      : "";
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
      <div class="ai-limit-note">Курс ХРЮ = $1: при базе ${Fmt.fmtUsd(sess ? sess.startBase || 0 : 0)} лимит ±${th}% — это ±${Fmt.fmtUsd(sess ? (sess.startBase || 0) * th / 100 : 0)} к результату сессии. При его достижении автопилот закроет все ИИ-сделки по рынку и выключится. Это аварийная граница ВСЕЙ сессии, а НЕ ширина стопа отдельной сделки: у каждой сделки свой стоп по волатильности (ATR) — лимит лишь останавливает автопилот целиком, когда суммарный результат сессии дойдёт до границы.</div>`;

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

    // ---- лимиты сделок: макс. одна + суммарный → авторасчёт одновременных позиций ----
    const dealCap = Store.aiDealCap();
    const totalCap = Store.aiTotalCap();
    const remainV = Store.aiTotalRemain();
    const autoPos = Store.autoMaxPos();
    const effPos = Store.effMaxPos();
    const posMode = s.aiPosMode;
    const limitsHtml = `
      <div class="ai-limit-row">
        <span class="lbl">${h.icon("shield", 12)} макс. одна сделка</span>
        <span class="custom-wrap">
          <input id="ai-deal-input" class="inp num" data-role="ai-deal" inputmode="numeric" placeholder="${dealCap}" value="" title="Максимальная сумма одной сделки, ХРЮ (≈ $)">
          <span class="pct">ХРЮ</span>
          <button class="limit-apply" data-action="ai:deal" title="Применить лимит одной сделки">OK</button>
        </span>
      </div>
      <div class="ai-limit-row">
        <span class="lbl">${h.icon("swap", 12)} макс. все сделки</span>
        <span class="custom-wrap">
          <input id="ai-total-input" class="inp num" data-role="ai-total" inputmode="numeric" placeholder="${totalCap}" value="" title="Максимальная суммарная сумма всех сделок в рынке, ХРЮ (≈ $)">
          <span class="pct">ХРЮ</span>
          <button class="limit-apply" data-action="ai:total" title="Применить суммарный лимит">OK</button>
        </span>
      </div>
      <div class="ai-limit-row">
        <span class="lbl">${h.icon("grid", 12)} одновременно</span>
        <div class="limit-chips">
          <button class="limit-chip ${posMode === "auto" ? "active" : ""}" data-action="ai:maxpos" data-arg="auto" title="Число позиций считается из лимитов автоматически: суммарный лимит ÷ лимит одной сделки">АВТО·${autoPos}</button>
          ${[1, 2, 3, 4, 5, 6, 7, 8].map((v) => `<button class="limit-chip num ${posMode === v ? "active" : ""}" data-action="ai:maxpos" data-arg="${v}" title="Ручной лимит: не больше ${v} ИИ-сделок в рынке одновременно">${v}</button>`).join("")}
        </div>
      </div>
      <div class="ai-limit-note">Одновременных ИИ-позиций: <b>${effPos}</b>${posMode === "auto" ? ` — авто из лимитов (${Fmt.fmtNum(totalCap)} ÷ ${Fmt.fmtNum(dealCap)})` : " — ручной лимит"} · свободно по суммарному лимиту: ${Fmt.fmtNum(Math.round(remainV))} ХРЮ (≈ $${Fmt.fmtNum(Math.round(remainV))}). Лимиты действуют на все сделки счёта — ИИ, сигналы и ручные.</div>`;

    // ---- R29 провальный порог: тело + N% — единственная точка авто-закрытия в минусе ----
    const failPct = s.failPct == null ? 50 : s.failPct;
    const failPresets = [0, 25, 50, 75, 100, 150];
    const failHtml = `
      <div class="ai-limit-row">
        <span class="lbl">${h.icon("shield", 12)} провал: тело +</span>
        <div class="limit-chips">${failPresets.map((v) => `<button class="limit-chip num ${failPct === v ? "active" : ""}" data-action="ai:fail" data-arg="${v}" title="${v === 0 ? "Классический режим: закрывать сразу за стоп-линией (старое поведение)" : "Закрывать в минусе только при ходе глубже стопа ещё на " + v + "% от тела"}">${v}%</button>`).join("")}</div>
        <span class="custom-wrap">
          <input id="ai-fail-input" class="inp num" data-role="ai-fail" inputmode="numeric" placeholder="${failPct}" value="" title="Свой провальный порог, % от тела сделки (0–200)">
          <span class="pct">%</span>
          <button class="limit-apply" data-action="ai:fail-apply" title="Применить свой провальный порог">OK</button>
        </span>
      </div>
      <div class="ai-limit-note">«Тело» сделки — плановый риск: расстояние от входа до стопа. Убыток ниже тела — это шум и временный тренд: ИИ такие сделки НЕ закрывает и ждёт цели (2R). Авто-закрытие в минусе одно: ход против сделки глубже тела ещё на ${failPct}% (при телах ~1% это −1,5% от входа). Трейлинг в плюсе, безубыток и цель работают как раньше — продаём только в плюс. Порог синхронизируется в облако: Страж закрывает по тем же правилам.</div>`;

    // ---- мини-статистика памяти ИИ + статус GLM-аналитика ----
    const brain = s.aiBrain || {};
    const wr = brain.trades ? Math.round((brain.wins / brain.trades) * 100) : null;
    const brainMini = `<div class="ai-brain-mini num">${h.icon("cpu", 11)} опыт: ${brain.trades || 0} сделок${wr != null ? ` · винрейт ${wr}%` : ""} · порог входа ${brain.confThreshold || 74}% (всё выше открывает сам) · память ${brain.weights ? "адаптирована" : "базовая"}</div>`;
    const glmSt = window.GLM ? GLM.status() : { status: "not-configured" };
    const glmOn = window.GLM && GLM.enabled();
    const glmTxt = !glmOn
      ? "GLM не подключён — добавьте бесплатный ключ, и языковая модель станет 13-м фактором ансамбля"
      : glmSt.status === "ok"
        ? `GLM: ${glmSt.bias === "flat" ? "вне рынка" : glmSt.bias || "—"} ${glmSt.confidence}% · ${h.esc(String(glmSt.reasoning || "").slice(0, 90))}`
        : glmSt.status === "asking" ? "GLM смотрит на рынок…"
        : glmSt.status === "error" ? `GLM: ошибка — ${h.esc(String(glmSt.error || "").slice(0, 70))}`
        : "GLM подключён, ждёт первого опроса (до 10 минут)";
    const glmRow = `
      <div class="glm-row ${glmOn ? "on" : ""}">
        <span class="glm-ico">${h.icon("cpu", 12)}</span>
        <span class="glm-txt">${glmTxt}</span>
        <button class="link-btn" data-action="glm:open" title="Настройки GLM-аналитика: ключ, модель, провайдер">${glmOn ? "настройки" : "подключить"}</button>
      </div>`;

    let body = "";
    if (!fresh) {
      body = `
        <button class="ai-cta" data-action="ai:analyze" data-arg="${sym}">${h.icon("sparkles", 14)} Проанализировать ${sym} и дать вердикт</button>
        <div class="ai-help">ИИ взвешивает 13 факторов: тренд, RSI, MACD, Боллинджера, Ишимоку, объём, импульс,
        новостной фон, ADX (силу тренда), стохастик, старший таймфрейм 1ч, поток китов и GLM-аналитика. Сам выбирает направление,
        стоп и цель. Защита в несколько слоёв: скам-фильтр, новостные риски, гварды волатильности и вспышек, запрет входа против
        явного тренда 1ч, тайм-аут 4 часа по монете после провала, безубыток с +1R, пауза после серии минусов и авто-стоп сессии
        ±${th}%. В минусе ИИ терпелив: закрывает сделку только когда убыток превысил «тело» + ${s.failPct == null ? 50 : s.failPct}% — временный откат не повод продавать, ждём цель.
        С каждой закрытой сделкой (вашей или лабораторной) ИИ корректирует веса. ${live ? "В реальном режиме вердикт подскажет вход — ордер отправите кнопкой ниже." : "Автопилот может открывать и флипать сделки сам."}</div>`;
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
        const sc = Store.aiSizeCalc();
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
            <div><div class="k">стоп-линия −${r.riskPct.toFixed(1)}%</div><div class="text-red">${fmtPrice(r.stop)}</div></div>
            <div><div class="k">цель +${r.targetPct.toFixed(1)}%</div><div class="text-green">${fmtPrice(r.target)}</div></div>
          </div>
          <div class="ai-levels num" style="margin-top:-6px">
            <div style="grid-column:1/-1"><div class="k">провал закроется за (тело +${S().failPct == null ? 50 : S().failPct}%) · дальше только цель</div><div class="text-red">${fmtPrice(Engine.failLineOf({ side: r.verdict, entry: r.price, stop: r.stop }, S().failPct == null ? 50 : S().failPct))}</div></div>
          </div>
          <div class="ai-factors">${factorRows}</div>
          ${live
            ? `<button class="ai-open" data-action="live:order-ai">Отправить рыночный ордер по сигналу ИИ</button>`
            : sc.size > 0
              ? `<button class="ai-open" data-action="ai:open">Открыть ${r.verdict} по сигналу ИИ · ${Fmt.fmtNum(sc.size)} ХРЮ (≈ ${Fmt.fmtUsd(sc.size)})</button>`
              : `<div class="ai-wait">ИИ-сделка не влезает в лимиты: свободно ${Fmt.fmtNum(Math.round(Store.aiTotalRemain()))} ХРЮ суммарного лимита при балансе ${Fmt.fmtNum(Math.round(s.balance))} ХРЮ. Поднимите лимиты или пополните счёт.</div>`}
          <div class="ai-ts"><span>расчёт ${Fmt.fmtClock(fresh.ts)} · RR 1:2 · согласие факторов ${Math.round((r.agreeShare || 0) * 100)}% · спот</span><button class="link-btn" data-action="ai:analyze" data-arg="${sym}">пересчитать</button></div>
        </div>`;
      }
    }

    return `<div class="ai-block">${head}${pauseHtml}${sessionHtml}${live ? "" : limitHtml}${live ? "" : limitsHtml}${live ? "" : failHtml}${stopHtml}${brainMini}${glmRow}${body}</div>`;
  }

  // ================= МОДАЛКА GLM-АНАЛИТИКА (13-й фактор ансамбля) =================
  function glmModal() {
    if (!window.GLM) return `<div style="padding:20px">Модуль GLM не загружен</div>`;
    const cfg = GLM.getSettings();
    const st = GLM.status();
    const presets = GLM.presets();
    const statusHtml = !cfg.apiKey
      ? `<div class="ai-wait" style="margin-top:0">Ключа нет: GLM работает как обычный аналитик «на бумаге» — в ансамбль не входит. Получите бесплатный ключ (bigmodel.cn или z.ai) и вставьте ниже.</div>`
      : st.status === "ok"
        ? `<div class="sync-state"><span class="np-ok">подключено · ${h.esc(st.model || cfg.model)}</span><div class="num" style="margin-top:6px;font-size:12px">последний вердикт: <b>${st.bias === "flat" ? "вне рынка" : h.esc(st.bias || "—")} ${st.confidence}%</b> ${st.ts ? "· " + Fmt.fmtClock(st.ts) : ""}<br><span style="color:#a99bb5">${h.esc(st.reasoning || "")}</span></div></div>`
        : st.status === "error"
          ? `<div class="ai-wait" style="margin-top:0;color:#f87171">Ошибка: ${h.esc(st.error || "")}</div>`
          : `<div class="ai-wait" style="margin-top:0">Статус: ${st.status === "asking" ? "запрос к модели…" : "ключ сохранён, ждём опроса"}</div>`;
    return `
    <div>
      <div class="cab-head">
        <span class="cab-icon" style="background:rgba(255,45,120,0.13)">${h.icon("cpu", 22)}</span>
        <div>
          <h2 class="cab-title">GLM-аналитик</h2>
          <p class="cab-sub">языковая модель GLM как 13-й фактор ансамбля ИИ</p>
        </div>
      </div>
      <div class="cab-body">
        ${statusHtml}
        <div class="notify-sec">Провайдер и модель</div>
        <div class="ai-limit-row" style="flex-wrap:wrap">
          <div class="limit-chips">
            ${presets.map((p) => `<button class="limit-chip ${cfg.endpoint === p.url ? "active" : ""}" data-action="glm:preset" data-arg="${p.id}">${h.esc(p.label)}</button>`).join("")}
          </div>
        </div>
        <div class="ai-limit-row">
          <span class="lbl">модель</span>
          <span class="custom-wrap" style="flex:1">
            <input id="glm-model" class="inp num" value="${h.esc(cfg.model)}" placeholder="glm-4-flash · glm-4.6 · glm-4.5-air" style="width:100%">
          </span>
        </div>
        <div class="ai-limit-note">glm-4-flash у BigModel бесплатный; для Z.AI подойдёт glm-4.6. Можно вписать свою модель вручную.</div>
        <div class="notify-sec">API-ключ</div>
        <div class="ai-limit-row">
          <span class="custom-wrap" style="flex:1">
            <input id="glm-key" class="inp" type="password" value="${h.esc(cfg.apiKey)}" placeholder="вставьте ключ API (хранится только в этом браузере)" style="width:100%">
          </span>
        </div>
        <div class="ai-limit-note">Ключ уходит ТОЛЬКО напрямую в API провайдера из вашего браузера — платформа его никуда не пересылает. Без ключа фактор GLM просто отсутствует, остальные 12 факторов работают как раньше.</div>
        <div class="notify-actions" style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="ai-open" data-action="glm:save">Сохранить и включить</button>
          <button class="btn-ghost" data-action="glm:test">${h.icon("zap", 13)} Спросить GLM сейчас</button>
          ${cfg.apiKey ? `<button class="btn-ghost" data-action="glm:off">Выключить фактор</button>` : ""}
          <button class="btn-ghost" data-action="modal:close">Закрыть</button>
        </div>
      </div>
    </div>`;
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

    const syms = `<div class="chip-row scroll" style="margin-bottom:8px">` + DataLib.WATCHLIST.map((i) => `
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

    const syms = `<div class="chip-row scroll" style="margin-bottom:8px">` + DataLib.WATCHLIST.map((i) => `
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
    // ЛАБА — только в демо-режиме: в реальном рынке лабораторных плашек, вкладок и входов нет
    // (требование пользователя: реальному рынку лаборатория не нужна)
    const showLab = s.mode !== "live";
    const tab = showLab ? (s._tradesTab || "user") : "user";
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
        <p class="page-sub">Демо-торговля хрювнами по реальным ценам · открытых: ${s.userPositions.length + (showLab ? s.labPositions.length : 0)}</p>
      </div>
      ${myStatsBlock()}
      <div class="trades-grid">
        <div class="stack-16">
          <section class="card">
            <div style="padding:12px 20px;border-bottom:1px solid var(--border);font-size:13.5px;font-weight:500;color:#d4d4d8">Мои демо-позиции · ${s.userPositions.length}</div>
            ${userPosRows}
          </section>

          ${showLab ? labSection(s, labPosRows) : ""}

          <section class="card">
            <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:12px 20px;border-bottom:1px solid var(--border)">
              <div style="display:flex;align-items:center;gap:8px">
                ${showLab ? h.tfBar(tab === "user" ? "мои" : "лаборатория", "trades:tab", ["мои", "лаборатория"]) : `<span style="font-size:13.5px;font-weight:500;color:#d4d4d8">Мои закрытые сделки</span>`}
                <span class="num" style="font-size:12px;color:#71717a">· ${closed.length}</span>
              </div>
              <div style="display:flex;align-items:center;gap:10px">
                <span style="font-size:11.5px;color:#52525b">прибыль после условной комиссии 0.1%</span>
                ${tab === "user" && s.userClosed.length ? `<button class="btn-ghost" style="padding:5px 10px;font-size:11.5px" data-action="stats:export" title="Скачать историю сделок в CSV">${h.icon("download", 12)} CSV</button>` : ""}
                ${closed.length ? `<button class="btn-ghost" style="padding:5px 10px;font-size:11.5px;color:#f87171" data-action="stats:clear" data-arg="${tab === "user" ? "user" : "lab"}" title="Очистить историю закрытых сделок">${h.icon("trash", 12)} Очистить</button>` : ""}
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

  // ================= лаборатория: сворачиваемая секция (только демо-режим) =================
  // Плашка с позициями лабы перегружала экран (до 15+ строк) — теперь сворачивается
  // в одну строку; выбор запоминается на устройстве (localStorage, без синка — это UI-настройка)
  function labSection(s, labPosRows) {
    let fold = false;
    try { fold = localStorage.getItem("xenoai_lab_fold") === "1"; } catch (e) {}
    const openN = s.labPositions.length;
    const head = `<button data-action="trades:labfold" style="all:unset;display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;box-sizing:border-box;padding:12px 20px;border-bottom:1px solid var(--border);font-size:13.5px;font-weight:500;color:#d4d4d8;cursor:pointer" title="${fold ? "Развернуть" : "Свернуть"} плашку лаборатории">
      <span>Позиции лаборатории · ${openN}</span>
      <span style="font-size:11px;color:#71717a">${fold ? "развернуть ▾" : "свернуть ▴"}</span>
    </button>`;
    const note = `<div class="ai-limit-note" style="padding:10px 20px 0">Это не ваши сделки: лаборатория — 5 виртуальных счетов стратегий (по 10 000 ХРЮ каждый), которые торгуют сами для показа статистики. Их плюс/минус остаётся внутри тестовых счетов и не попадает в ваш баланс. Но они не бесполезны: каждая закрытая лабораторная сделка со своим снапшотом факторов обучает общий мозг ИИ — включите автоторговлю лаборатории в «Счетах», чтобы данные текли.</div>`;
    return `<section class="card">
      ${head}
      ${fold
        ? `<div class="ai-limit-note" style="padding:10px 20px">Свернуто: ${openN} ${openN === 1 ? "позиция обслуживается" : "позиций обслуживаются"} (стопы, цели, безубыток) — лента и статистика продолжат обновляться сами.</div>`
        : note + labPosRows}
    </section>`;
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
          размером ~10% баланса, стоп — 1.2×ATR, цель — 2R. Автотрейд включена по умолчанию: сигналы движка
          принимаются счетами автоматически, поэтому в «Сигналах» ничего не «висит» без дела. Если выключить
          тумблер сверху, счета перестанут торговать сами — и сделки снова сможет открывать только владелец
          (David или Yura). Результаты считаются по реальным свечам Binance — валюта виртуальная, поэтому
          экспериментировать безопасно. Каждая закрытая лабораторная сделка обучает общий мозг ИИ.
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
    const sync = typeof Store.syncInfo === "function" ? Store.syncInfo() : null;
    const catchI = typeof Store.catchInfo === "function" ? Store.catchInfo() : null;
    // R31: кто сейчас исполнитель автоторговли — видно одинаково на всех устройствах
    const execTxt = !sync ? "" : (sync.isHost
      ? "<b>это устройство</b>"
      : sync.host
        ? `<b>${h.esc(sync.host.tag || "другое устройство")}</b> (аренда до ${Fmt.fmtClock(sync.host.until)})`
        : "свободно — аренду возьмёт первое включённое устройство или Страж");
    // R32: блок сервера — видно на любом устройстве одинаково
    const srv = (window.Server && Server.info) ? Server.info() : null;
    const srvLastTick = srv && srv.lastOkAt ? Fmt.fmtClock(srv.lastOkAt) : null;
    const srvBlock = (!srv || !srv.configured) ? "" : `
      <div class="notify-sec">Сервер XenoAI · автономная торговля 24/7</div>
      <div class="sync-state">
        ${srv.active
          ? `<span class="np-ok">подключён</span> · аккаунт живёт на сервере: сделки открывает и закрывает сервер каждые 2 минуты — браузер может быть выключен · состояние одно и то же с любого устройства`
          : `<span class="text-red">не выполнен вход на сервер</span> · выйдите и войдите заново тем же логином — сервер подключится сам`}
        <div class="num" style="margin-top:4px;font-size:11.5px;color:#8d8a94">последняя связь с сервером: ${srvLastTick || "—"}${srv.lastError ? ` · <span class="text-red">${h.esc(String(srv.lastError).slice(0, 90))}</span>` : ""} · сборка сервера: ${h.esc(srv.build || "—")}</div>
      </div>`;
    const syncStatus = !sync ? "" : `${srvBlock}<div class="sync-state">
        <span class="np-ok">включена · всегда</span> · код аккаунта <b class="num" id="sync-code-txt">${h.esc(sync.code || "—")}</b>
        <button class="link-btn" data-action="sync:copy">${h.icon("copy", 12)} скопировать</button>
        <div class="num" style="margin-top:4px;font-size:11.5px;color:#8d8a94">серверный аккаунт: облако — единственный источник правды, перед КАЖДОЙ записью устройство сначала сливает облако со своим состоянием (ничьих позиций больше не пропадает) · пуш: ${sync.lastPush ? Fmt.fmtClock(sync.lastPush) : "—"} · пул: ${sync.lastPull ? Fmt.fmtClock(sync.lastPull) : "—"}${sync.lastError ? ` · <span class="text-red">${h.esc(sync.lastError)}</span>` : ""}</div>
        <div class="num" style="margin-top:4px;font-size:11.5px;color:#8d8a94">исполнитель автоторговли (входы ИИ, флипы, входы лаборатории): ${execTxt} · защитные выходы (стопы/цели/провал) работают на всех устройствах сразу и схлопываются при слиянии</div>
      </div>`;
    const syncBlock = `
      <div class="notify-sec">Синхронизация устройств · всегда включена</div>
      ${syncStatus}
      <div class="sync-actions">
        <button class="btn-ghost" data-action="sync:now">${h.icon("zap", 13)} Синхронизировать сейчас</button>
      </div>
      <div class="ai-limit-note">Без переключателей и опций: каждое изменение (сделки, входы ИИ, баланс, вся история) сразу уходит в облако аккаунта и подтягивается на все устройства с этим же логином. Без интернета платформа продолжает работать локально — изменения уедут в облако при появлении сети (включая финальную досылку при закрытии страницы).</div>
      <div class="notify-sec">Автономность ИИ · 24/7, даже при выключенном сайте</div>
      <div class="ai-limit-note">ИИ не зависит от того, открыта ли платформа: при возврате догоняющий движок проигрывает пропущенный период по <b>реальным 15-минутным свечам</b> (до ~10 суток) — стопы, цели, безубыток, входы и флипы исполняются задним числом по реальным ценам. Чтобы ИИ торговал, пока выключены <b>все</b> устройства, подключите бесплатного «Стража» на GitHub Actions (да, это настройка на github.com — в вашем репозитории, куда залит архив платформы).</div>
      <details class="cab-details">
        <summary>Как включить «Стража»: пошаговая инструкция (2 секрета)</summary>
        <ol class="cab-steps">
          <li><b>Залейте платформу на GitHub</b> (если ещё нет): репозиторий → «Add file» → «Upload files» → перетащите ВСЁ содержимое архива <span class="num">xenoai-trade-final.zip</span> (внутри должен быть <span class="num">index.html</span> и папки <span class="num">js/</span>, <span class="num">.github/</span>) → «Commit changes». Файл <span class="num">.github/workflows/guardian.yml</span> обязан лежать в репозитории — это и есть «Страж».</li>
          <li><b>Откройте настройки репозитория.</b> На странице репозитория на github.com — верхнее меню: «&lt;&gt; Code · Issues · Pull requests · … <b>Settings</b>». Нажмите Settings (не настройки профиля, а именно репозитория — правый верхний угол списка файлов).</li>
          <li><b>Найдите секцию секретов.</b> В левом меню страницы Settings: «<b>Secrets and variables</b>» → подпункт «<b>Actions</b>».</li>
          <li><b>Создайте первый секрет.</b> Зелёная кнопка «<b>New repository secret</b>». В поле Name введите ровно: <b class="num">XENOAI_LOGIN</b>. В поле Secret — логин(ы) входа на платформу: <b>один аккаунт = одна строка</b>. Для двух пользователей просто две строки: <span class="num">David</span> на первой, <span class="num">Yura</span> на второй (регистр не важен). Отдельный секрет для каждого пользователя создавать НЕ нужно — один секрет со строками это и есть список аккаунтов. Нажмите «Add secret».</li>
          <li><b>Создайте второй секрет.</b> Снова «New repository secret». Name: <b class="num">XENOAI_SYNC_CODE</b>. Secret — код(ы) синхронизации <b>построчно в том же порядке, что и логины</b>: строка 1 — код David (из его Кабинета: блок «Синхронизация устройств» выше → «скопировать», формат XXXX-XXXX-XXXX-XXXX), строка 2 — код Yura (Yura открывает свой Кабинет на своём устройстве и копирует свой код). Один аккаунт — одна строка. Нажмите «Add secret». Именно по этим кодам Страж найдёт аккаунты в облаке.</li>
          <li><b>Вкладка Actions.</b> Верхнее меню репозитория → «<b>Actions</b>». Плашка «I understand my workflows…» есть НЕ у всех: она появляется, только если воркфлоу уже лежит в репозитории, а Actions ещё ни разу не запускался. Если её нет — всё уже включено, шаг считается пройденным. Если же Actions показывает экран «Get started with GitHub Actions» с шаблонами (Deno, Jekyll…) — значит файла воркфлоу пока нет в репозитории, см. блок «Если Стража не видно» ниже.</li>
          <li><b>Запустите проверочный прогон.</b> Слева в Actions выберите «<b>XenoAI Guardian</b>» → справа «Run workflow» → ветка main → зелёная «Run workflow». Через 1–2 минуты рядом с запуском появится зелёная галочка — Страж отработал: сходил в облако, прогнал ИИ по реальным свечам и сохранил результат. Если «XenoAI Guardian» в списке слева нет — файл воркфлоу не попал в репозиторий, см. блок «Если Стража не видно» ниже.</li>
          <li><b>Готово.</b> Дальше всё само: воркфлоу запускается каждые 15 минут и торгует за вас (входы, стопы, цели, флипы — те же правила, что в браузере). Проверка: в ленте «События» на любом устройстве появляются записи «Пока вас не было…», а открытые позиции ИИ двигаются даже ночью.</li>
        </ol>
        <div class="notify-sec" style="margin-top:10px">Если «XenoAI Guardian» не появился в Actions — так бывает, и это чинится за минуту</div>
        <div class="ai-limit-note">Экран «Get started with GitHub Actions» с шаблонами (Deno, Jekyll, Publish Node.js…) означает ровно одно: в репозитории нет файла <span class="num">.github/workflows/guardian.yml</span>. Обычно папка <span class="num">.github</span> теряется при загрузке: <b>Finder на Mac скрывает папки с точкой</b> — при перетаскивании она просто не зацепилась (либо был залит архив до последних правок). Два способа исправить:<br><b>Способ А (надёжный, без загрузки файлов).</b> На странице репозитория: «<b>Add file</b>» → «<b>Create new file</b>». В поле имени файла введите <span class="num">.github/workflows/guardian.yml</span> (GitHub сам создаст папки по слэшам) — в большое поле вставьте содержимое файла guardian.yml из архива платформы (откройте zip и скопируйте текст оттуда). Внизу — зелёная «<b>Commit changes</b>».<br><b>Способ Б.</b> Перезалейте содержимое архива: в Finder нажмите <span class="num">⇧⌘.</span> (показ скрытых файлов), убедитесь, что папка <span class="num">.github</span> видна, и перетащите её вместе с остальными файлами в «Upload files».<br>После добавления файла обновите страницу Actions: слева появится «XenoAI Guardian», дальше — шаг 7 (Run workflow).</div>
        <div class="ai-limit-note" style="margin-top:8px">Тонкости: публичный репозиторий — минуты Actions не расходуются (бесплатно навсегда); приватный — уходит ~1440 мин/мес из 2000 бесплатных. Секреты скрыты даже от вас после сохранения (GitHub показывает только имя). Стражу НЕ нужны ключи бирж: в реальном режиме он торгует симуляцией по тем же ценам, реальные ордера по-прежнему отправляются только вручную. Изменить секреты — та же страница, карандашик напротив секрета.</div>
      </details>
      <div class="notify-sec">Резервная копия файлом</div>
      <div class="sync-actions">
        <button class="btn-ghost" data-action="backup:export">${h.icon("download", 13)} Скачать архив JSON</button>
        <button class="btn-ghost" data-action="backup:import">${h.icon("upload", 13)} Восстановить из файла</button>
        <input type="file" id="backup-file" accept=".json,application/json" style="display:none">
      </div>
      <div class="ai-limit-note">Файл — полный снимок аккаунта (баланс, позиции, вся история). Работает без интернета: удобно переносить на новое устройство или хранить как страховку. Восстановление объединяет архив с текущими данными, ничего не затирает.${catchI && catchI.lastCatchUp ? `<br><span class="num" style="color:#8d8a94">последний догон рынка: ${Fmt.fmtClock(catchI.lastCatchUp)} · сделки ИИ не прерывались в офлайне</span>` : ""}</div>`;

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
      <div class="cab-body" style="border-top:1px solid rgba(255,255,255,.06)">
        ${syncBlock}
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

    // ---- push на смартфон: нативный Web Push (R30) — только разрешение, ничего больше ----
    const pc = Notify.getPushCache ? Notify.getPushCache() : { on: false, why: "" };
    const epTail = pc.endpoint ? String(pc.endpoint).slice(-14) : "";
    // R47: статус подписок на сервере: доставка сервера (sub.last, HTTP-статус FCM)
    // И подтверждение устройства (sub.lastAck — пришёл ли ack от service worker).
    // Пара «201 есть, ack нет» = пуш застрял на уровне OS/Chrome либо подписка
    // принадлежит ЧУЖОМУ origin (переезд домена xenoai-chi → xenotrade).
    const srvSubs = (window.Store && Store.state.pushSubs) || [];
    const deviceOrigin = String(location.origin || "");
    const hhOf = (ts) => { const t = new Date(ts); return String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0"); };
    const hostOf = (o) => { try { return new URL(o).host; } catch (e) { return ""; } };
    const srvList = srvSubs.map((s) => {
      const tail = h.esc(String(s.endpoint || "").slice(-14));
      const sOrigin = String(s.origin || "");
      const originTag = sOrigin
        ? (sOrigin === deviceOrigin ? `<span class="np-ok">этот домен</span>` : `<span class="np-warn">чужой: ${h.esc(hostOf(sOrigin) || sOrigin)}</span>`)
        : `<span class="np-warn">домен неизвестен</span>`;
      const send = s.last && s.last.ts
        ? `<span class="${s.last.ok ? "np-ok" : "np-warn"}">сервер: ${hhOf(s.last.ts)} · HTTP ${s.last.status || "—"}</span>`
        : `<span class="np-warn">сервер: отправок не было</span>`;
      const ack = s.lastAck && s.lastAck.ts
        ? (s.lastAck.ok
          ? `<span class="np-ok">устройство: показано ${hhOf(s.lastAck.ts)}</span>`
          : `<span class="np-warn">устройство: ошибка показа — ${h.esc(s.lastAck.err || "?")}</span>`)
        : `<span class="np-warn">устройство: без подтверждения</span>`;
      return `<div class="ai-limit-row" style="flex-wrap:wrap;gap:6px;align-items:center;padding:3px 0">`
        + `<span class="num" style="font-size:11.5px">…${tail}</span> ${originTag} · ${send} · ${ack}`
        + `<button class="btn-ghost" style="padding:2px 8px;font-size:11px" data-action="notify:drop" data-arg="${h.esc(String(s.endpoint || "").slice(-24))}" title="Удалить эту подписку с сервера">убрать</button>`
        + `</div>`;
    }).join("");
    // R47: главная подсказка после переезда домена: на сервере есть подписки, но ни одна
    // не принадлежит текущему домену, и само устройство подписки не имеет.
    const foreignSubs = srvSubs.filter((s) => !s.origin || s.origin !== deviceOrigin);
    const needResubHere = !pc.on && srvSubs.length > 0 && foreignSubs.length === srvSubs.length;
    const migrateBanner = needResubHere ? `
      <div class="notify-install" style="border:1px solid rgba(255,45,120,.45);background:rgba(255,45,120,.08)">
        <b>Домен платформы переехал</b> (xenoai-chi.vercel.app → ${h.esc(hostOf(deviceOrigin) || deviceOrigin)}).
        Подписки на пуши, разрешение и настройки уведомлений привязаны к домену — на старом они остались,
        поэтому сервер отправляет пуши в пустоту (HTTP 201 есть — уведомлений нет). Включите уведомления
        здесь — это одно нажатие: разрешение + новая подписка для этого домена.
      </div>` : "";
    const pushHtml = `
      <div class="notify-sec">Push на смартфон · даже при закрытом приложении</div>
      ${migrateBanner}
      <div class="notify-install">
        Пуши приходят <b>нативным механизмом браузера</b> — никаких сторонних приложений и настроек. Достаточно один раз <b>разрешить уведомления</b> выше: устройство само подписывается на пуши платформы, подписка синхронизируется в облако аккаунта, и сервер присылает сюда события сделок — входы ИИ, цели, провалы, флипы, авто-стоп — даже когда приложение полностью закрыто и выгружено из памяти. Пока приложение открыто, уведомления приходят мгновенно.
      </div>
      <div class="ai-limit-row" style="flex-wrap:wrap;gap:8px">
        <span class="lbl">${h.icon("radio", 12)} это устройство</span>
        ${pc.on
          ? `<span class="np-ok">подписка активна · …${h.esc(epTail)}</span>`
          : pc.why
            ? `<span class="np-warn">${h.esc(pc.why)}</span>`
            : `<span class="np-warn">подписка не создана</span>`}
        ${pc.on
          ? `<button class="btn-ghost" data-action="notify:resub" title="Отписаться и создать подписку заново (лечит застрявшие/битые регистрации)">${h.icon("bell", 13)} Пересоздать подписку</button>`
          : `<button class="btn-lime" data-action="notify:push-enable" title="Создать подписку Web Push для этого устройства">${h.icon("bell", 13)} Подписать на пуши</button>`}
      </div>
      <div class="ai-limit-row" style="flex-wrap:wrap;gap:8px">
        <span class="lbl">${h.icon("wallet", 12)} сервер</span>
        ${srvSubs.length
          ? `<div style="width:100%">${srvList}</div>`
          : `<span class="np-warn">на сервере нет подписок — включите пуши выше</span>`}
      </div>
      <div class="ai-limit-row" style="flex-wrap:wrap;gap:8px">
        <button class="btn-lime" data-action="notify:push-test" title="Сервер отправит настоящий пуш по подпискам аккаунта">${h.icon("bell", 13)} Тестовый пуш с сервера</button>
        <span id="push-test-result"></span>
      </div>
      <div class="ai-limit-note">Диагностика теперь двухсторонняя: <b>«сервер: HTTP 201»</b> — пуш принят сервисом доставки (FCM); <b>«устройство: показано»</b> — service worker устройства реально показал уведомление и подтвердил это серверу (r47). Все торговые пуши идут с <b>высоким приоритетом</b> (Urgency: high, TTL 12 ч) — будят устройство даже в Doze. Если 201 есть, а подтверждения устройства нет — пуш застрял на уровне Android/Chrome: (1) домен переехал — включите уведомления на этом домене (баннер выше); (2) Android 13+ — включите уведомления для самого Chrome: Настройки → Приложения → Chrome → Уведомления; (3) агрессивная экономия батареи (Xiaomi/Samsung/Huawei) душит Chrome в фоне — Настройки → Приложения → Chrome → Батарея → «Без ограничений»; (4) проверьте, не замучен ли сайт в Chrome (замок в адресной строке → Уведомления); (5) не помогает — нажмите «Пересоздать подписку». <b>HTTP 410</b> — подписка устарела: пересоздаётся сама или кнопкой выше.</div>`;

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
        ${pushHtml}
        ${actionsHtml}
      </div>
    </div>`;
  }

  return { market, trades, accounts, portfolio, tradeForm, cabinet, liveModal, liveOrdersCard, aiBlock, notifyModal, glmModal };
})();

window.ViewsTrade = ViewsTrade;
