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
                      <span><span class="lg-line" style="background:${(p.chg24h || 0) >= 0 ? "#4ade80" : "#f87171"}"></span> Цена</span>
                      <span><span class="lg-sq" style="background:#3b82f6"></span> Объём</span>
                    </div></div>`)
              : `<div class="chart-ph">Загружаю свечи Binance…</div>`}
          </div>

          <div class="mkt-whales">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;font-size:12px;color:#71717a">
              <span>Что делали киты · реальные крупные сделки ${sym}</span>
              <button class="link-btn" style="color:var(--lime)" data-action="mkt:whales-on">показать на графике</button>
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
              lineColor: (p.chg24h || 0) >= 0 ? "#4ade80" : "#f87171",
              volColor: "#3b82f6",
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

  // ================= форма демо-сделки =================
  function tradeForm(defaultSym, compact) {
    const s = S();
    const f = s._form || (s._form = { sym: defaultSym, side: "лонг", size: "500", lev: 1 });
    if (defaultSym && !compact) f.sym = f.sym || defaultSym;
    const price = (s.prices[f.sym] && s.prices[f.sym].price) || 0;
    const sizeNum = Number(String(f.size).replace(",", ".")) || 0;
    const risk = price * 0.02;
    const stop = f.side === "лонг" ? price - risk : price + risk;
    const target = f.side === "лонг" ? price + risk * 2 : price - risk * 2;

    const syms = `<div class="chip-row scroll" style="margin-bottom:8px">` + DataLib.WATCHLIST.slice(0, 12).map((i) => `
      <button class="chip ${f.sym === i.sym ? "active" : ""}" style="padding:6px 10px;font-size:12px" data-action="form:sym" data-arg="${i.sym}">${h.coin(i.sym, 16)} ${i.sym}</button>`).join("") + `</div>`;

    return `<div class="tform">
      <div class="tform-head">
        <span class="tform-title">Новая демо-сделка</span>
        <span class="tform-free num">свободно ${Fmt.fmtNum(s.balance)} ХРЮ</span>
      </div>
      ${syms}
      <div class="seg2">
        <button class="seg-btn ${f.side === "лонг" ? "long-on" : ""}" data-action="form:side" data-arg="лонг">лонг</button>
        <button class="seg-btn ${f.side === "шорт" ? "short-on" : ""}" data-action="form:side" data-arg="шорт">шорт</button>
      </div>
      <div class="tform-row">
        <div class="inp-wrap">
          <input class="inp num" id="form-size" data-role="form-size" value="${h.esc(f.size)}" inputmode="decimal" style="padding-left:36px">
          <span class="inp-hru">${h.hru(13)}</span>
          <span class="inp-suffix">ХРЮ</span>
        </div>
        <div class="lev-box">
          <span class="lv num">×${f.lev}</span>
          <input type="range" min="1" max="10" value="${f.lev}" data-role="form-lev" aria-label="Плечо">
        </div>
      </div>
      <div class="tform-stats num">
        <div><div class="k">цена</div><div style="color:#d4d4d8">${fmtPrice(price)}</div></div>
        <div><div class="k">стоп −2%</div><div class="text-red">${fmtPrice(stop)}</div></div>
        <div><div class="k">цель +4%</div><div class="text-green">${fmtPrice(target)}</div></div>
      </div>
      <button class="btn-open ${f.side === "лонг" ? "long" : "short"}" data-action="form:submit">
        ${f.side === "лонг" ? "Открыть лонг" : "Открыть шорт"} · ${sizeNum ? Fmt.fmtNum(sizeNum) : "0"} ХРЮ ×${f.lev}
      </button>
      <p class="tform-note">Виртуальные хрювны · исполнение по реальной цене Binance</p>
    </div>`;
  }

  // ================= СДЕЛКИ =================
  function trades() {
    const s = S();
    const tab = s._tradesTab || "user";
    const closed = tab === "user" ? s.userClosed : s.labClosed;

    const userPosRows = s.userPositions.length === 0
      ? `<div class="empty">Нет открытых сделок — откройте через форму справа или возьмите сигнал</div>`
      : `<div class="rows row-divide">` + s.userPositions.map((p) => {
          const price = (s.prices[p.sym] && s.prices[p.sym].price) || p.entry;
          const { pnl, pct } = Engine.positionPnl(p, price);
          return `<div class="trow">
            ${h.coin(p.sym, 36)}
            <div style="min-width:0;flex:1">
              <div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px">
                <span style="font-size:14px;font-weight:600">${p.sym}</span>
                ${h.sideTag(p.side, p.lev)}
                ${h.tag("orange", "в работе")}
              </div>
              <div class="num" style="margin-top:2px;font-size:11.5px;color:#71717a">${Fmt.fmtNum(p.size)} ХРЮ · вход ${fmtPrice(p.entry)} · стоп ${fmtPrice(p.stop)} · цель ${fmtPrice(p.target)} · ${Fmt.fmtHeld((Date.now() - p.openedAt) / 60000)}</div>
            </div>
            <div class="row-right">
              <div class="num ${pnl >= 0 ? "text-green" : "text-red"}" style="font-size:14.5px;font-weight:600">${h.hruAmount(pnl, true)}</div>
              <div class="num ${pct >= 0 ? "text-green" : "text-red"}" style="font-size:12px">${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(2)}%</div>
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
          return `<div class="trow">
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
              <div class="num ${pnl >= 0 ? "text-green" : "text-red"}" style="font-size:14px;font-weight:600">${h.hruAmount(pnl, true)}</div>
              <div class="num ${pct >= 0 ? "text-green" : "text-red"}" style="font-size:11.5px">${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(2)}%</div>
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
              <div style="font-size:13px"><span style="font-weight:500">${c.sym}</span> <span style="color:#71717a">${c.side} ×${c.lev} · ${Fmt.fmtNum(c.size)} ХРЮ · ${strat ? strat.short : "вручную"}</span></div>
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
              <div style="font-size:11.5px;color:#52525b">прибыль после условной комиссии 0.1%</div>
            </div>
            ${closedRows}
          </section>
        </div>
        <aside>${tradeForm("BTC", false)}</aside>
      </div>
    </div>`;
    return { html, mount() {} };
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
          размером ~10% баланса, стоп — 1.2×ATR, цель — 2R. Дополнительный выход — по закрытию свечи ниже средней
          Боллинджера. Результаты здесь настоящие, потому что считаются по реальным свечам Binance — валюта счёта
          виртуальная, поэтому экспериментировать безопасно.
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
          return `<div class="row" style="flex-wrap:wrap">
            ${h.coin(p.sym, 34)}
            <div style="min-width:0;flex:1">
              <div style="font-size:13.5px;font-weight:600">${p.sym} <span style="font-size:11px;color:#71717a">${p.side} ×${p.lev}</span></div>
              <div class="num" style="font-size:11.5px;color:#71717a">${Fmt.fmtNum(p.size)} ХРЮ · ${fmtPrice(p.entry)} → ${fmtPrice(price)}</div>
            </div>
            <div style="width:110px;text-align:right">
              <span class="num ${pnl >= 0 ? "text-green" : "text-red"}" style="font-size:13.5px;font-weight:500">${h.hruAmount(pnl, true)}</span>
              ${h.pctText(pct, "block")}
            </div>
            ${Charts.spark(spark, { w: 70, h: 24, color: pct >= 0 ? "#4ade80" : "#f87171" })}
            <button class="btn-close" data-action="pos:close" data-arg="${p.id}">Закрыть</button>
          </div>`;
        }).join("") + `</div>`;

    const donut = Charts.donut(
      [{ value: Math.max(1, inTradesPct), color: "#f5c542" }, { value: Math.max(0, 100 - inTradesPct), color: "#a3e635" }],
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
          <div style="font-size:13px;color:#71717a">Демо-кошелёк · хрювны</div>
          <div class="port-big num">${Fmt.fmtNum(equity)} ${h.hru(22)}</div>
          <div class="num" style="margin-top:8px;font-size:13px">
            <span class="${equity >= s.startBalance ? "text-green" : "text-red"}">${equity >= s.startBalance ? "+" : "−"}${Fmt.fmtNum(Math.abs(equity - s.startBalance))} ХРЮ</span>
            <span style="color:#71717a"> · старт ${Fmt.fmtNum(s.startBalance)} ХРЮ</span>
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
            <div class="lr"><span style="display:flex;align-items:center;gap:8px;color:#a1a1aa"><span class="sw" style="background:#a3e635"></span> Свободно</span><span class="num" style="color:#e4e4e7">${Fmt.fmtNum(Math.round(s.balance))} ХРЮ</span></div>
          </div>
          <div class="info-box">
            ХРЮ — виртуальная валюта для безопасного теста движка. Когда демо-прогон устроит — переключимся на реальную
            торговлю через биржевые API-ключи.
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
          <p class="cab-sub">Виртуальные хрювны · реальные цены Binance</p>
        </div>
      </div>
      <div class="cab-body">
        <div style="font-size:12.5px;color:#71717a">Текущий баланс</div>
        <div class="cab-balance num">${Fmt.fmtNum(s.balance)} ${h.hru(20)} <span class="cur">ХРЮ</span></div>
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
        <button class="btn-ghost" data-action="cabinet:reset">Сбросить</button>
      </div>
    </div>`;
  }

  return { market, trades, accounts, portfolio, tradeForm, cabinet };
})();

window.ViewsTrade = ViewsTrade;
