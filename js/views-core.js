// XenoAI Trade — экраны: Деск, Сигналы, Киты, События, Лидеры
"use strict";

const Views = (() => {
  const S = () => Store.state;
  const h = UI;
  const fmtPrice = (v) => Fmt.fmtPrice(v);
  const ago = (ts) => Fmt.fmtTimeAgo((Date.now() - ts) / 60000);

  // ================= ДЕСК =================
  function desk() {
    const s = S();
    const labAccounts = s.labAccounts, labPositions = s.labPositions, labClosed = s.labClosed;
    const userPositions = s.userPositions, prices = s.prices;
    const labTotal = labAccounts.reduce((a, x) => a + x.balance, 0) + labPositions.reduce((a, p) => a + p.size, 0);
    const labStart = labAccounts.reduce((a, x) => a + x.start, 0);
    const labPct = ((labTotal / labStart - 1) * 100) || 0;
    const profitable = labAccounts.filter((a) => a.balance >= a.start).length;
    const best = labAccounts.reduce((b, a) => (a.balance / a.start > b.balance / b.start ? a : b), labAccounts[0]);
    const bestPct = best ? ((best.balance / best.start - 1) * 100) || 0 : 0;
    const unrealLab = labPositions.reduce((a, p) => a + Engine.positionPnl(p, (prices[p.sym] && prices[p.sym].price) || p.entry).pnl, 0);
    const realizedLab = labClosed.reduce((a, c) => a + c.pnl, 0);
    const btcChg = (prices.BTC && prices.BTC.chg24h) || 0;
    const equity = Store.totalEquity();
    const demoPnl = equity - s.startBalance;
    const lockedSum = (s.userPositions || []).reduce((t, p) => t + (p.size || 0), 0); // R44: маржа в позициях

    // лидеры топ-5
    const leaders = [...labAccounts]
      .sort((a, b) => b.balance / b.start - a.balance / a.start)
      .slice(0, 5)
      .map((a) => {
        const pct = (a.balance / a.start - 1) * 100;
        return `<div class="row">
          <div class="row-main">
            <div class="row-title">${h.esc(a.name)}</div>
            <div class="row-sub num">${Fmt.fmtNum(Math.round(a.balance))} ХРЮ · ${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(2)}%</div>
          </div>
          ${h.tag(pct >= 0 ? "green" : "red", `${pct >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.round(a.balance - a.start))} ХРЮ`)}
        </div>`;
      }).join("");

    // открытые позиции
    const allPos = [...userPositions, ...labPositions];
    const posRows = allPos.length === 0
      ? `<div class="empty">Позиций нет — движок ждёт сигналов или откройте демо-сделку на Рынке</div>`
      : `<div class="rows">` + allPos.slice(0, 6).map((p) => {
          const price = (prices[p.sym] && prices[p.sym].price) || p.entry;
          const { pnl, pct } = Engine.positionPnl(p, price);
          return `<div class="row" style="padding-top:8px;padding-bottom:8px" data-pos-sym="${p.sym}" data-pos-side="${p.side}" data-pos-entry="${p.entry}" data-pos-size="${p.size}" data-pos-lev="${p.lev || 1}">
            <div style="display:flex;align-items:center;gap:10px;min-width:0">
              ${h.coin(p.sym, 28)}
              <div style="min-width:0">
                <div class="row-title">${p.sym} <span style="font-size:11px;color:#71717a">${p.owner === "lab" ? "· лаборатория" : "· демо"} · ${p.side}</span></div>
                <div class="row-sub num">вход ${fmtPrice(p.entry)} → <span data-pnl-price>${fmtPrice(price)}</span></div>
              </div>
            </div>
            <div class="row-right">
              <div data-pnl-main class="num ${pnl >= 0 ? "text-green" : "text-red"}" style="font-size:13px;font-weight:500">${h.hruAmount(pnl, true)} <span style="font-size:11px;opacity:.75">(${Fmt.fmtUsdSigned(pnl)})</span></div>
              <div data-pnl-pct class="num ${pct >= 0 ? "text-green" : "text-red"}" style="font-size:11px">${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(2)}%</div>
            </div>
          </div>`;
        }).join("") + `</div>`;

    // события
    const evRows = s.events.length === 0
      ? `<div class="empty">События появятся, как только движок начнёт работу</div>`
      : `<div class="rows">` + s.events.slice(0, 6).map((e) => `
          <div class="row" style="align-items:flex-start">
            <span class="dot ${e.tone === "bull" ? "green" : e.tone === "bear" ? "red" : "gray"}" style="margin-top:6px"></span>
            <div class="row-main">
              <div class="row-title" style="font-weight:400">${h.esc(e.title)}</div>
              <div class="row-sub">${h.esc(e.detail)}</div>
            </div>
            <span class="num" style="font-size:11px;color:#52525b;flex-shrink:0">${ago(e.ts)}</span>
          </div>`).join("") + `</div>`;

    const html = `
    <div class="stack">
      <div class="page-head">
        <div>
          <h1 class="page-title">Деск</h1>
          <p class="page-sub">Лаборатория стратегий на реальных ценах · ${s.degraded ? "источники недоступны · цены заморожены, торговля стоит" : "данные live · источник: " + (s.source || "подключение…")}</p>
        </div>
        <div class="live-pill hidden-sm">${h.onlineDot()} ${s.degraded ? "оффлайн · цены заморожены" : (s.source || "live") + " · спот"}</div>
      </div>

      <div class="stat-grid cols4">
        ${(() => {
          const sess = Store.aiSessionInfo();
          const sessPct = sess && (s.aiAuto || s.aiStop) ? ` · сессия ${sess.pct >= 0 ? "+" : "−"}${Math.abs(sess.pct).toFixed(1)}%` : "";
          return h.statCard("ИИ-автопилот", s.aiAuto ? "вкл" : (s.aiStop ? "стоп" : "выкл"), s.aiAuto ? "text-green" : (s.aiStop ? "text-red" : "text-dim"),
            `${s.userPositions.filter((p) => p.strategy === "ai").length} ИИ-позиций · ${s.aiIdeas.length} идей · авто-стоп ±${s.aiThreshold || 50}%${sessPct}`);
        })()}
        ${h.statCard("Лучший счёт", `${bestPct >= 0 ? "+" : "−"}${Math.abs(bestPct).toFixed(2)}%`, bestPct >= 0 ? "text-green" : "text-red",
          best ? `${h.esc(best.name)} · баланс ${Fmt.fmtNum(Math.round(best.balance))} ХРЮ` : "—")}
        ${h.statCard("Вся лаборатория", h.hruAmount(labTotal - labStart, true, "text-gold"), "",
          `<span class="stat-sub-row">${Charts.progressDots(5, profitable)}<span>${profitable} из ${labAccounts.length} счетов в плюсе</span></span>`)}
        ${h.statCard("Эталон: держать BTC", `${btcChg >= 0 ? "+" : "−"}${Math.abs(btcChg).toFixed(2)}%`, btcChg >= 0 ? "text-green" : "text-red",
          `24ч · лаборатория ${labPct >= 0 ? "+" : "−"}${Math.abs(labPct).toFixed(2)}%`)}
      </div>

      <div class="stat-grid" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr))">
        ${h.statCard("Демо-счёт (ХРЮ)", `${Fmt.fmtNum(equity)} ХРЮ ≈ ${Fmt.fmtUsd(equity)}`, demoPnl >= 0 ? "text-gold" : "text-red",
          `свободно ${Fmt.fmtNum(s.balance)} · в позициях ${Fmt.fmtNum(lockedSum)} (${(s.userPositions || []).length} шт.) · PnL ${h.hruAmount(demoPnl, true)} (${Fmt.fmtUsdSigned(demoPnl)})`)}
        ${h.statCard("Лаборатория · реализовано", h.hruAmount(realizedLab, true), "",
          `${labClosed.length} закрытых сделок · комиссия 0.1% учтена`)}
        ${h.statCard("Сигналов активно", s.signals.length, "",
          "5 стратегий · пересчёт на каждом закрытии 15м свечи")}
      </div>

      <div style="display:grid;grid-template-columns:1fr;gap:16px" class="desk-two">
        <section class="card card-pad">
          ${h.sectionTitle("Лидеры стратегий", `<button class="link-btn" data-action="nav" data-arg="leaders">Все счета</button>`)}
          <div class="rows">${leaders}</div>
        </section>

        <section class="card card-pad">
          ${h.sectionTitle("Открытые позиции", `<button class="link-btn" data-action="nav" data-arg="trades">Все сделки</button>`)}
          ${posRows}
        </section>
      </div>

      <section class="card card-pad">
        ${h.sectionTitle("Лента событий", `<button class="link-btn" data-action="nav" data-arg="events">все события</button>`)}
        ${evRows}
      </section>
    </div>`;

    return { html, mount() {} };
  }

  // ================= СИГНАЛЫ =================
  // карточка «Мозг ИИ»: обучение на сделках — адаптивные веса, порог, уроки
  function brainCard(s) {
    const b = s.aiBrain || {};
    const base = Engine.AI_BASE_WEIGHTS;
    const labels = { trend: "Тренд · EMA50", rsi: "RSI(14)", macd: "MACD", bb: "Боллинджер", ichi: "Ишимоку", vol: "Объём", roc: "Импульс ROC", news: "Новостной фон", adx: "ADX · тренд", stoch: "Стохастик", htf: "Старший ТФ", whale: "Киты · поток", glm: "GLM · ИИ-модель" };
    const weightRows = Object.keys(base).map((k) => {
      const b0 = base[k];
      const cur = b.weights && b.weights[k] != null ? b.weights[k] : b0;
      const d = cur / b0 - 1;
      const delta = Math.abs(d) >= 0.03
        ? `<span class="num ${d > 0 ? "text-green" : "text-red"}" style="width:44px;text-align:right;flex-shrink:0">${d > 0 ? "▲" : "▼"}${Math.abs(d * 100).toFixed(0)}%</span>`
        : `<span class="num" style="width:44px;text-align:right;flex-shrink:0;color:#52525b">—</span>`;
      return `<div class="brain-row">
        <span class="lbl">${labels[k]}</span>
        <span class="bar"><i style="width:${Math.min(100, cur * 420)}%"></i></span>
        <span class="num val">${cur.toFixed(2)}</span>
        ${delta}
      </div>`;
    }).join("");
    const wr = b.trades ? Math.round((b.wins / b.trades) * 100) : null;
    const sync = typeof Store.brainSyncInfo === "function" ? Store.brainSyncInfo() : null;
    const agoMin = sync && sync.lastOkAt ? Math.max(1, Math.round((Date.now() - sync.lastOkAt) / 60000)) : null;
    const syncTxt = !sync ? "глобальная"
      : sync.mode === "облако" ? `глобальная · облако: синхронизировано ${agoMin < 60 ? agoMin + " мин назад" : Math.round(agoMin / 60) + " ч назад"}`
      : sync.mode;
    const lessons = (b.lessons || []).slice(0, 3).map((l) =>
      `<div class="brain-lesson"><span class="num">${Fmt.fmtClock(l.ts)}</span><span>${h.esc(l.text)}</span></div>`
    ).join("") || `<div class="brain-lesson" style="color:#52525b">Выводов пока нет — ИИ сделает их после первых закрытых сделок</div>`;
    return `
    <section class="card card-pad">
      ${h.sectionTitle("Мозг ИИ · самообучение", `<span style="font-size:11.5px;color:#8d8a94" class="num">${h.esc(syncTxt)}</span>`)}
      <div class="brain-stats num">
        <div><div class="k">сделок изучено (все пользователи)</div><div>${b.trades || 0}</div></div>
        <div><div class="k">винрейт ИИ-сигналов</div><div>${wr != null ? wr + "%" : "—"}</div></div>
        <div><div class="k">порог входа</div><div>${b.confThreshold || 74}%</div></div>
        <div><div class="k">веса</div><div>${b.weights ? "адаптивные" : "базовые"}</div></div>
      </div>
      ${weightRows}
      <div style="margin-top:12px;font-size:12px;font-weight:600;color:#d4cbd8">Последние выводы ИИ</div>
      <div class="brain-lessons">${lessons}</div>
      <p style="margin-top:10px;font-size:11.5px;line-height:1.65;color:#71717a">
        Мозг один на всех: учится на каждой закрытой сделке каждого пользователя (David, Yura и будущие аккаунты) —
        ИИ-сделки дают полную картину (факторы + опыт по монете + калибровка порога), остальные сделки тоже пополняют
        опыт по монете. После закрытой ИИ-сделки (вручную, по цели/стопу или флипом автопилота) ИИ раскладывает результат
        по факторам: чей сигнал оправдался — получает чуть больше веса, кто вёл в убыток — теряет вес. Серии минусов по
        монете снижают уверенность на ней, а общий винрейт калибрует порог входа (70–88%). Память общая, не привязана
        к аккаунту, переживает перезагрузку и синхронизируется между устройствами через бесплатное облако; сброс невозможен.
      </p>
    </section>`;
  }

  // карточка «Новостной фон»: реальная лента + сентимент, который учитывает ИИ
  function newsCard(s) {
    const news = s.news || { items: [] };
    const items = (news.items || []).slice(0, 4);
    let inner;
    if (!items.length) {
      inner = `<div class="empty">Новостной источник ещё не ответил — ИИ торгует по индикаторам. Лента подключится автоматически.</div>`;
    } else {
      const ns = Engine.newsSentiment(news.items, null);
      const toneLabel = ns.global > 0.08 ? "бычий фон" : ns.global < -0.08 ? "медвежий фон" : "нейтральный фон";
      const toneCls = ns.global > 0.08 ? "text-green" : ns.global < -0.08 ? "text-red" : "text-dim";
      const rows = items.map((it) => {
        const sen = Engine.newsSentiment([it], null);
        const arrow = sen.global > 0.08 ? `<span class="dir up">▲</span>` : sen.global < -0.08 ? `<span class="dir down">▼</span>` : `<span class="dir flat">•</span>`;
        const ageMin = Math.max(1, Math.round((Date.now() - it.ts) / 60000));
        const ago = ageMin < 60 ? `${ageMin} мин` : ageMin < 1440 ? `${Math.round(ageMin / 60)} ч` : `${Math.round(ageMin / 1440)} дн`;
        return `<div class="news-row">${arrow}<div class="tt"><a href="${h.esc(it.link)}" target="_blank" rel="noopener" class="news-link">${h.esc(it.title)}</a></div><span class="num ago">${ago}</span></div>`;
      }).join("");
      inner = `
        <div class="news-sent num">сентимент ленты: <span class="${toneCls}">${ns.global >= 0 ? "+" : "−"}${Math.abs(ns.global).toFixed(2)} · ${toneLabel}</span> · ${ns.bull}↑ / ${ns.bear}↓</div>
        <div class="news-rows">${rows}</div>
        <div style="margin-top:8px;font-size:11px;color:#71717a">Источник: ${h.esc(news.source || "rss")} · обновление каждые 5 мин · ИИ учитывает этот фон как 8-й фактор и блокирует входы при медвежьих новостях по монете</div>`;
    }
    return `
    <section class="card card-pad">
      ${h.sectionTitle("Новостной фон · анализ ИИ")}
      ${inner}
    </section>`;
  }

  // «+123 ХРЮ ≈ +$123» — из одного реального числа (курс ХРЮ = $1), зелёным/красным
  function dual(v) {
    const cls = v > 0 ? "text-green" : v < 0 ? "text-red" : "";
    const r = Math.abs(v) >= 1000 ? Math.round(v) : Math.round(v * 100) / 100;
    const dec = Math.abs(r) >= 1000 || Number.isInteger(r) ? 0 : 2;
    const sign = v > 0 ? "+" : v < 0 ? "−" : "";
    return `<span class="num ${cls}" style="font-weight:500">${sign}${Fmt.fmtNum(Math.abs(r), dec)} ХРЮ</span><span class="num ${cls}" style="opacity:.72"> ≈ ${sign}$${Fmt.fmtNum(Math.abs(r), dec)}</span>`;
  }

  // карточка «Результат сделок»: реальные плюсы/минусы счёта — хрювны + доллары (1:1)
  function tradesResultCard(s) {
    const prices = s.prices || {};
    const floatOf = (p) => Engine.positionPnl(p, (prices[p.sym] && prices[p.sym].price) || p.entry).pnl;
    const closed = s.userClosed || [];
    const open = s.userPositions || [];
    const realized = closed.reduce((a, c) => a + c.pnl, 0);
    const floating = open.reduce((a, p) => a + floatOf(p), 0);
    const total = realized + floating;
    const aiReal = closed.filter((c) => c.strategy === "ai").reduce((a, c) => a + c.pnl, 0);
    const aiFloat = open.filter((p) => p.strategy === "ai").reduce((a, p) => a + floatOf(p), 0);
    const cls = (v) => (v > 0 ? "text-green" : v < 0 ? "text-red" : "");
    const live = s.mode === "live"; // R52: реальный рынок — суммы в USDT
    const amt = (v, sign, cls2) => live ? h.usdAmount(v, sign, cls2) : h.hruAmount(v, sign, cls2);
    return `<section class="card card-pad">
      ${h.sectionTitle("Результат сделок · плюс/минус", `<span style="font-size:12px;color:#71717a">${live ? "реальный рынок · суммы в USDT" : "реальные цены · курс 1 ХРЮ = $1"}</span>`)}
      <div class="stat-grid" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr))">
        ${h.statCard("Реализовано · закрытые", closed.length === 0 ? `<span style="color:#71717a">нет сделок</span>` : amt(realized, true, cls(realized)), cls(realized), `${closed.length} закрытых · ${Fmt.fmtUsdSigned(realized)}`)}
        ${h.statCard("В рынке · открытые", open.length === 0 ? `<span style="color:#71717a">нет позиций</span>` : amt(floating, true, cls(floating)), cls(floating), `${open.length} открытых · ${Fmt.fmtUsdSigned(floating)}`)}
        ${h.statCard("Итого по счёту", amt(total, true, cls(total)), cls(total), `реализовано + в рынке · ${Fmt.fmtUsdSigned(total)}`)}
      </div>
      <p style="margin-top:10px;font-size:12px;line-height:1.6;color:#71717a">
        Из них ИИ-сделки: реализовано ${dual(aiReal)} · в рынке ${dual(aiFloat)}. ${live
          ? "На реальном рынке суммы — в USDT: каждый вход купил токен на OKX, каждое закрытие продало его, а итог считается по реальным ценам биржи."
          : "Цифры — не прикидка: каждый плюс/минус посчитан движком по живым ценам биржи на момент показа, а доллары равны хрювнам один к одному."}
      </p>
    </section>`;
  }

  function signals() {
    const s = S();

    // R45: показываем ТОЛЬКО актуальное. Идея старше 45 мин (три закрытые 15м-свечи)
    // уже не «лучшая идея рынка» — сканер её обновит или снят; сигнал стратегий
    // старше 2 часов — не повод для входа по рынку. Устаревшее скрываем с счётчиком.
    const nowTs = Date.now();
    const IDEAS_TTL = 45 * 60000;
    const SIGS_TTL = 2 * 3600000;
    const ideasAll = s.aiIdeas || [];
    // R53: шорт-идеи не показываются нигде — демо повторяет реальный рынок 1:1 (спот OKX)
    const ideas = ideasAll.filter((i) => nowTs - (i.ts || 0) <= IDEAS_TTL && i.res.verdict !== "шорт");
    const staleIdeas = ideasAll.length - ideas.length;
    const sigsAll = s.signals || [];
    const sigsFresh = sigsAll.filter((x) => nowTs - (x.ts || 0) <= SIGS_TTL);
    const staleSigs = sigsAll.length - sigsFresh.length;

    // ИИ-сканер: лучшие идеи по всем монетам (автопилот пересчитывает на каждом обновлении свечей)
    const scanner = ideas.length === 0
      ? `<div class="empty">${ideasAll.length ? "Свежих идей сейчас нет — сканер обновит подбор на ближайшей закрытой 15-минутной свече" : "ИИ сканирует 24 монеты — первые идеи появятся в течение минуты"}</div>`
      : `${staleIdeas > 0 ? `<div class="empty" style="padding:8px 12px;font-size:12px;color:#71717a">${staleIdeas} ${staleIdeas === 1 ? "устаревшая идея скрыта" : "устаревших идеи скрыто"} · покажем только свежие</div>` : ""}<div class="rows row-divide">` + ideas.slice(0, 6).map((i) => {
          const price = (s.prices[i.sym] && s.prices[i.sym].price) || i.res.price;
          const moved = ((price / i.res.price - 1) * 100) || 0;
          return `<div class="sig-row">
            ${h.coin(i.sym, 34)}
            <div style="min-width:0;flex:1">
              <div class="sig-head">
                <span class="sig-sym">${i.sym}</span>
                ${h.tag(i.res.verdict === "лонг" ? "green" : "red", i.res.verdict)}
                ${h.tag("blue", `уверенность ${i.res.confidence}%`)}
                ${!i.guard.ok ? h.tag("orange", "защита: " + i.guard.why) : ""}
                <span class="sig-time num">${ago(i.ts)} назад</span>
              </div>
              <div class="sig-note num">стоп ${fmtPrice(i.res.stop)} · цель ${fmtPrice(i.res.target)} · ${h.esc(i.res.note)}</div>
              ${(() => {
                // R52: база размера — баланс текущего режима (live — реальные USDT с OKX)
                const base = s.mode === "live" ? ((s.okx && Number.isFinite(s.okx.balanceUSDT)) ? s.okx.balanceUSDT : 0) : s.balance;
                const sz = Math.min(1000, Math.max(200, Math.round(base * 0.1)), Math.round(base));
                if (sz < 200) return "";
                const atT = Engine.positionPnl({ side: i.res.verdict, entry: price, size: sz, lev: 1 }, i.res.target).pnl;
                const atS = Engine.positionPnl({ side: i.res.verdict, entry: price, size: sz, lev: 1 }, i.res.stop).pnl;
                return `<div class="sig-note num" style="margin-top:3px">сделка ${Fmt.fmtNum(sz)} ${s.mode === "live" ? "USDT" : "ХРЮ ≈ " + Fmt.fmtUsd(sz)} → до цели ${dual(atT)} · до стопа ${dual(atS)}</div>`;
              })()}
            </div>
            <div class="row-right">
              <div class="num" style="font-size:13.5px;font-weight:500">${fmtPrice(price)}</div>
              <div class="num ${moved >= 0 ? "text-green" : "text-red"}" style="font-size:11.5px">${moved >= 0 ? "+" : "−"}${Math.abs(moved).toFixed(2)}% к идее</div>
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
              <button class="link-btn" data-action="sig:forecast" data-arg="idea|${i.sym}" title="Прогноз ИИ: логика, факторы, время до цели">${h.icon("cpu", 12)} прогноз и логика</button>
              <button class="btn-take" data-action="ai:open-idea" data-arg="${i.sym}">${s.mode === "live" ? "Купить на OKX · лонг" : "Открыть в демо"}</button>
            </div>
          </div>`;
        }).join("") + `</div>`;

    const rows = sigsFresh.length === 0
      ? `<section class="card card-pad" style="text-align:center;padding:40px">
          <div style="font-size:14px;color:#a1a1aa">${sigsAll.length ? "Актуальных сигналов нет — старше 2 часов не показываем" : "Сигналы стратегий формируются на закрытиях 15-минутных свечей"}</div>
          <div style="margin-top:4px;font-size:12.5px;color:#52525b">Как только стратегия увидит пробой — сигнал появится здесь автоматически</div>
        </section>`
      : `<section class="card">${staleSigs > 0 ? `<div class="empty" style="padding:8px 12px;font-size:12px;color:#71717a">${staleSigs} ${staleSigs === 1 ? "устаревший сигнал скрыт" : "устаревших сигналов скрыто"} · вошли бы в рынок по цене, которой уже нет</div>` : ""}<div class="rows row-divide">` + sigsFresh.slice(0, 14).map((sig) => {
          const strat = Engine.STRATEGIES.find((x) => x.id === sig.strategy);
          const price = (s.prices[sig.sym] && s.prices[sig.sym].price) || sig.entry;
          const moved = ((price / sig.entry - 1) * 100) || 0;
          return `<div class="sig-row">
            ${h.coin(sig.sym, 34)}
            <div style="min-width:0;flex:1">
              <div class="sig-head">
                <span class="sig-sym">${sig.sym}</span>
                ${h.tag("green", strat ? strat.short : sig.strategy)}
                <span class="sig-time num">${ago(sig.ts)} назад</span>
              </div>
              <div class="sig-note num">${h.esc(sig.note)}</div>
              ${(() => {
                const atT = Engine.positionPnl({ side: "лонг", entry: price, size: 500, lev: 1 }, sig.target).pnl;
                const atS = Engine.positionPnl({ side: "лонг", entry: price, size: 500, lev: 1 }, sig.stop).pnl;
                return `<div class="sig-note num" style="margin-top:3px">${s.mode === "live" ? "сделка 500 USDT на OKX → до цели" : "сделка 500 ХРЮ ≈ $500 → до цели"} ${dual(atT)} · до стопа ${dual(atS)}</div>`;
              })()}
            </div>
            <div class="sig-levels num">
              <div style="color:#71717a">стоп <span class="text-red">${fmtPrice(sig.stop)}</span></div>
              <div style="color:#71717a">цель <span class="text-green">${fmtPrice(sig.target)}</span></div>
            </div>
            <div class="row-right">
              <div class="num" style="font-size:13.5px;font-weight:500">${fmtPrice(price)}</div>
              <div class="num ${moved >= 0 ? "text-green" : "text-red"}" style="font-size:11.5px">${moved >= 0 ? "+" : "−"}${Math.abs(moved).toFixed(2)}% к сигналу</div>
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
              ${h.tag(sig.confidence >= 75 ? "green" : "gray", `уверенность ${sig.confidence}%`)}
              <button class="link-btn" data-action="sig:forecast" data-arg="sig|${sig.strategy}|${sig.sym}" title="Прогноз ИИ: логика, факторы, время до цели">${h.icon("cpu", 12)} прогноз и логика</button>
              <button class="btn-take" data-action="sig:take" data-arg="${sig.sym}">${s.mode === "live" ? "Взять · 500 USDT" : `Взять в демо · ${h.hruAmount(500)}`}</button>
            </div>
          </div>`;
        }).join("") + `</div></section>`;

    const html = `
    <div class="stack">
      <div class="page-head">
        <div>
          <h1 class="page-title">Сигналы</h1>
          <p class="page-sub">ИИ-сканер по всем монетам + 5 стратегий движка · реальные свечи · спот</p>
        </div>
        <div class="live-pill hidden-sm">${h.onlineDot()} ${s.aiAuto ? "автопилот вкл" : "автопилот выкл"}${s.lastScanAt ? ` · сканер жив · ${Math.max(0, Math.round((Date.now() - s.lastScanAt) / 1000))} с назад` : " · сканер запускается…"}</div>
      </div>

      <section class="card card-pad" style="border-color:rgba(255,45,120,.22)">
        ${h.sectionTitle("ИИ-сканер · лучшие идеи по рынку", `<span style="display:flex;align-items:center;gap:8px">
          <span style="font-size:12px;color:#71717a">ML-ансамбль · скам- и новостная защита</span>
          <button class="ai-auto-pill ${s.aiAuto ? "on" : ""}" data-action="ai:auto"><span class="d"></span>автопилот</button></span>`)}
        ${scanner}
        <p style="margin-top:10px;font-size:12px;line-height:1.6;color:#71717a">
          ИИ прогоняет через ML-ансамбль все ${DataLib.WATCHLIST.length} монет на каждой свежей свече 15м: тренд к EMA50, MACD, RSI,
          Боллинджер, Ишимоку, объёмные аномалии, импульс, новостной фон из реальной ленты, силу тренда ADX, стохастик,
          старший таймфрейм 1ч и поток китов. Заходит только туда, где видит потенциал и одностороннюю картину факторов
          (согласие ≥ 55% веса). Скам-защита отсекает низколиквидные и аномальные монеты, новостная защита — монеты под
          медвежьим давлением, гварды волатильности — вспышки и мёртвые рынки. Убыточная позиция флипом не закрывается:
          разворот — только для защиты прибыли, и только если новый сигнал увереннее входа минимум на 4 п.п.; позиции
          младше 15 минут не флипаются вовсе, после флипа — пауза 45 минут. Серия из 3 минусов — пауза на 30 минут.
          Сессия автопилота автоматически останавливается при +${s.aiThreshold || 50}% профита или −${s.aiThreshold || 50}% просадки:
          закрывает все ИИ-сделки по рынку и ждёт возобновления. Лимит настраивается в блоке ИИ на Рынке/в Сделках.
          ${s.aiAuto ? "Автопилот вкл: ИИ входит и флипает на вашем демо-счёте сам." : "Автопилот выкл: входите вручную кнопкой на идее."}
        </p>
      </section>

      ${tradesResultCard(s)}

      ${brainCard(s)}
      ${newsCard(s)}

      ${rows}

      <section class="card card-pad">
        <div style="margin-bottom:8px;font-size:13.5px;font-weight:600">Как это работает</div>
        <p style="font-size:12.5px;line-height:1.7;color:#71717a">
          Все данные — спотовый рынок: платформа каждые ~2 секунды подтягивает свежие 15-минутные свечи по всем ${DataLib.WATCHLIST.length} инструментам
          (включая GRAM — оригинальный Toncoin из сети The Open Network) и пересчитывает индикаторы: BB(20,2), облако Ишимоку, MACD(12,26,9), RSI(14), ATR(14) и объёмные аномалии.
          Никаких фьючерсов и плеча: и демо, и реальный рынок торгуют как спот — только лонги
          («монета в портфеле»); шорт-сделок больше нет нигде, медвежий вердикт ИИ означает выход в кэш.
          Стоп и цель считаются от ATR: риск 1.2×ATR, цель — 2R. Сигнал можно взять в демо — сделка исполнится по
          реальной рыночной цене, а результат придёт в хрювнах и долларах (курс 1:1 — плюс/минус одинаков в обеих валютах).
          Мозг ИИ общий для всех пользователей и режимов: сигналы и анализ идут одним глобальным ИИ, который уже учтён
          на сделках всех аккаунтов.
        </p>
      </section>
    </div>`;
    return { html, mount() {} };
  }

  // ================= КИТЫ =================
  function whales(sym) {
    const s = S();
    sym = sym || s._whaleSym || "BTC";
    s._whaleSym = sym;
    const TOP_SYMS = ["BTC", "ETH", "SOL", "XRP", "BNB", "NEAR", "GRAM"];
    const whalesArr = s.whales[sym] || [];
    const buys = whalesArr.filter((w) => w.side === "buy").reduce((a, w) => a + w.notional, 0);
    const sells = whalesArr.filter((w) => w.side === "sell").reduce((a, w) => a + w.notional, 0);
    const total = buys + sells || 1;
    const buyPct = Math.round((buys / total) * 100);

    const tabs = `<div class="chip-row scroll">` + TOP_SYMS.map((x) => `
      <button class="chip ${x === sym ? "active" : ""}" data-action="whale:sym" data-arg="${x}">${h.coin(x, 16)} ${x}</button>`).join("") + `</div>`;

    // GRAM (оригинальный Toncoin) торгуется на биржах как TON/USDT — лента китов у него
    // обычная биржевая (aggTrades), никаких спец-блоков не нужно
    const feed = whalesArr.length === 0
      ? `<div class="empty">Загружаю ленту сделок Binance…</div>`
      : `<div class="rows row-divide">` + whalesArr.slice(0, 20).map((w) => `
          <div class="wrow">
            ${h.coin(sym, 30)}
            ${h.tag(w.side === "buy" ? "green" : "red", w.side === "buy" ? "покупка" : "продажа")}
            <div class="num" style="min-width:0;flex:1;font-size:12.5px;color:#a1a1aa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${w.qty.toPrecision(4)} ${sym} · по ${fmtPrice(w.price)}</div>
            <span class="amt num ${w.notional >= 150000 ? (w.side === "buy" ? "text-green" : "text-red") : ""}" style="${w.notional >= 150000 ? "" : "color:#d4d4d8"}">$${Fmt.fmtNum(Math.round(w.notional))}</span>
            <span class="tm num">${Fmt.fmtClock(w.time)}</span>
            ${w.notional >= 150000 ? h.tag(w.side === "buy" ? "green" : "red", "МЕГА") : ""}
          </div>`).join("") + `</div>`;

    // ---- ОНЧЕЙН-БАЗА КИТОВ: реальные кошельки + их чистые потоки за 24ч ----
    const wdb = window.WhalesDB ? WhalesDB.list() : [];
    const winfo = window.WhalesDB ? WhalesDB.info() : { tracked: 0 };
    const biasB = window.WhalesDB ? WhalesDB.bias("BTC") : null;
    const biasE = window.WhalesDB ? WhalesDB.bias("ETH") : null;
    const ethPx = (s.prices.ETH && s.prices.ETH.price) || 0;
    const btcPx = (s.prices.BTC && s.prices.BTC.price) || 0;
    const flowRow = (w) => {
      const px = w.chain === "BTC" ? btcPx : ethPx;
      const net = w.net24h || 0;
      const usd = net * px;
      const hot = w.lastTs && Date.now() - w.lastTs < 30 * 60000;
      const big = Math.abs(usd) >= 250000;
      return `<div class="wk-row">
        <span class="wk-chain">${w.chain === "BTC" ? "₿" : "Ξ"}</span>
        <div style="min-width:0;flex:1">
          <div class="wk-lbl">${h.esc(w.label || w.id)} ${hot ? h.tag(w.net24h > 0 ? "green" : "red", net > 0 ? "накапливает" : "распродаёт") : h.tag("gray", "данные согреваются")}</div>
          <div class="wk-note">${h.esc(w.note || "")}${w.balance != null && w.chain === "BTC" ? ` · баланс ${Fmt.fmtNum(Math.round(w.balance / 1e8))} BTC` : ""}</div>
        </div>
        <div class="wk-flow num ${net > 0 ? "text-green" : net < 0 ? "text-red" : "text-dim"}">
          ${net ? (net > 0 ? "+" : "−") + (w.chain === "BTC" ? Fmt.fmtNum(Math.abs(net)) + " BTC" : Fmt.fmtNum(Math.abs(net)) + " ETH") : "—"}
          <span style="font-size:10.5px;opacity:.75;display:block">≈ $${Fmt.fmtNum(Math.round(Math.abs(usd) / 1000))}K / 24ч</span>
        </div>
        ${big ? h.tag(net > 0 ? "green" : "red", "СИГНАЛ") : ""}
      </div>`;
    };
    const onchainHtml = `
    <section class="card card-pad" style="border-color:rgba(255,45,120,.22)">
      ${h.sectionTitle("Ончейн-киты · база реальных кошельков", `<span class="num" style="font-size:11.5px;color:#8d8a94">${winfo.tracked} кошельков · ${winfo.fresh ? h.onlineDot() + " онлайн" : winfo.lastError ? "обновляем…" : "кэш"}</span>`)}
      <div class="wk-grid">
        <div class="wk-stat ${biasB ? (biasB.dir > 0 ? "bull" : "bear") : ""}">
          <div class="k">Ончейн-сентимент BTC</div>
          <div class="v">${biasB ? (biasB.dir > 0 ? "НАКОПЛЕНИЕ" : "РАСПРЕДЕЛЕНИЕ") : "нейтрально"}</div>
          ${biasB ? `<div class="num" style="font-size:11px;color:#a99bb5">${h.esc(biasB.detail)}</div>` : ""}
        </div>
        <div class="wk-stat ${biasE ? (biasE.dir > 0 ? "bull" : "bear") : ""}">
          <div class="k">Ончейн-сентимент ETH</div>
          <div class="v">${biasE ? (biasE.dir > 0 ? "НАКОПЛЕНИЕ" : "РАСПРЕДЕЛЕНИЕ") : "нейтрально"}</div>
          ${biasE ? `<div class="num" style="font-size:11px;color:#a99bb5">${h.esc(biasE.detail)}</div>` : ""}
        </div>
      </div>
      <div class="wk-list">${wdb.map(flowRow).join("")}</div>
      <div class="ai-limit-note">Платформа сама следит за публично известными кошельками через открытые блокчейн-API (mempool.space для BTC, Blockscout для Ethereum) — без ключей. Поток за 24 часа: сколько заведено минус сколько выведено. Перевес накопления/распределения подаётся ИИ как часть фактора «Киты» и усиливает/ослабляет его голос. Подписи кошельков — публичные данные (Arkham/Nansen/Blockscout).</div>
    </section>`;

    const html = `
    <div class="stack">
      <div>
        <h1 class="page-title">Киты</h1>
        <p class="page-sub">Лента сделок ≥ $15 000 + ончейн-потоки известных кошельков · факторы ИИ</p>
      </div>
      ${onchainHtml}
      ${tabs}
      <div class="wgrid">
        <div class="card card-pad">
          <div class="wstat-label">Крупных сделок в ленте</div>
          <div class="wstat-value num">${whalesArr.length}</div>
          <div style="font-size:11.5px;color:#52525b">из последних 500 сделок ${sym}</div>
        </div>
        <div class="card card-pad">
          <div class="wstat-label">Давление покупок</div>
          <div class="wstat-value num text-green">${buyPct}%</div>
          <div class="bar-track"><div class="bar-fill" style="width:${buyPct}%"></div></div>
        </div>
        <div class="card card-pad">
          <div class="wstat-label">Купили киты</div>
          <div class="wstat-value num">$${Fmt.fmtNum(Math.round(buys / 1000))}K</div>
        </div>
        <div class="card card-pad">
          <div class="wstat-label">Продали киты</div>
          <div class="wstat-value num text-red">$${Fmt.fmtNum(Math.round(sells / 1000))}K</div>
        </div>
      </div>
      <section class="card">
        <div class="card-head">
          <span class="card-head-title">Лента крупных сделок · ${sym}</span>
          <span class="card-head-right">${h.onlineDot()} обновляется каждые 25 сек</span>
        </div>
        ${feed}
      </section>
      <p class="note">
        Спотовая лента Binance не раскрывает адреса кошельков — это данные биржевого стакана. Зато каждая сделка
        настоящая: платформа помечает сделки от $150 000 как «МЕГА» и транслирует их в ленту событий и на график
        (тумблер «Киты» на Рынке). Движения реальных ончейн-кошельков — в блоке выше: это второй, независимый
        источник про больших игроков, и он тоже влияет на решения ИИ.
      </p>
    </div>`;
    return { html, mount() {} };
  }

  // ================= СОБЫТИЯ =================
  function events() {
    const s = S();
    const rows = s.events.length === 0
      ? `<div class="empty">Движок только просыпается — события появятся в течение минуты</div>`
      : s.events.map((e) => `
        <article class="ev-row">
          ${e.sym ? h.coin(e.sym, 34) : `<span class="ev-icon" style="background:${e.tone === "bull" ? "rgba(255,45,120,.15)" : e.tone === "bear" ? "rgba(239,68,68,.15)" : "rgba(255,255,255,.06)"}">${e.tone === "bull" ? "▲" : e.tone === "bear" ? "▼" : "•"}</span>`}
          <div style="min-width:0;flex:1">
            <div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px">
              <span class="ev-tag" style="background:${e.tone === "bull" ? "rgba(255,45,120,.13)" : e.tone === "bear" ? "rgba(239,68,68,.13)" : "rgba(255,255,255,.07)"};color:${e.tone === "bull" ? "#ff5fa8" : e.tone === "bear" ? "#f87171" : "#d4d4d8"}">${e.tone === "bull" ? "бычье" : e.tone === "bear" ? "медвежье" : "нейтрально"}</span>
              <span class="ev-time num">${ago(e.ts)}</span>
            </div>
            <h3 class="ev-title">${h.esc(e.title)}</h3>
            <p class="ev-detail">${h.esc(e.detail)}</p>
          </div>
        </article>`).join("");

    const html = `
    <div class="stack">
      <div class="page-head">
        <div>
          <h1 class="page-title">События</h1>
          <p class="page-sub">Сигналы движка, сделки лаборатории и крупные покупки китов · ${s.events.length}</p>
        </div>
        <div class="live-pill hidden-sm">${h.onlineDot()} live</div>
      </div>
      <section class="card">${rows}</section>
    </div>`;
    return { html, mount() {} };
  }

  // ================= ЛИДЕРЫ =================
  function leaders() {
    const s = S();
    const ranked = [...s.labAccounts].sort((a, b) => b.balance / b.start - a.balance / a.start);
    const rows = ranked.map((a, i) => {
      const pct = (a.balance / a.start - 1) * 100;
      const closed = s.labClosed.filter((c) => c.account === a.id);
      const wins = closed.filter((c) => c.pnl > 0).length;
      const pnl = a.balance - a.start;
      return `<div class="lead-row">
        <span class="lead-num num ${i === 0 ? "top" : ""}">${i + 1}</span>
        <div style="min-width:0;flex:1">
          <div style="display:flex;align-items:center;gap:8px">
            ${a.isProtected ? h.tag("gray", "ЗАЩ") : ""}
            <span style="font-size:14px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${h.esc(a.name)}</span>
          </div>
          <div class="num" style="margin-top:2px;font-size:12px;color:#71717a">
            ${Fmt.fmtNum(Math.round(a.balance))} ХРЮ · <span class="${pct >= 0 ? "text-green" : "text-red"}">${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(2)}%</span>${closed.length > 0 ? ` · ${closed.length} сделок · винрейт ${Math.round((wins / closed.length) * 100)}%` : ""}
          </div>
        </div>
        ${h.tag(pnl >= 0 ? "green" : "red", `${pnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(pnl)))} ХРЮ`, "num")}
      </div>`;
    }).join("");

    const html = `
    <div class="stack">
      <div>
        <h1 class="page-title">Лидеры стратегий</h1>
        <p class="page-sub">Рейтинг счетов лаборатории · считано по реальным 15м свечам Binance</p>
      </div>
      <section class="card"><div class="rows">${rows}</div></section>
      <p class="note">
        ЗАЩ — защищённый вариант: дробный вход по «лестнице» и более ранний защитный стоп. Все результаты получены на
        виртуальные хрювны, но по настоящим рыночным данным — это честный зачёт стратегий перед переходом на реальные
        деньги.
      </p>
    </div>`;
    return { html, mount() {} };
  }

  // ================= ПРОГНОЗ ИИ: на чём основана уверенность конкретного сигнала =================
  function fmtWait(min) {
    if (!Number.isFinite(min) || min <= 0) return "—";
    if (min < 90) return "≈ " + Math.max(5, Math.round(min / 5) * 5) + " мин";
    const hh = min / 60;
    if (hh < 48) return "≈ " + (hh < 10 ? hh.toFixed(1).replace(".", ",") : Math.round(hh)) + " ч";
    return "≈ " + (hh / 24).toFixed(1).replace(".", ",") + " сут";
  }

  // оценка времени до уровня: средний абсолютный ход 15м-бара за последние 60 баров
  function etaMinutes(bars, from, to) {
    let sum = 0, n = 0;
    for (let i = Math.max(1, bars.length - 60); i < bars.length; i++) { sum += Math.abs(bars[i].c - bars[i - 1].c); n++; }
    const avg = n ? sum / n : 0;
    const dist = Math.abs(to - from);
    if (!avg || !dist) return null;
    const barsNeed = dist / avg; // баров при средней скорости рынка
    return { fast: barsNeed * 15 * 0.6, mid: barsNeed * 15, slow: barsNeed * 15 * 1.9 };
  }

  function signalForecast(arg) {
    const s = S();
    const parts = String(arg).split("|");
    const kind = parts[0];
    let sym, side, conf, note, entry, stop, target, ts, strat = null;
    if (kind === "sig" && parts.length >= 3) {
      const sig = s.signals.find((x) => x.strategy === parts[1] && x.sym === parts[2]);
      if (!sig) return `<div class="empty" style="padding:28px">Сигнал уже устарел и удалён из ленты — свежие появляются на закрытии каждой 15-минутной свечи</div>`;
      sym = sig.sym; side = "лонг"; conf = sig.confidence; note = sig.note;
      entry = sig.entry; stop = sig.stop; target = sig.target; ts = sig.ts;
      strat = Engine.STRATEGIES.find((x) => x.id === sig.strategy) || null;
    } else {
      const idea = (s.aiIdeas || []).find((i) => i.sym === parts[1]);
      if (!idea) return `<div class="empty" style="padding:28px">Идея уже обновилась пересчётом — откройте её прогноз заново со вкладки «Сигналы»</div>`;
      sym = idea.sym; side = idea.res.verdict; conf = idea.res.confidence; note = idea.res.note;
      entry = idea.res.price; stop = idea.res.stop; target = idea.res.target; ts = idea.res.ts;
    }

    const bars = Store.getBars(sym, "15м");
    if (!bars || bars.length < 60) {
      Store.ensureBars(sym, "15м");
      return `<div class="empty" style="padding:28px">Собираю свечи ${sym} для анализа… Нажмите «прогноз и логика» ещё раз через пару секунд</div>`;
    }

    const price = (s.prices[sym] && s.prices[sym].price) || entry;
    const res = Engine.aiAnalyze(sym, bars, s.aiBrain, (s.news && s.news.items) || []);
    const dirSign = side === "лонг" ? 1 : -1;

    // ---- факторы ансамбля: что говорит за и что против ----
    const factors = (res && res.factors ? res.factors : []).slice().sort((a, b) => Math.abs(b.dir * b.weight) - Math.abs(a.dir * a.weight));
    const forList = factors.filter((f) => f.dir * dirSign > 0.05);
    const againstList = factors.filter((f) => f.dir * dirSign < -0.05);
    const maxW = Math.max(0.001, ...factors.map((f) => Math.abs(f.dir * f.weight)));
    const factorRow = (f) => {
      const d = f.dir * dirSign;
      const w = Math.round(Math.abs(f.dir * f.weight) / maxW * 100);
      return `<div class="ai-factor">
        <span class="dir ${d > 0 ? "up" : d < 0 ? "down" : "flat"}">${d > 0 ? "▲" : d < 0 ? "▼" : "•"}</span>
        <span class="lbl" title="${h.esc(f.label)}">${h.esc(f.label)}</span>
        <span class="w"><i style="width:${w}%"></i></span>
        <span class="det" title="${h.esc(f.detail)}">${h.esc(f.detail)}</span>
      </div>`;
    };

    // ---- время до цели/стопа ----
    const reached = dirSign * (price - target) >= 0;
    const etaT = reached ? null : etaMinutes(bars, price, target);
    const distT = Math.abs(target - price) / price * 100;
    const distS = Math.abs(stop - price) / price * 100;

    // ---- опыт ИИ по монете и общий ----
    const brain = s.aiBrain || {};
    const st = (brain.symStats && brain.symStats[sym]) || null;
    const stWr = st && st.n ? Math.round((st.wins / st.n) * 100) : null;
    const wr = brain.trades ? Math.round((brain.wins / brain.trades) * 100) : null;

    // ---- новостной фон ----
    const ns = (s.news && s.news.items && s.news.items.length) ? Engine.newsSentiment(s.news.items, sym) : null;
    const newsLine = !ns
      ? "новостная лента ещё не загружена — фактор новостей нейтрален"
      : ns.coinItems
        ? `по ${sym}: ${ns.coin >= 0 ? "+" : "−"}${Math.abs(ns.coin).toFixed(2)} (${ns.coinItems} свеж. новост${ns.coinItems % 10 === 1 && ns.coinItems % 100 !== 11 ? "я" : "й"}) · рынок в целом ${ns.bull}↑/${ns.bear}↓`
        : `свежих новостей по ${sym} нет · рынок в целом ${ns.bull}↑/${ns.bear}↓`;

    // ---- краткий разбор логики своими словами ----
    const short = (l) => String(l).split("·")[0].trim().toLowerCase();
    const forTop = forList.slice(0, 3).map((f) => short(f.label));
    const againstTop = againstList.slice(0, 2).map((f) => short(f.label));
    const scoreTxt = res ? `${res.score >= 0 ? "+" : "−"}${Math.abs(Math.round(res.score * 100))}` : null;
    let summary = "";
    if (strat) {
      summary += `Вход найден стратегией «${strat.name}»: ${h.esc(note)}. ${h.esc(strat.desc)}. `;
    } else {
      summary += `Идея ИИ: ансамбль 12 факторов голосует за ${side} с оценкой ${scoreTxt} — ${h.esc(note)}. `;
    }
    if (!res) {
      summary += `Свежий пересчёт пока не удался — смотрите триггер стратегии. `;
    } else if (res.verdict === side) {
      summary += `Свежий пересчёт подтверждает направление: ансамбль на стороне ${side} (оценка ${scoreTxt}, вердикт ${res.confidence}%). `;
    } else if (res.verdict === "wait") {
      summary += `Внимание: свежий пересчёт ансамбля даёт «ожидание» — импульс с момента сигнала ослаб, входите меньшей суммой. `;
    } else {
      summary += `Внимание: свежий пересчёт даёт «${res.verdict}» — картина после сигнала изменилась, аккуратнее. `;
    }
    if (forTop.length) summary += `Главные аргументы за: ${forTop.join(", ")}. `;
    if (againstTop.length) summary += `Что против: ${againstTop.join(", ")} — поэтому позиция закрывается по стопу без уговоров. `;
    summary += `Математика: риск ${distS.toFixed(1)}% (это 1R), цель ${side === "лонг" ? "+" : "−"}${distT.toFixed(1)}% (2R) — один плюс перекрывает два минуса${wr != null ? `; по опыту платформы ИИ закрывает в плюс ${wr}% сделок` : ""}. `;
    if (st && st.n >= 3) summary += `По ${sym} у ИИ уже ${st.n} сделок (винрейт ${stWr}%), текущая серия ${st.streak > 0 ? st.streak + " плюс подряд" : st.streak < 0 ? Math.abs(st.streak) + " минуса подряд" : "нейтральная"} — это учтено в уверенности. `;
    summary += reached
      ? `Цель по цене уже достигнута — сигнал отработал.`
      : `Ориентир по времени до цели: ${fmtWait(etaT ? etaT.mid : NaN)} на средней скорости рынка, ${fmtWait(etaT ? etaT.fast : NaN)} на быстром, до ${fmtWait(etaT ? etaT.slow : NaN)} на вялом. Если цена первой дойдёт до стопа — сделка закроется с минусом 1R: это цена за шанс получить 2R.`;

    return `
    <div>
      <div class="cab-head">
        <span class="cab-icon" style="background:rgba(255,45,120,0.13)">${h.coin(sym, 30)}</span>
        <div>
          <h2 class="cab-title">Прогноз ИИ: ${sym} · ${side}</h2>
          <p class="cab-sub">${strat ? h.esc(strat.name) : "ИИ-сканер · ансамбль 12 факторов"} · сигнал ${ago(ts)} назад · цель 2R · спот</p>
        </div>
      </div>
      <div class="cab-body">
        <div class="ai-verdict ${side === "лонг" ? "long" : "short"}">
          <div class="ai-v-head"><span class="ai-v-side">${side}</span><span class="ai-v-sym">уверенность ${conf}%${res && res.verdict === side ? ` · ансамбль сейчас ${res.confidence}%` : ""}</span><span class="ai-conf-num num">${conf}%</span></div>
          <div class="ai-conf"><i style="width:${conf}%"></i></div>
        </div>

        <div class="notify-sec">Логика входа</div>
        <div class="fc-box">${h.esc(strat ? `${strat.name} — ${strat.desc}` : "ансамбль 12 факторов (тренд, RSI, MACD, Боллинджер, Ишимоку, объём, импульс, новости, ADX, стохастик, старший ТФ, киты)")}<br><span style="color:#d4cbd9">${h.esc(note)}</span></div>

        <div class="notify-sec">Почему ИИ ждёт профита — факторы за (${forList.length})</div>
        ${forList.length ? `<div class="ai-factors">${forList.map(factorRow).join("")}</div>` : `<div class="ai-limit-note">Сильных факторов в пользу сделки нет — триггер сработал на слабом большинстве. Такую сделку лучше пропустить.</div>`}

        <div class="notify-sec">Что против — факторы риска (${againstList.length})</div>
        ${againstList.length ? `<div class="ai-factors">${againstList.map(factorRow).join("")}</div>` : `<div class="ai-limit-note">Открыто противостоящих факторов нет — картина односторонняя.</div>`}

        <div class="notify-sec">Сколько ждать до цели</div>
        <div class="fc-eta num">
          <div><div class="k">быстрый рынок</div><div class="v text-green">${fmtWait(etaT ? etaT.fast : NaN)}</div></div>
          <div><div class="k">средняя скорость</div><div class="v">${fmtWait(etaT ? etaT.mid : NaN)}</div></div>
          <div><div class="k">вялый рынок</div><div class="v">${fmtWait(etaT ? etaT.slow : NaN)}</div></div>
          <div><div class="k">до стоп-линии</div><div class="v text-red">−${distS.toFixed(1)}%</div></div>
        </div>
        <div class="ai-limit-note">Оценка — по среднему ходу цены за 15-минутный бар за последние 60 баров. Рынок не идёт по прямой: сначала цель может «покачать» против входа. Уровни: вход ${Fmt.fmtPrice(entry)} · текущая ${Fmt.fmtPrice(price)} · стоп-линия ${Fmt.fmtPrice(stop)} (предупреждение — сама сделку не закрывает) · провал ${Fmt.fmtPrice(window.Engine ? Engine.failLineOf({ side, entry, stop }, (window.Store && Store.state.failPct) || 50) : stop)} (тело +N% — единственный выход в минусе) · цель ${Fmt.fmtPrice(target)}.</div>

        <div class="notify-sec">Опыт ИИ и новостной фон</div>
        <div class="fc-box num">${st ? `по ${sym}: ${st.n} сделок · винрейт ${stWr}% · серия ${st.streak > 0 ? "+" + st.streak : st.streak}` : `по ${sym} сделок пока не было — опыт нулевой`}${wr != null ? ` · общий опыт: ${brain.trades} сделок, винрейт ${wr}% · порог входа ${brain.confThreshold || 74}%` : ""}<br><span style="color:#a99bb5">новости: ${h.esc(newsLine)}</span></div>

        <div class="notify-sec">Краткий разбор логики</div>
        <div class="fc-summary">${summary}</div>

        <div class="notify-actions">
          ${kind === "sig"
            ? `<button class="ai-open" data-action="sig:take" data-arg="${sym}">${s.mode === "live" ? "Взять · 500 USDT" : `Взять в демо · ${h.hruAmount(500)}`}</button>`
            : `<button class="ai-open" data-action="ai:open-idea" data-arg="${sym}">${s.mode === "live" ? "Взять сигнал · купить на OKX" : "Открыть в демо по этой идее"}</button>`}
          <button class="btn-ghost" data-action="modal:close">Закрыть</button>
        </div>
      </div>
    </div>`;
  }

  // ================= R43: ТЕНЕВАЯ ТОРГОВЛЯ =================
  // Аналитика решений ИИ «от А до Я» — где отказались и что было дальше:
  // журнал самопроверки качества фильтров платформы.
  function shadow() {
    const s = S();
    const sh = s.shadow || { list: [], stats: {} };
    const st = sh.stats || {};
    const decided = (st.right || 0) + (st.wrong || 0);
    const acc = decided ? Math.round(((st.right || 0) / decided) * 100) : null;
    const avgAvoid = st.avoidedN ? (st.avoidedSum / st.avoidedN) : null;
    const list = (sh.list || []).slice(0, 40);
    const pending = list.filter((e) => !e.verdict).length;

    // медвежий режим — та же формула, что на сервере: BTC −3% за 24ч или ≥70% в красе
    const btcT = s.prices && s.prices.BTC;
    let down = 0, n = 0;
    if (s.prices) for (const sym of Object.keys(s.prices)) {
      const t = s.prices[sym];
      if (t && Number.isFinite(t.chg24h)) { n++; if (t.chg24h < 0) down++; }
    }
    const bear = btcT && Number.isFinite(btcT.chg24h) ? (btcT.chg24h <= -3 || (n ? down / n >= 0.7 : false)) : null;

    const rows = list.map((e) => {
      const ageMin = Math.round((Date.now() - e.ts) / 60000);
      const dir = e.side === "шорт" ? -1 : 1;
      const tk = s.prices && s.prices[e.sym];
      const curHyp = tk && tk.price > 0 ? (((tk.price / e.price - 1) * 100) * dir) : null;
      const worst = e.minPct != null ? e.minPct : null;
      const best = e.maxPct != null ? e.maxPct : null;
      let outHtml;
      if (e.verdict === "right") {
        outHtml = `<span class="np-ok">отказ верный · сделка была бы ${e.hypPct > 0 ? "+" : "−"}${Math.abs(e.hypPct).toFixed(1)}%</span>`
          + (worst != null && worst < e.hypPct ? ` <span style="color:#71717a">· в горизонте доходило до ${worst.toFixed(1)}%</span>` : "");
      } else if (e.verdict === "wrong") {
        outHtml = `<span class="np-warn">упустили профит · сделка дала бы ${e.hypPct > 0 ? "+" : "−"}${Math.abs(e.hypPct).toFixed(1)}%</span>`
          + (best != null && best > e.hypPct ? ` <span style="color:#71717a">· в горизонте было до ${best > 0 ? "+" : "−"}${Math.abs(best).toFixed(1)}%</span>` : "");
      } else if (e.verdict === "flat") {
        outHtml = `<span style="color:#71717a">мимо кассы · движение ${e.hypPct > 0 ? "+" : "−"}${Math.abs(e.hypPct).toFixed(1)}% (±1%)</span>`;
      } else {
        const leftH = Math.max(0, Math.ceil((8 * 60 - ageMin) / 60));
        outHtml = `<span style="color:#71717a">проверка через ${leftH} ч</span>${curHyp != null ? ` · <span class="${curHyp < 0 ? "text-green" : curHyp > 0 ? "text-red" : ""}">сейчас сделка была бы ${curHyp > 0 ? "+" : "−"}${Math.abs(curHyp).toFixed(1)}%</span>` : ""}`;
      }
      return `<div class="ev-row" style="display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
        <div style="min-width:0;flex:1">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <b style="font-size:14px">${h.esc(e.sym)}</b>
            ${h.tag(e.side === "лонг" ? "green" : "red", e.side)}
            <span class="num" style="font-size:12px;color:#71717a">уверенность ${e.conf}%</span>
            <span class="num" style="font-size:12px;color:#71717a">${Fmt.fmtTimeAgo(ageMin)} назад</span>
          </div>
          <div style="margin-top:3px;font-size:13px;color:#d4d4d8">${h.esc(e.why || e.whyCode)}</div>
          <div style="margin-top:2px;font-size:12px" class="num">цена решения ${Fmt.fmtPrice(e.price)} · ${outHtml}</div>
        </div>
      </div>`;
    }).join("");

    const closedAi = (s.userClosed || []).filter((c) => c.strategy === "ai").slice(0, 6);
    const enteredRows = closedAi.map((c) => `<div class="ev-row" style="display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
      <div style="min-width:0">
        <b style="font-size:13px">${h.esc(c.sym)}</b> <span style="font-size:12px;color:#71717a">${c.side} · ${Fmt.fmtTimeAgo(Math.round((Date.now() - (c.closedAt || c.openedAt || Date.now())) / 60000))} назад · ${h.esc(c.exitReason || "")}</span>
      </div>
      <span class="num ${c.pnl >= 0 ? "text-green" : "text-red"}" style="white-space:nowrap">${c.pnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(c.pnl)))} ХРЮ</span>
    </div>`).join("");

    const statHtml = `
      <div class="stat-grid" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr))">
        ${h.statCard("Фильтр прав", acc != null ? `${acc}%` : "—", acc != null && acc >= 60 ? "text-green" : acc != null ? "text-red" : "",
          `${st.right || 0} верных · ${st.wrong || 0} упущенных · ${st.flat || 0} мимо кассы`)}
        ${h.statCard("Отказов в журнале", `${list.length}`, "", `${pending} на проверке · горизонт 8 ч`)}
        ${h.statCard("Избежали в среднем", avgAvoid != null ? `−${avgAvoid.toFixed(1)}%` : "—", avgAvoid != null ? "text-green" : "",
          "движение против сделки у верных отказов")}
      </div>`;

    // R45: доверие по монетам — исходы отказов уже влияют на ИИ; показываем кто в плюсе/минусе
    const trustMap = sh.trust || {};
    const skipMap = sh.skip || {};
    const nowTrust = Date.now();
    const trustRows = Object.keys(trustMap).map((sym) => ({ sym, ...(trustMap[sym] || {}) }))
      .filter((t) => ((t.right || 0) + (t.wrong || 0) + (t.flat || 0)) > 0)
      .sort((x, y) => Math.abs(y.adj || 0) - Math.abs(x.adj || 0) || ((y.ts || 0) - (x.ts || 0)))
      .slice(0, 8)
      .map((t) => {
        const n = (t.right || 0) + (t.wrong || 0) + (t.flat || 0);
        const skipLeftH = skipMap[t.sym] ? Math.max(0, Math.round((skipMap[t.sym] - nowTrust) / 3600000)) : 0;
        const adj = Number(t.adj) || 0;
        const adjTxt = adj === 0 ? "±0" : `${adj > 0 ? "+" : ""}${adj}`;
        const adjCls = adj > 0 ? "color:#4ade80" : adj < 0 ? "color:#f87171" : "color:#71717a";
        return `<div style="display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.05);font-size:13px">
          <span style="color:#d4d4d8"><b>${h.esc(t.sym)}</b> · разобрано ${n}: ${t.right || 0} верных / ${t.wrong || 0} упущено${t.flat ? ` / ${t.flat} мимо` : ""}${skipLeftH ? ` · <span style="color:#fbbf24">вне скана ИИ ещё ${skipLeftH} ч</span>` : ""}</span>
          <span class="num" style="white-space:nowrap;${adjCls}">${adjTxt} к уверенности</span>
        </div>`;
      }).join("");

    const html = `
    <div class="stack">
      <div class="page-head">
        <div>
          <h1 class="page-title">Теневая торговля</h1>
          <p class="page-sub">Каждое решение ИИ от А до Я: почему отказались и что было дальше</p>
        </div>
        <div class="live-pill hidden-sm">${h.onlineDot()} live</div>
      </div>
      ${statHtml}
      <section class="card" style="padding:14px">
        <div class="notify-sec">Режим фильтрации</div>
        <div style="font-size:13px;color:#d4d4d8;line-height:1.5">
          ${bear === null ? "Режим рынка определяется на сервере по свежим ценам." :
            bear ? `<b style="color:#fbbf24">Медвежий режим включён</b> — порог входа +6%: в падении торгуем только отборное, почти всё остальное идёт в отказ (и проверяется фактом ниже).` :
            `<b style="color:#4ade80">Обычный режим</b> — базовый порог входа. Как только BTC уйдёт глубже −3% за 24ч (или ≥70% вотчлиста в красе), порог поднимется, а отказы начнут копиться здесь.`}
        </div>
      </section>
      <section class="card" style="padding:14px">
        <div class="notify-sec">Влияние на ИИ · журнал учит сигналы и подбор монет</div>
        <div style="font-size:13px;color:#d4d4d8;line-height:1.5">
          Тень обучает ИИ по трём каналам. <b>1. Порог входа:</b> отказы с кодом «порог», признанные фактом ошибочными (монета ушла бы в плюс), каждые 2 ошибки снижают порог на 1% (пол 72, не чаще раза в час). <b>2. Доверие по монете:</b> исходы отказов копят репутацию каждой монеты — где фильтр ошибочно резал плюсовые входы, уверенность подрастает (до +4), где отказы стабильно верны — падает (до −6), и это влияет и на вход, и на место монеты в «лучших идеях». <b>3. Пропуск мусорных монет:</b> монету с тремя и более верными отказами подряд ИИ снимает со скана на 12 часов — слоты идей не занимают заведомо плохие.
          <div style="margin-top:8px;padding:9px 11px;border-radius:10px;background:rgba(74,222,128,0.07);border:1px solid rgba(74,222,128,0.22)">
          <b style="color:#4ade80">R47 — ИИ один на всех:</b> мозг ИИ теперь общий для всех аккаунтов и всех режимов — демо-сделки, лаборатория, тень и реальный режим любого аккаунта учат ОДИН мозг (веса 13 факторов, доверие по монетам, порог входа, уроки). Знания, полученные на демо-торговле, сразу применяются в реальной торговле — и наоборот. Синхронизация с общим мозгом — каждые 4 минуты на сервере, без участия браузера.
          </div>
        </div>
        ${(sh.tune || []).length ? `<div style="margin-top:10px">${sh.tune.slice(0, 5).map((t) => `<div style="display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.05);font-size:13px">
          <span style="color:#d4d4d8">${Fmt.fmtTimeAgo(Math.max(0, Math.round((Date.now() - (t.ts || 0)) / 60000)))} назад · ${h.esc(t.why || "подстройка порога")}</span>
          <span class="num" style="white-space:nowrap;color:#4ade80">порог ${t.from}% → ${t.to}%</span>
        </div>`).join("")}</div>` :
        `<div style="margin-top:10px;color:#71717a;font-size:13px">Подстроек порога пока не было: либо ошибочных отказов по порогу ещё не набралось двух, либо порог уже у пола 72%. Это нормально — в здоровом фильтре большинство отказов верные.</div>`}
        <div style="margin-top:14px" class="notify-sec">Доверие по монетам · исходы отказов меняют выбор монет</div>
        ${trustRows || `<div style="margin-top:8px;color:#71717a;font-size:13px">Пока нет разобранных отказов по монетам: каждому отказу нужно 8 часов на проверку фактом. Как только исходы наберутся, здесь появится список — монеты с плюсом ИИ будет искать активнее, с минусом — сознательно избегать.</div>`}
      </section>
      <section class="card" style="padding:14px">
        <div class="notify-sec">Журнал отказов · что было бы, если бы вошли</div>
        ${rows || `<div style="padding:14px 0;color:#71717a;font-size:13px">Пока пусто: автопилот либо торгует всё подряд, либо сканер ещё не сделал первых отказов. Записи появляются с серверных тиков (каждые 2 мин), проверка исхода — через 8 часов после отказа.</div>`}
      </section>
      <section class="card" style="padding:14px">
        <div class="notify-sec">А что с теми, вошли ли</div>
        ${enteredRows || `<div style="padding:14px 0;color:#71717a;font-size:13px">Закрытых ИИ-сделок пока нет.</div>`}
      </section>
      <div class="notify-install">
        <b>Как это работает:</b> каждый кандидат с направлением, которому отказали фильтры (порог уверенности, скам-фильтр, новостной риск, лимиты, паузы), попадает в журнал с ценой решения. Через 8 часов сервер проверяет фактом: если сделка в этом направлении была бы в минусе — <b style="color:#4ade80">отказ верный</b>; если в плюсе — <b style="color:#fbbf24">упустили профит</b>. Так видно, строгий ли фильтр на самом деле: в здоровом фильтре большинство отказов подтверждается падением монеты после отказа.
      </div>
    </div>`;
    return { html, mount() {} };
  }

  return { desk, signals, whales, events, leaders, shadow, signalForecast };
})();

window.Views = Views;
