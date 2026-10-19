// XenoAI Trade — каркас приложения: сайдбар + мобильная навигация + роутер
"use strict";

const App = (() => {
  const h = UI;
  let view = "desk";
  let moreOpen = false;
  let renderTimer = null;
  let lastRender = 0;
  // последний момент активности скролла/тача пользователя: пока «свежо» — не перерисовываем
  // экран целиком (иначе мобильный инерционный скролл списка токенов обрывается и возвращает назад)
  let lastUserScroll = 0;

  const NAV = [
    { id: "desk", label: "Деск", icon: "grid" },
    { id: "signals", label: "Сигналы", icon: "zap" },
    { id: "shadow", label: "Тень", icon: "eye" },
    { id: "whales", label: "Киты", icon: "fish" },
    { id: "market", label: "Рынок", icon: "candles" },
    { id: "events", label: "События", icon: "radio" },
    { id: "trades", label: "Сделки", icon: "swap" },
  ];
  const NAV2 = [
    { id: "accounts", label: "Счета", icon: "wallet" },
    { id: "portfolio", label: "Портфель", icon: "candles" },
    { id: "leaders", label: "Лидеры", icon: "trophy" },
  ];
  const MOBILE_MAIN = ["desk", "market", "trades", "signals"];

  // ---------- URL-роутинг: у каждой вкладки свой адрес ----------
  // На http(s) — чистые пути /signals, /trades (на Vercel vercel.json отдаёт index.html
  // на любой путь). Локально с файла — hash-режим #/signals. F5, «назад/вперёд» и ссылки
  // сохраняют вкладку — URL можно отправлять другим.
  const VIEW_IDS = ["desk", "signals", "shadow", "whales", "market", "events", "trades", "accounts", "portfolio", "leaders"];
  const VIEW_TITLES = { desk: "Деск", signals: "Сигналы", shadow: "Тень", whales: "Киты", market: "Рынок", events: "События", trades: "Сделки", accounts: "Счета", portfolio: "Портфель", leaders: "Лидеры" };
  const BASE_TITLE = "XenoAI Trade — платформа автоматического ИИ-трейдинга";
  let hashNav = false;
  function isHttp() { return location.protocol === "http:" || location.protocol === "https:"; }
  // База размещения: "" в корне домена (Vercel) или "/имя-репо" на GitHub Pages
  // (проектная страница живёт в подпапке). Глубокая ссылка вида /repo/signals —
  // после 404.html-фолбэка — распознаётся: имя вкладки откусывается от пути.
  const BASE = (() => {
    if (!isHttp()) return "";
    let p = location.pathname;
    const m = p.match(/\/([a-z]{3,10})\/?$/i);
    if (m && VIEW_IDS.indexOf(m[1].toLowerCase()) !== -1) p = p.slice(0, p.length - m[0].length);
    return p.replace(/\/+$/, "");
  })();
  function viewFromUrl() {
    let v = "";
    if (isHttp()) {
      const rel = BASE ? (location.pathname.slice(BASE.length) || "/") : location.pathname;
      const m = rel.match(/^\/([a-z]{3,10})\/?$/i);
      if (m) v = m[1].toLowerCase();
    }
    if (!v && location.hash) {
      const m = location.hash.match(/^#\/([a-z]{3,10})/i);
      if (m) v = m[1].toLowerCase();
    }
    return VIEW_IDS.indexOf(v) !== -1 ? v : "";
  }
  function applyUrl(v) {
    try {
      if (isHttp()) {
        const url = BASE ? (v === "desk" ? BASE + "/" : BASE + "/" + v) : (v === "desk" ? "/" : "/" + v);
        if (location.pathname + location.hash !== url) history.pushState({ view: v }, "", url);
      } else {
        const hh = "#/" + v;
        if (location.hash !== hh) {
          hashNav = true;
          location.hash = hh;
          setTimeout(() => { hashNav = false; }, 0);
        }
      }
    } catch (e) { /* file:// может запретить — не критично */ }
  }
  function onUrlChange() {
    const v = viewFromUrl() || "desk";
    if (v !== view) navigate(v);
  }

  // ---------- живой PnL: мгновенное обновление цифр без перерисовки экрана ----------
  // Позиции в DOM помечены data-pos-* (монета/сторона/вход/объём/плечо), ячейки —
  // data-pnl-main / data-pnl-pct / data-pnl-price. Патчер каждую секунду (и на каждом
  // тике WebSocket) пересчитывает PnL по свежим ценам и обновляет только эти узлы —
  // без полного ререндера, без ожидания опросов и без конфликта с вводом в формы.
  function patchPnl() {
    const rows = document.querySelectorAll("[data-pos-sym]");
    if (!rows.length) return;
    const prices = Store.state.prices;
    for (const row of rows) {
      const tk = prices[row.getAttribute("data-pos-sym")];
      if (!tk || !(tk.price > 0)) continue;
      const entry = Number(row.getAttribute("data-pos-entry"));
      const size = Number(row.getAttribute("data-pos-size"));
      if (!(entry > 0) || !(size > 0)) continue;
      const lev = Number(row.getAttribute("data-pos-lev")) || 1;
      const dir = row.getAttribute("data-pos-side") === "лонг" ? 1 : -1;
      const pct = ((tk.price / entry - 1) * 100) * dir;
      const pnl = size * lev * (pct / 100);
      const cls = pnl >= 0 ? "text-green" : "text-red";
      const main = row.querySelector("[data-pnl-main]");
      if (main) {
        main.classList.toggle("text-green", pnl >= 0);
        main.classList.toggle("text-red", pnl < 0);
        main.innerHTML = `${h.hruAmount(pnl, true)} <span style="font-size:11px;opacity:.75">(${Fmt.fmtUsdSigned(pnl)})</span>`;
      }
      const pctEl = row.querySelector("[data-pnl-pct]");
      if (pctEl) {
        pctEl.classList.toggle("text-green", pct >= 0);
        pctEl.classList.toggle("text-red", pct < 0);
        pctEl.textContent = `${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(2)}%`;
      }
      const priceEl = row.querySelector("[data-pnl-price]");
      if (priceEl) priceEl.textContent = Fmt.fmtPrice(tk.price);
    }
  }

  function badgeFor(id) {
    const s = Store.state;
    if (id === "events") return s.events.length;
    if (id === "trades") {
      // Сначала реальные (демо) позиции пользователя, лабораторные — в скобках:
      // «0 (2)» = 0 своих + 2 лабораторных. Без лабораторных — просто число своих.
      const user = s.userPositions.length, lab = s.labPositions.length;
      if (lab > 0) return `${user} (${lab})`;
      return user;
    }
    if (id === "signals") return s.signals.length;
    return undefined;
  }

  // бейдж может быть числом или строкой «0 (2)» — пустые/нулевые не показываем
  function badgeVisible(badge) { return badge !== undefined && badge !== 0 && badge !== ""; }

  function navItem(n, active, badge) {
    return `<button class="nav-item ${active ? "active" : ""}" data-action="nav" data-arg="${n.id}">
      ${h.icon(n.icon, 17)}
      <span style="flex:1;text-align:left">${n.label}</span>
      ${badgeVisible(badge) ? `<span class="nv-badge num">${badge}</span>` : ""}
    </button>`;
  }

  // ---------- PWA: колокол уведомлений + кнопка полного экрана ----------
  function notifOn() { return Boolean(window.Notify && Notify.getSettings().on && Notify.permission() === "granted"); }
  function bellBtn(cls) {
    const on = notifOn();
    return `<button class="${cls}" data-action="notify:open" title="Уведомления: сделки ИИ, профит/минус, авто-стоп" aria-label="Уведомления" style="position:relative">${h.icon(on ? "bell" : "bellOff", 15)}${on ? '<i class="bell-dot"></i>' : ""}</button>`;
  }
  function fsBtn(cls) {
    if (window.Notify && !Notify.fsSupported()) return ""; // iOS в браузере: полный экран только через установку PWA
    const on = Boolean(window.Notify && Notify.fsElement());
    return `<button class="${cls}" data-action="fs:toggle" title="Во весь экран (скрыть системные панели)" aria-label="Во весь экран"><span class="fs-icon">${h.icon(on ? "minimize" : "maximize", 15)}</span></button>`;
  }
  // обновить колокола в шапке/сайдбаре без полного ререндера (после вкл/выкл уведомлений)
  function updateBellButtons() {
    const on = notifOn();
    document.querySelectorAll('[data-action="notify:open"]').forEach((b) => {
      b.innerHTML = h.icon(on ? "bell" : "bellOff", 15) + (on ? '<i class="bell-dot"></i>' : "");
    });
  }

  function shellHtml() {
    const s = Store.state;
    const user = Auth.readSession();
    const btc = s.prices.BTC ? s.prices.BTC.price : 0;
    const live = s.mode === "live";
    const conn = window.Live ? Live.state.conn : null;
    const liveBal = window.Live ? Live.balanceUSDT() : null;
    const sourceLabel = s.degraded ? "нет источника" : (s.source || "подключение…");

    const balanceCard = live
      ? `
      <div class="balance-card">
        <div class="balance-row">
          <span class="balance-label">Баланс биржи</span>
          <span class="balance-value num">${liveBal != null ? Fmt.fmtNum(liveBal, 2) + " USDT" : "—"}</span>
        </div>
        <div class="balance-sub">
          <span>${conn ? h.esc(conn.label) : "нет подключения"}</span>
          <span class="${s.degraded ? "live-deg" : "live-ok"}">${sourceLabel}</span>
        </div>
        <div class="mode-seg" style="margin-top:8px">
          <button class="mode-btn" data-action="mode:demo">Демо</button>
          <button class="mode-btn active" data-action="live:open">Реальный</button>
        </div>
        <button class="btn-ghost" style="width:100%;margin-top:6px;padding:7px 0;font-size:12px" data-action="live:open">${h.icon("wallet", 13)} Управление подключением</button>
      </div>`
      : `
      <div class="balance-card">
        <div class="balance-row">
          <span class="balance-label">Демо-баланс</span>
          <span class="balance-value num" id="sb-balance">${Fmt.fmtNum(s.balance)} ХРЮ</span>
        </div>
        <div class="balance-usd num" id="sb-usd">≈ ${Fmt.fmtUsd(s.balance)} · курс 1 ХРЮ = $1</div>
        <div class="balance-sub num">
          <span id="sb-btc">BTC $${Fmt.fmtPrice(btc)}</span>
          <span id="sb-live" class="${s.degraded ? "live-deg" : "live-ok"}">${sourceLabel}</span>
        </div>
        <div class="mode-seg" style="margin-top:8px">
          <button class="mode-btn active">Демо</button>
          <button class="mode-btn" data-action="mode:live">Реальный</button>
        </div>
        <button class="btn-lime" data-action="cabinet:open">Кабинет · пополнить</button>
      </div>`;

    const sidebar = `
    <aside class="sidebar">
      <button class="sb-logo" data-action="nav" data-arg="desk">${h.xenoLogo()}</button>

      ${balanceCard}

      <nav class="sb-nav scroll">
        ${NAV.map((n) => navItem(n, view === n.id, badgeFor(n.id))).join("")}
        <div class="sb-sep"></div>
        ${NAV2.map((n) => navItem(n, view === n.id, badgeFor(n.id))).join("")}
      </nav>

      <div class="sb-foot">
        <div class="status-row">
          <div class="status-left">
            ${h.onlineDot()}
            <span id="sb-status">${s.degraded ? "Источники недоступны · торговля стоит" : "Реальные данные"}</span>
          </div>
          <span class="status-role">${user ? user.role : "admin"}</span>
        </div>
        <div class="user-card">
          <span class="user-avatar">${user ? user.login.slice(0, 1).toUpperCase() : "A"}</span>
          <div style="min-width:0;flex:1">
            <div class="user-name">${user ? h.esc(user.login) : "—"}</div>
            <div class="user-role">Администратор</div>
          </div>
          <div style="display:flex;align-items:center;gap:2px">
            ${bellBtn("btn-logout")}
            ${fsBtn("btn-logout")}
            <button class="btn-logout" data-action="auth:logout" title="Выйти из аккаунта" aria-label="Выйти из аккаунта">${h.icon("logout", 15)}</button>
          </div>
        </div>
        <a class="sb-link" href="https://t.me/Xeno_666" target="_blank" rel="noreferrer">${h.icon("send", 13)} По всем вопросам</a>
      </div>
    </aside>`;

    const mobileHead = `
    <header class="mobile-head">
      <div class="mh-row">
        ${h.xenoLogo()}
        <div class="mh-right">
          <span class="mh-chip num" id="mh-balance">${Fmt.fmtNum(s.balance)} ХРЮ</span>
          ${bellBtn("btn-menu")}
          ${fsBtn("btn-menu")}
          <button class="btn-menu" data-action="menu:open" aria-label="Меню">${h.icon("menu", 18)}</button>
        </div>
      </div>
      <div class="desk-topline">
        <span class="t" id="dt-status">${s.degraded ? "Рыночные источники недоступны — цены заморожены, торговля приостановлена" : "Данные в реальном времени · " + sourceLabel + " · спот"}</span>
        <span class="b num" id="dt-btc">BTC $${Fmt.fmtPrice(btc)}</span>
      </div>
    </header>`;

    const drawer = moreOpen ? `
    <div class="drawer-wrap">
      <div class="drawer-backdrop" data-action="menu:close"></div>
      <div class="drawer scroll fade-in">
        <div class="drawer-top">
          ${h.xenoLogo()}
          <button style="border-radius:999px;padding:6px;color:#a1a1aa" data-action="menu:close" aria-label="Закрыть меню">${h.icon("x", 18)}</button>
        </div>
        <button class="btn-lime" data-action="cabinet:open">Кабинет · демо-баланс</button>
        <div class="user-card">
          <span class="user-avatar">${user ? user.login.slice(0, 1).toUpperCase() : "A"}</span>
          <div style="min-width:0;flex:1">
            <div class="user-name">${user ? h.esc(user.login) : "—"}</div>
            <div class="user-role">Администратор</div>
          </div>
          <button class="btn-logout" data-action="auth:logout" title="Выйти из аккаунта" aria-label="Выйти из аккаунта">${h.icon("logout", 15)}</button>
        </div>
        <a class="sb-link" href="https://t.me/Xeno_666" target="_blank" rel="noreferrer" data-action="menu:close-link">${h.icon("send", 13)} По всем вопросам</a>
        <nav>
          ${[...NAV, ...NAV2].map((n) => navItem(n, view === n.id, badgeFor(n.id))).join("")}
        </nav>
      </div>
    </div>` : "";

    const bottomnav = `
    <nav class="bottomnav">
      ${MOBILE_MAIN.map((id) => {
        const n = [...NAV, ...NAV2].find((x) => x.id === id);
        return `<button class="bn-item ${view === id ? "active" : ""}" data-action="nav" data-arg="${id}">${h.icon(n.icon, 20)}${n.label}</button>`;
      }).join("")}
      <button class="bn-item" data-action="menu:open">${h.icon("grid", 20)}Ещё</button>
    </nav>`;

    return `${sidebar}${mobileHead}${drawer}
    <main style="min-height:100vh"><div class="content"><div class="content-inner" id="view"></div></div></main>
    ${bottomnav}`;
  }

  // ---------- рендер текущего экрана ----------
  function renderView() {
    const el = document.getElementById("view");
    if (!el) return;
    let out;
    if (view === "market") out = ViewsTrade.market();
    else if (view === "trades") out = ViewsTrade.trades();
    else if (view === "accounts") out = ViewsTrade.accounts();
    else if (view === "portfolio") out = ViewsTrade.portfolio();
    else if (view === "whales") out = Views.whales(Store.state._whaleSym);
    else out = Views[view] ? Views[view]() : Views.desk();
    el.innerHTML = out.html;
    if (out.mount) out.mount();
    updateShell();
  }

  // обновление живых цифр в сайдбаре/хедере (без полного ререндера)
  function updateShell() {
    const s = Store.state;
    const btc = s.prices.BTC ? s.prices.BTC.price : 0;
    const sourceLabel = s.degraded ? "нет источника" : (s.source || "подключение…");
    const set = (id, text, cls) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = text;
      if (cls !== undefined) el.className = cls;
    };
    set("sb-balance", `${Fmt.fmtNum(s.balance)} ХРЮ`);
    set("sb-usd", `≈ ${Fmt.fmtUsd(s.balance)} · курс 1 ХРЮ = $1`);
    set("mh-balance", `${Fmt.fmtNum(s.balance)} ХРЮ`);
    set("sb-btc", `BTC $${Fmt.fmtPrice(btc)}`);
    set("dt-btc", `BTC $${Fmt.fmtPrice(btc)}`);
    const live = document.getElementById("sb-live");
    if (live) { live.textContent = sourceLabel; live.className = s.degraded ? "live-deg" : "live-ok"; }
    set("sb-status", s.degraded ? "Источники недоступны · торговля стоит" : "Реальные данные · " + sourceLabel);
    const dt = document.getElementById("dt-status");
    if (dt) dt.textContent = s.degraded ? "Рыночные источники недоступны — цены заморожены, торговля приостановлена" : "Данные в реальном времени · " + sourceLabel + " · спот";
    // бейджи
    document.querySelectorAll(".nav-item[data-action=nav]").forEach((b) => {
      const id = b.getAttribute("data-arg");
      const badge = b.querySelector(".nv-badge");
      const val = badgeFor(id);
      if (badgeVisible(val)) {
        if (badge) badge.textContent = val;
        else {
          const sp = document.createElement("span");
          sp.className = "nv-badge num";
          sp.textContent = val;
          b.appendChild(sp);
        }
      } else if (badge) badge.remove();
    });
  }

  // навигация
  function navigate(v) {
    view = VIEW_IDS.indexOf(v) !== -1 ? v : "desk";
    moreOpen = false;
    applyUrl(view);
    document.title = (VIEW_TITLES[view] ? VIEW_TITLES[view] + " · " : "") + BASE_TITLE;
    renderView();
    // активные пункты
    document.querySelectorAll("[data-action=nav]").forEach((b) => {
      b.classList.toggle("active", b.getAttribute("data-arg") === v);
    });
    // перерисовать каркас (шторка/активность)
    const root = document.getElementById("root");
    root.innerHTML = shellHtml();
    renderView();
    window.scrollTo({ top: 0 });
  }

  function scheduleRender() {
    if (renderTimer) return;
    const tick = () => {
      renderTimer = null;
      // не мешаем вводу: если фокус в поле — откладываем
      const ae = document.activeElement;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA") && ae.getAttribute("data-role")) {
        renderTimer = setTimeout(tick, 1200);
        return;
      }
      // не мешаем прокрутке (кейс мобильной версии): если пользователь скроллит список
      // токенов/позиций, полная перерисовка убивает инерционный скролл и «возвращает
      // обратно». Ждём паузы 800 мс; живые цифры (PnL) обновляются патчером и во время скролла
      if (Date.now() - lastUserScroll < 800) {
        renderTimer = setTimeout(tick, 350);
        return;
      }
      const now = Date.now();
      if (now - lastRender < 900) { renderTimer = setTimeout(tick, 900 - (now - lastRender)); return; }
      lastRender = now;
      renderView();
    };
    renderTimer = setTimeout(tick, 200);
  }

  // ---------- экран входа / сплэш ----------
  function renderAuth() {
    document.getElementById("root").innerHTML = Auth.authScreen();
  }

  // перерисовать открытую модалку настроек уведомлений после смены состояния
  function refreshNotifyModal() {
    const mr = document.getElementById("modal-root");
    if (mr && mr.childElementCount) h.showModal(ViewsTrade.notifyModal(), {});
  }

  async function afterLogin(creds) {
    document.getElementById("root").innerHTML = `
    <div class="splash">
      <div class="splash-inner">
        <span class="mark-wrap spin-slow" style="display:inline-block">${h.xenoMark(52)}</span>
        <div class="t"><span class="online-dot" style="background:var(--accent);width:6px;height:6px"></span> Загрузка платформы…</div>
      </div>
    </div>`;
    // R32: если бэкенд задеплоен — теми же кредами входим на сервер ПЕРЕД загрузкой
    // аккаунта: состояние сразу тянется с сервера, торговля идёт автономно 24/7
    if (creds && window.Server && Server.configured() && !Server.active()) {
      try {
        const r = await Server.login(creds.login, creds.password);
        if (r.ok) console.info("[xenoai] серверный аккаунт активен");
      } catch (e) { /* сервер недоступен — работаем локально */ }
    }
    Store.switchUser();
    setTimeout(() => {
      document.getElementById("root").innerHTML = shellHtml();
      navigate(viewFromUrl() || "desk"); // глубокая ссылка: /signals открывает Сигналы
      Store.start();
    }, 350);
  }

  // ---------- обработка действий ----------
  async function onAction(action, arg, ev) {
    const s = Store.state;
    switch (action) {
      case "nav": navigate(arg); break;
      case "menu:open": moreOpen = true; document.getElementById("root").innerHTML = shellHtml(); renderView(); break;
      case "menu:close": moreOpen = false; document.getElementById("root").innerHTML = shellHtml(); renderView(); break;
      case "menu:close-link": moreOpen = false; break;

      case "modal:close": h.closeModal(); break;
      case "cabinet:open": h.showModal(ViewsTrade.cabinet(), {}); break;
      case "cabinet:preset": {
        const inp = document.getElementById("hru-input");
        if (inp) inp.value = String(arg);
        break;
      }
      case "cabinet:apply": {
        const inp = document.getElementById("hru-input");
        const raw = inp ? inp.value : "";
        const v = Number(String(raw).replace(/\s/g, "").replace(",", "."));
        if (!Number.isFinite(v) || v <= 0) { h.toast("error", "Введите сумму больше нуля"); break; }
        Store.setBalance(Math.round(v));
        h.toast("success", `Баланс установлен: ${Fmt.fmtNum(Math.round(v))} ХРЮ`, "Демо-средства для торговли на реальных ценах Binance");
        h.closeModal();
        break;
      }
      case "cabinet:reset": Store.resetDemo(); h.toast("success", "Демо-счёт сброшен", "Все сделки и статистики обнулены"); h.closeModal(); break;

      // режимы: демо / реальный рынок
      case "mode:demo":
        Store.setMode("demo");
        document.getElementById("root").innerHTML = shellHtml();
        renderView();
        h.toast("info", "Демо-торговля", "Виртуальные ХРЮ · реальные рыночные цены");
        break;
      case "mode:live": {
        if (!(window.Live && Live.isConnected())) { h.showModal(ViewsTrade.liveModal(), { wide: true }); break; }
        const mOut = Store.setMode("live");
        if (!mOut.ok) { h.toast("error", mOut.error); h.showModal(ViewsTrade.liveModal(), { wide: true }); break; }
        document.getElementById("root").innerHTML = shellHtml();
        renderView();
        h.toast("success", "Реальный рынок", "Ордера идут на биржу · средства остаются у вас");
        break;
      }

      // реальный рынок: подключение
      case "live:open": h.showModal(ViewsTrade.liveModal(), { wide: true }); break;
      case "live:ex": s._liveEx = arg; h.showModal(ViewsTrade.liveModal(), { wide: true }); break;
      case "live:disconnect":
        Live.disconnect();
        if (s.mode === "live") Store.setMode("demo");
        h.showModal(ViewsTrade.liveModal(), { wide: true });
        h.toast("info", "Подключение разорвано");
        break;
      case "live:wallet": {
        if (!window.Live) break;
        Live.state.lastError = null;
        try {
          const w = await Live.connectWallet();
          h.toast("success", `Кошелёк подключён: ${w.address.slice(0, 6)}…${w.address.slice(-4)}`, "Баланс USDT читается из сети");
          h.showModal(ViewsTrade.liveModal(), { wide: true });
        } catch (e) {
          Live.state.lastError = e.message || String(e);
          h.toast("error", "Кошелёк не подключён", Live.state.lastError);
          h.showModal(ViewsTrade.liveModal(), { wide: true });
        }
        break;
      }
      case "live:keys": {
        if (!window.Live) break;
        Live.state.lastError = null;
        const kEl = document.getElementById("live-key");
        const sEl = document.getElementById("live-secret");
        const pEl = document.getElementById("live-pass");
        const creds = Live.saveKeys(s._liveEx || "binance", (kEl && kEl.value || "").trim(), (sEl && sEl.value || "").trim(), (pEl && pEl.value || "").trim());
        Live.__setCreds(creds);
        h.toast("info", "Проверяю ключи…", "Подписанный запрос к балансу биржи");
        try {
          const bal = await Live.testKeys(creds);
          h.toast("success", "Ключи работают", `USDT на бирже: ${Fmt.fmtNum(bal.usdt, 2)}`);
          if (s.mode === "live" || confirm("Подключено. Переключиться в реальный режим сейчас?")) {
            Store.setMode("live");
            document.getElementById("root").innerHTML = shellHtml();
            renderView();
          }
          h.showModal(ViewsTrade.liveModal(), { wide: true });
        } catch (e) {
          Live.state.lastError = e.message || String(e);
          h.toast("error", "Ключи не приняты биржей", Live.state.lastError);
          h.showModal(ViewsTrade.liveModal(), { wide: true });
        }
        break;
      }
      case "live:orders-toggle": {
        if (!window.Live) break;
        try {
          Live.setOrdersEnabled(!Live.ordersAllowed());
          h.toast(Live.ordersAllowed() ? "success" : "info", Live.ordersAllowed() ? "Отправка ордеров разрешена" : "Отправка ордеров запрещена");
        } catch (e) { h.toast("error", e.message || String(e)); }
        h.showModal(ViewsTrade.liveModal(), { wide: true });
        break;
      }

      // реальный ордер (спот, маркет)
      case "live:order": {
        if (!window.Live || !Live.isConnected()) { h.toast("error", "Нет подключения", "Подключите кошелёк или биржу"); break; }
        if (!Live.ordersAllowed()) { h.toast("error", "Отправка ордеров запрещена", "Подтвердите риск в окне «Управление подключением»"); h.showModal(ViewsTrade.liveModal(), { wide: true }); break; }
        const f2 = s._form;
        const price2 = (s.prices[f2.sym] && s.prices[f2.sym].price) || 0;
        const amt = Number(String(f2.size).replace(",", ".")) || 0;
        if (!price2) { h.toast("error", "Цена ещё загружается — секунду"); break; }
        if (amt < 10) { h.toast("error", "Минимум 10 USDT"); break; }
        const bal = Live.balanceUSDT();
        if (bal != null && amt > bal) { h.toast("error", "Недостаточно USDT на бирже", `Доступно: ${Fmt.fmtNum(bal, 2)} USDT`); break; }
        try {
          const inst2 = DataLib.BY_SYM[f2.sym];
          const ordPair = inst2 ? (inst2.pair || (f2.sym + "USDT")) : (f2.sym + "USDT");
          const ord = await Live.placeOrder({ sym: ordPair, side: f2.side, amountUSDT: amt, price: price2 });
          Store.recordLiveOrder({ sym: ord.sym, side: ord.side, amountUSDT: ord.amountUSDT, exchange: ord.exchange }, "маркет");
          h.toast("success", `Ордер отправлен: ${ord.sym} ${ord.side === "лонг" ? "BUY" : "SELL"}`, `${Fmt.fmtNum(amt)} USDT · ${ord.exchange}`);
        } catch (e) {
          h.toast("error", "Биржа не приняла ордер", e.message || String(e));
        }
        break;
      }
      case "live:order-ai": {
        if (!s._ai || s._ai.res.verdict === "wait") { h.toast("error", "Сначала запустите ИИ-анализ"); break; }
        s._form.side = s._ai.res.verdict;
        s._form.size = "100";
        h.toast("info", "Сигнал ИИ перенесён в форму", `Направление: ${s._ai.res.verdict} · укажите сумму USDT и отправьте ордер`);
        renderView();
        break;
      }

      // ИИ-сделка
      case "ai:analyze": {
        const sym = arg || s._form.sym || "BTC";
        if (!Store.canTrade()) { h.toast("error", "Сделки может открывать только аккаунт David или Yura"); break; }
        const bars = Store.getBars(sym, "15м");
        if (!bars || bars.length < 60) {
          Store.ensureBars(sym, "15м");
          h.toast("info", `Собираю свечи ${sym}…`, "Нажмите «Проанализировать» ещё раз через пару секунд");
          break;
        }
        const extra = {
          whale: (s.whales[sym] && s.whales[sym].length) ? null : null, // считаем в Store: aiWhaleBias приватный, здесь — только доп. факторы
          onchain: (window.WhalesDB && WhalesDB.bias) ? WhalesDB.bias(sym) : null,
          glm: (window.GLM && GLM.factor) ? GLM.factor(sym) : null,
        };
        const res = Engine.aiAnalyze(sym, bars, s.aiBrain, (s.news && s.news.items) || [], extra);
        if (!res) { h.toast("error", "Недостаточно данных для анализа", "Попробуйте ещё раз через несколько секунд"); break; }
        s._ai = { sym, res, ts: Date.now() };
        if (res.verdict === "wait") h.toast("info", "ИИ: сейчас входа нет", "Факторы разнонаправлены — лучше подождать");
        else h.toast("success", `ИИ рекомендует: ${res.verdict.toUpperCase()} ${sym}`, `уверенность ${res.confidence}% · стоп/цель по ATR · RR 1:2 · учтены новости`);
        renderView();
        break;
      }
      case "ai:open": {
        if (s.mode === "live") { h.toast("info", "Реальный режим", "Используйте кнопку «Отправить рыночный ордер» под вердиктом ИИ"); break; }
        if (!s._ai || s._ai.res.verdict === "wait") { h.toast("error", "Сначала запустите ИИ-анализ", "Кнопка «Проанализировать» в форме сделки"); break; }
        const r = s._ai.res;
        if (Date.now() - s._ai.ts > 240000) { h.toast("info", "Расчёт устарел", "Пересчитайте вердикт ИИ"); break; }
        // не догонять поезд: цена ушла от расчёта больше чем на 60% риска — пересчитать
        const curPx = (s.prices[r.sym] && s.prices[r.sym].price) || r.price;
        const driftPct = Math.abs(curPx - r.price) / r.price * 100;
        if (driftPct > (r.riskPct || 1) * 0.6) { h.toast("info", "Цена ушла от расчёта", `сигнал строился по ${Fmt.fmtPrice(r.price)}, сейчас ${Fmt.fmtPrice(curPx)} — пересчитайте вердикт`); break; }
        const sc = Store.aiSizeCalc();
        if (sc.size <= 0) { h.toast("error", "Размер не проходит по лимитам", `${sc.why} — поднимите лимиты в настройках ИИ или пополните счёт`); break; }
        const out = Store.placeDemo({ sym: r.sym, side: r.verdict, size: sc.size, lev: 1, stop: r.stop, target: r.target, strategy: "ai", ai: { confidence: r.confidence, note: r.note, factors: r.factors, score: r.score } });
        if (!out.ok) { h.toast("error", out.error); break; }
        h.toast("success", `ИИ-сделка открыта: ${r.sym} ${r.verdict}`, `${Fmt.fmtNum(sc.size)} ХРЮ · уверенность ${r.confidence}% · списано со счёта`);
        break;
      }

      // ИИ-автопилот и сканер
      case "ai:auto": {
        // в реальном режиме автопилот по умолчанию ВЫКЛ; включение — только явным
        // подтверждением риска (требование безопасности реального рынка)
        if (s.mode === "live" && !s.aiAutoLive) {
          const sure = confirm("Включить автопилот в РЕАЛЬНОМ режиме?\n\nИИ будет самостоятельно открывать и закрывать сделки-симуляции на реальных ценах (входы списывают виртуальные ХРЮ, реальные ордера по-прежнему отправляются только вручную). Авто-стоп сессии защитит лимитом ±" + (s.aiThreshold || 50) + "%.\n\nПродолжить?");
          if (!sure) break;
        }
        Store.toggleAiAuto();
        renderView();
        break;
      }
      // лимит авто-стопа сессии ИИ (±%): пресеты и свой ввод
      case "ai:limit": {
        const out = Store.setAiThreshold(Number(arg));
        if (!out.ok) { h.toast("error", out.error); break; }
        h.toast("success", `Лимит сессии ИИ: ±${Math.round(Number(arg))}%`, `при +${Math.round(Number(arg))}% профита или −${Math.round(Number(arg))}% просадки автопилот закроет все ИИ-сделки и выключится`);
        renderView();
        break;
      }
      case "ai:limit-apply": {
        const li = document.getElementById("ai-limit-input");
        const raw = li ? Number(String(li.value).replace(/\s/g, "").replace(",", ".")) : NaN;
        const res = Store.setAiThreshold(raw);
        if (!res.ok) { h.toast("error", res.error, "Введите число от 5 до 500"); break; }
        h.toast("success", `Лимит сессии ИИ: ±${Math.round(raw)}%`, `при +${Math.round(raw)}% профита или −${Math.round(raw)}% просадки автопилот закроет все ИИ-сделки и выключится`);
        renderView();
        break;
      }
      // R29 провальный порог (тело + N%): пресеты и свой ввод — единственный выход в минусе
      case "ai:fail": {
        const fo = Store.setFailPct(Number(arg));
        if (!fo.ok) { h.toast("error", fo.error); break; }
        h.toast("success", `Провальный порог: тело +${Math.round(Number(arg))}%`, Number(arg) === "0" ? "классический режим: закрытие сразу за стоп-линией" : "сделка в минусе ждёт цель; закроется только при ходе глубже тела ещё на " + Math.round(Number(arg)) + "%");
        renderView();
        break;
      }
      case "ai:fail-apply": {
        const fi = document.getElementById("ai-fail-input");
        const fr = Store.setFailPct(fi ? fi.value : NaN);
        if (!fr.ok) { h.toast("error", fr.error, "Введите число от 0 до 200"); break; }
        h.toast("success", `Провальный порог: тело +${Math.round(Store.state.failPct)}%`, "правило действует и в Страже — синхронизировано в облако");
        renderView();
        break;
      }
      // максимум одновременных ИИ-позиций: АВТО из лимитов или ручной 1..8
      case "ai:maxpos": {
        const mpOut = Store.setAiPosMode(arg === "auto" ? "auto" : Number(arg));
        if (!mpOut.ok) { h.toast("error", mpOut.error); break; }
        if (arg === "auto") h.toast("success", `ИИ-позиций: АВТО · ${Store.autoMaxPos()}`, `считается из лимитов: ${Fmt.fmtNum(Store.aiTotalCap())} ÷ ${Fmt.fmtNum(Store.aiDealCap())} = до ${Store.autoMaxPos()} одновременных сделок`);
        else h.toast("success", `Ручной лимит ИИ-позиций: ${arg}`, `автопилот будет держать в рынке не больше ${arg} сделок одновременно`);
        renderView();
        break;
      }
      // лимит суммы одной сделки (ХРЮ ≈ $)
      case "ai:deal": {
        const di = document.getElementById("ai-deal-input");
        const dealOut = Store.setMaxDeal(di ? di.value : NaN);
        if (!dealOut.ok) { h.toast("error", dealOut.error, "Введите сумму от 5 до 100 000 ХРЮ"); break; }
        h.toast("success", `Максимум одной сделки: ${Fmt.fmtNum(Store.aiDealCap())} ХРЮ (≈ $${Fmt.fmtNum(Store.aiDealCap())})`, `одновременных ИИ-позиций теперь до ${Store.autoMaxPos()} (авто из лимитов)`);
        renderView();
        break;
      }
      // суммарный лимит всех сделок (ХРЮ ≈ $)
      case "ai:total": {
        const ti = document.getElementById("ai-total-input");
        const totOut = Store.setMaxTotal(ti ? ti.value : NaN);
        if (!totOut.ok) { h.toast("error", totOut.error, `минимум — лимит одной сделки (${Fmt.fmtNum(Store.aiDealCap())} ХРЮ)`); break; }
        h.toast("success", `Суммарный лимит сделок: ${Fmt.fmtNum(Store.aiTotalCap())} ХРЮ (≈ $${Fmt.fmtNum(Store.aiTotalCap())})`, `одновременных ИИ-позиций теперь до ${Store.autoMaxPos()} · чем больше сумма — тем больше параллельных входов`);
        renderView();
        break;
      }
      // карточка прогноза: на чём основана уверенность ИИ в сигнале/идее
      case "sig:forecast":
        h.showModal(Views.signalForecast(arg), { wide: true });
        break;
      case "ai:open-idea": {
        const idea = (s.aiIdeas || []).find((i) => i.sym === arg);
        if (!idea || idea.res.verdict === "wait") { h.toast("error", "Идея устарела — подождите пересчёта"); break; }
        if (!Store.canTrade()) { h.toast("error", "Сделки может открывать только аккаунт David или Yura"); break; }
        // не догонять поезд: цена ушла от расчёта больше чем на 60% риска.
        // R40: вместо тупика «дождитесь пересчёта» — свежий пересчёт ансамбля по
        // живым 15м-свечам прямо здесь: подтверждает направление — открываем по
        // свежим уровням; «wait» или снова дрейф — честно объясняем и ждём сервер.
        const curIdea = (s.prices[idea.sym] && s.prices[idea.sym].price) || idea.res.price;
        const driftIdea = Math.abs(curIdea - idea.res.price) / idea.res.price * 100;
        let useRes = idea.res;
        if (driftIdea > (idea.res.riskPct || 1) * 0.6) {
          const barsIdea = Store.getBars(idea.sym, "15м");
          if (!barsIdea || barsIdea.length < 60) {
            Store.ensureBars(idea.sym, "15м");
            h.toast("info", `Собираю свежие свечи ${idea.sym}…`, "Нажмите «Открыть в демо» ещё раз через пару секунд — идея будет пересчитана по живым данным");
            break;
          }
          const extraIdea = {
            whale: null,
            onchain: (window.WhalesDB && WhalesDB.bias) ? WhalesDB.bias(idea.sym) : null,
            glm: (window.GLM && GLM.factor) ? GLM.factor(idea.sym) : null,
          };
          const fresh = Engine.aiAnalyze(idea.sym, barsIdea, s.aiBrain, (s.news && s.news.items) || [], extraIdea);
          const freshDrift = fresh && fresh.price ? Math.abs(curIdea - fresh.price) / fresh.price * 100 : Infinity;
          if (!fresh || fresh.verdict === "wait" || freshDrift > (fresh.riskPct || 1) * 0.6) {
            h.toast("info", "Цена ушла от расчёта", `${idea.sym}: идея строилась по ${Fmt.fmtPrice(idea.res.price)}, сейчас ${Fmt.fmtPrice(curIdea)} — свежий пересчёт вход не подтверждает, сервер обновит идею на закрытии 15м-свечи`);
            break;
          }
          useRes = fresh;
        }
        const szSc = Store.aiSizeCalc();
        if (szSc.size <= 0) { h.toast("error", "Размер не проходит по лимитам", `${szSc.why} — поднимите лимиты или пополните счёт`); break; }
        const ideaOut = Store.placeDemo({ sym: idea.sym, side: useRes.verdict, size: szSc.size, lev: 1, stop: useRes.stop, target: useRes.target, strategy: "ai", ai: { confidence: useRes.confidence, note: useRes.note, factors: useRes.factors, score: useRes.score } });
        if (!ideaOut.ok) { h.toast("error", ideaOut.error); break; }
        h.toast("success", `Идея ИИ взята: ${idea.sym} ${useRes.verdict}`, `${Fmt.fmtNum(szSc.size)} ХРЮ · уверенность ${useRes.confidence}%${useRes !== idea.res ? " · по свежему пересчёту" : ""}`);
        break;
      }

      // сигналы
      case "sig:take": {
        if (!Store.canTrade()) { h.toast("error", "Сделки может открывать только аккаунт David или Yura"); break; }
        const sym = arg;
        // размер сигнала — 500 ХРЮ, но не выше лимитов счёта (одна сделка / суммарный)
        const sigSize = Math.min(500, Store.aiDealCap(), Math.round(Store.aiTotalRemain()), Math.round(s.balance));
        if (sigSize < 10) { h.toast("error", "Сделка не влезает в лимиты", Store.aiTotalRemain() < 10 ? "суммарный лимит исчерпан — закройте часть сделок" : s.balance < 10 ? "пополните демо-счёт в кабинете" : `лимит одной сделки — ${Fmt.fmtNum(Store.aiDealCap())} ХРЮ`); break; }
        const sigOut = Store.placeDemo({ sym, side: "лонг", size: sigSize, lev: 1 });
        if (!sigOut.ok) { h.toast("error", sigOut.error); break; }
        h.toast("success", `Сигнал взят в демо: ${sym}`, `${Fmt.fmtNum(sigSize)} ХРЮ списаны со счёта · цена ${Fmt.fmtPrice((s.prices[sym] && s.prices[sym].price) || 0)}`);
        break;
      }

      // киты
      case "whale:sym":
        s._whaleSym = arg;
        Store.loadWhales(arg);
        renderView();
        break;

      // рынок
      case "mkt:sym": Store.setActiveSym(arg); break;
      case "mkt:tf": s._mkt.tf = arg; Store.ensureBars(s.activeSym, arg); renderView(); break;
      case "mkt:ema": s._mkt.emaOn = !s._mkt.emaOn; renderView(); break;
      case "mkt:whales": s._mkt.whalesOn = !s._mkt.whalesOn; renderView(); break;
      case "mkt:gaps": s._mkt.gapsOn = !s._mkt.gapsOn; renderView(); break;
      case "mkt:whales-on":
        if (!s._mkt.whalesOn) s._mkt.whalesOn = true;
        Store.loadWhales(s.activeSym);
        renderView();
        break;

      // форма сделки
      case "form:sym": s._form.sym = arg; renderView(); break;
      case "form:side": s._form.side = arg; renderView(); break;
      case "form:submit": {
        if (s.mode === "live") { h.toast("info", "Реальный режим", "Нажмите кнопку отправки ордера под формой"); break; }
        const f = s._form;
        const price = (s.prices[f.sym] && s.prices[f.sym].price) || 0;
        const sizeNum = Number(String(f.size).replace(",", ".")) || 0;
        if (!price) { h.toast("error", "Цена ещё загружается — секунду"); break; }
        if (sizeNum < 10) { h.toast("error", "Минимум 10 ХРЮ"); break; }
        const out = Store.placeDemo({ sym: f.sym, side: f.side, size: Math.round(sizeNum), lev: f.lev });
        if (!out.ok) { h.toast("error", out.error); break; }
        h.toast("success", `${f.sym} ${f.side} открыт`, `${Fmt.fmtNum(Math.round(sizeNum))} ХРЮ списаны со счёта · цена ${Fmt.fmtPrice(price)}`);
        break;
      }

      // сделки
      case "trades:tab": s._tradesTab = arg === "мои" ? "user" : "lab"; renderView(); break;

      // свернуть/развернуть плашку позиций лаборатории (настройка устройства, localStorage)
      case "trades:labfold": {
        const cur = (() => { try { return localStorage.getItem("xenoai_lab_fold") === "1"; } catch (e) { return false; } })();
        try { localStorage.setItem("xenoai_lab_fold", cur ? "0" : "1"); } catch (e) {}
        renderView();
        break;
      }

      // экспорт истории сделок в CSV
      case "stats:export": {
        const rows = s.userClosed;
        if (!rows.length) { h.toast("error", "Пока нечего экспортировать", "Закройте первую сделку — история появится здесь"); break; }
        const q = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
        const lines = ["Дата закрытия;Монета;Направление;Вход;Выход;Объём ХРЮ;PnL ХРЮ;PnL %;Причина;Источник"];
        for (const c of rows) {
          const d = new Date(c.closedAt);
          const src = c.strategy === "ai" ? (c.ai && c.ai.auto ? "ИИ-автопилот" : "Сигнал ИИ") : "Вручную";
          lines.push([
            q(d.toLocaleString("ru-RU")), c.sym, c.side,
            String(c.entry), String(c.exit),
            String(Math.round(c.size)), (Math.round(c.pnl * 100) / 100).toFixed(2),
            (Math.round(c.pnlPct * 100) / 100).toFixed(2) + "%", c.exitReason, src,
          ].join(";"));
        }
        const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        const u = Auth.readSession();
        a.download = `xenoai-trades-${u ? u.login.toLowerCase() : "demo"}-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400);
        h.toast("success", `История выгружена: ${rows.length} сделок`, "CSV открыт в Excel/Numbers · кодировка UTF-8");
        break;
      }

      // очистка истории закрытых сделок (мои / лаборатория) — удалённое не воскресает
      // после синхронизации: id попадают в «могилки», которые едут в облако
      case "stats:clear": {
        const isLab = arg === "lab";
        const sureClear = confirm(isLab
          ? "Удалить всю закрытую историю лаборатории?\n\nБаланс и открытые позиции не изменятся, память ИИ сохранится. После синхронизации история очистится и на других устройствах. Отменить будет нельзя."
          : "Удалить всю вашу закрытую историю сделок?\n\nБаланс и открытые позиции не изменятся, память ИИ сохранится. После синхронизации история очистится и на других устройствах. Отменить будет нельзя.");
        if (!sureClear) break;
        const clrOut = Store.clearClosedHistory(isLab ? "lab" : "user");
        if (!clrOut.ok) { h.toast("error", clrOut.error); break; }
        h.toast("success", `История очищена: удалено ${clrOut.n}`, "Баланс и открытые позиции не тронуты · память ИИ сохранена");
        break;
      }

      case "pos:close": {
        const pos = s.userPositions.find((p) => p.id === arg);
        const cOut = Store.closeDemo(arg);
        if (!cOut.ok) { h.toast("error", cOut.error); break; }
        if (pos) h.toast("success", `Позиция ${pos.sym} закрыта по рыночной цене`, `${cOut.closed.pnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(cOut.closed.pnl)))} ХРЮ вернулись на счёт (после комиссии)`);
        break;
      }

      // ---------- PWA: системные уведомления + полный экран ----------
      case "notify:open":
        if (Notify.pushInfo) { Notify.pushInfo().catch(() => {}); }
        setTimeout(() => h.showModal(ViewsTrade.notifyModal(), {}), Notify.pushInfo ? 350 : 0);
        break;
      case "notify:master": {
        if (!window.Notify) break;
        if (Notify.getSettings().on) {
          Notify.disable();
          updateBellButtons();
          h.toast("info", "Уведомления выключены", "Сделки ИИ по-прежнему видны в ленте событий");
          refreshNotifyModal();
          break;
        }
        Notify.enable().then((r) => {
          updateBellButtons();
          if (r.ok) h.toast("success", "Уведомления включены", "ИИ сообщит о сделках, профите/минусе и авто-стопе сессии");
          else h.toast("error", "Уведомления не включены", r.why);
          refreshNotifyModal();
        });
        break;
      }
      case "notify:ev":
        Notify.setEvent(arg, !Notify.getSettings().events[arg]);
        refreshNotifyModal();
        break;
      case "notify:opt":
        Notify.set(arg, !Notify.getSettings()[arg]);
        refreshNotifyModal();
        break;
      case "notify:minpnl":
        Notify.setMinPnl(arg);
        refreshNotifyModal();
        break;
      case "notify:minpnl-apply": {
        const npEl = document.getElementById("notify-minpnl");
        Notify.setMinPnl(npEl ? npEl.value : 0);
        const mp = Notify.getSettings().minPnl;
        h.toast("success", `Порог закрытий: ${mp === 0 ? "присылать все" : "только ≥ " + mp + " ХРЮ"}`, "Курс 1 ХРЮ = $1 — порог считается и в хрювнах, и в долларах");
        refreshNotifyModal();
        break;
      }
      case "notify:test": {
        const tRes = Notify.test();
        if (!tRes.ok) h.toast("error", "Пробное уведомление не отправлено", tRes.why);
        break;
      }
      case "notify:push-enable": {
        if (!Notify.pushSupported || !Notify.pushSupported()) {
          h.toast("error", "Пуши недоступны здесь", (Notify.pushSupportedStop && Notify.pushSupportedStop()) || "нужен https и поддержка Web Push");
          break;
        }
        if (Notify.permission() !== "granted") {
          // единственное действие пользователя — разрешение; подписка создаётся следом сама
          Notify.enable().then((r) => {
            updateBellButtons();
            if (r.ok) h.toast("success", "Пуши включены", "Подписка устройства сохранена — Страж пришлёт пуш о сделке даже при закрытом приложении");
            else h.toast("error", "Не удалось включить", r.why || "разрешение не выдано");
            refreshNotifyModal();
          });
          break;
        }
        h.toast("info", "Подписываю устройство…", "Создаю подписку Web Push и сохраняю её в аккаунт для Стража");
        Notify.ensureSubscription().then((r) => {
          if (r.ok) h.toast("success", "Устройство подписано на пуши", "События сделок будут приходить даже при полностью закрытом приложении (Страж, каждые ~15 минут)");
          else h.toast("error", "Подписка не создана", r.why || "попробуйте ещё раз");
          refreshNotifyModal();
        });
        break;
      }
      case "notify:push-test": {
        // R42: настоящий тестовый пуш с сервера — честная проверка всей цепочки доставки
        if (!window.Server || !Server.active()) {
          h.toast("error", "Сервер не активен", "Тестовый пуш отправляет сервер — дождитесь подключения к бэкенду");
          break;
        }
        const out = document.getElementById("push-test-result");
        if (out) out.innerHTML = '<span class="np-warn">отправляю с сервера…</span>';
        const tr = await Server.pushTest();
        if (!tr.ok) {
          if (out) out.innerHTML = "";
          h.toast("error", "Тест не удался", tr.error || "сервер недоступен");
          break;
        }
        const sent = tr.sent || 0, total = (tr.results || []).length;
        const detail = (tr.results || []).map((x) => "…" + x.endpoint + " · HTTP " + x.status).join(" · ");
        if (out) out.innerHTML = total
          ? `<span class="${sent ? "np-ok" : "np-warn"} num">${sent}/${total} доставлено · ${h.esc(detail)}</span>`
          : '<span class="np-warn">на сервере нет подписок — включите пуши выше</span>';
        h.toast(sent ? "success" : "error",
          sent ? "Тестовый пуш отправлен сервером" : "Пуш не доставлен",
          sent ? "Смотрите шторку уведомлений устройства — и всплывашку здесь, в приложении" : (detail || "нет подписок"));
        break;
      }
      case "fs:toggle": {
        if (!window.Notify) break;
        const fsNow = await Notify.toggleFullscreen();
        document.querySelectorAll(".fs-icon").forEach((b) => { b.innerHTML = h.icon(fsNow ? "minimize" : "maximize", 15); });
        refreshNotifyModal();
        break;
      }

      // счета
      case "account:auto": Store.toggleAuto(); break;

      // ---------- синхронизация устройств + файловый бэкап ----------
      // синк всегда включён (единый аккаунт = единые данные) — опций вкл/выкл нет
      case "sync:now": {
        h.toast("info", "Синхронизирую…", "читаю облако, сливаю без потерь, записываю");
        Store.syncPull().then((changed) => {
          h.toast(changed ? "success" : "info", changed ? "Архив обновлён из облака" : "Уже актуально", changed ? "история объединена без потерь" : "локальные данные совпадают с сервером");
          h.showModal(ViewsTrade.cabinet(), {});
        });
        break;
      }
      case "sync:copy": {
        const info = Store.syncInfo();
        const txt = info.code || "";
        const done = () => h.toast("success", "Код скопирован", txt + " — он выводится из логина и одинаков на всех устройствах");
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, done);
        else done();
        break;
      }
      case "backup:export": {
        const data = Store.exportBackup();
        const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        const u = Auth.readSession();
        a.download = `xenoai-backup-${u ? u.login.toLowerCase() : "account"}-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400);
        h.toast("success", "Архив скачан", "полный снимок аккаунта: баланс, позиции, вся история");
        break;
      }
      case "backup:import": {
        const fi = document.getElementById("backup-file");
        if (!fi) break;
        if (!fi.dataset.bound) {
          fi.dataset.bound = "1";
          fi.addEventListener("change", () => {
            const file = fi.files && fi.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
              const res = Store.importBackup(String(reader.result || ""));
              if (res.ok) h.toast("success", "Архив восстановлен", "история объединена без потерь");
              else h.toast("error", "Файл не принят", res.error);
              h.showModal(ViewsTrade.cabinet(), {});
            };
            reader.readAsText(file);
            fi.value = "";
          });
        }
        fi.click();
        break;
      }

      // ---------- GLM-аналитик (13-й фактор) ----------
      case "glm:open": h.showModal(ViewsTrade.glmModal(), {}); break;
      case "glm:preset": {
        const pr = GLM.setPreset(arg);
        if (!pr.ok) { h.toast("error", pr.error); break; }
        h.showModal(ViewsTrade.glmModal(), {});
        break;
      }
      case "glm:save": {
        const keyEl = document.getElementById("glm-key");
        const modEl = document.getElementById("glm-model");
        const res = GLM.save({ apiKey: keyEl ? keyEl.value : "", model: modEl ? modEl.value : "", on: true });
        if (!res.ok) { h.toast("error", res.error); break; }
        h.toast("success", "GLM подключён", "языковая модель теперь 13-й фактор ансамбля · вердикт появится в течение минуты");
        h.showModal(ViewsTrade.glmModal(), {});
        renderView();
        break;
      }
      case "glm:off": {
        GLM.save({ on: false });
        h.toast("info", "Фактор GLM выключен", "12 рыночных факторов работают как раньше");
        h.showModal(ViewsTrade.glmModal(), {});
        renderView();
        break;
      }
      case "glm:test": {
        const keyEl2 = document.getElementById("glm-key");
        const modEl2 = document.getElementById("glm-model");
        if (keyEl2 && keyEl2.value.trim()) GLM.save({ apiKey: keyEl2.value, model: modEl2 ? modEl2.value : "" });
        h.toast("info", "Спрашиваю GLM…", "запрос к модели с текущей сводкой рынка");
        GLM.ask().then((v) => {
          if (v.status === "ok") h.toast("success", `GLM: ${v.bias === "flat" ? "вне рынка" : v.bias} ${v.confidence}%`, v.reasoning || "");
          else h.toast("error", "GLM не ответил", v.error || "проверьте ключ и модель");
          h.showModal(ViewsTrade.glmModal(), {});
        });
        break;
      }

      // авторизация
      case "auth:tab": Auth.setTab(arg); renderAuth(); break;
      case "auth:eye": Auth.toggleEye(); Auth.readInputs(); renderAuth(); break;
      case "auth:logout": Auth.logout(); location.reload(); break;
    }
  }

  // ---------- глобальные слушатели ----------
  function bindEvents() {
    document.addEventListener("click", (e) => {
      const t = e.target.closest("[data-action]");
      if (!t) return;
      const action = t.getAttribute("data-action");
      const arg = t.getAttribute("data-arg");
      if (action === "menu:close-link") { moreOpen = false; return; } // ссылка — даём перейти
      e.preventDefault();
      onAction(action, arg, e);
    });

    document.addEventListener("submit", (e) => {
      if (e.target && e.target.id === "auth-form") {
        e.preventDefault();
        Auth.submit();
      }
    });

    document.addEventListener("input", (e) => {
      const el = e.target;
      if (el.id === "auth-login" || el.id === "auth-pass") {
        Auth.readInputs();
        const btn = document.querySelector(".btn-enter");
        if (btn) btn.disabled = !Auth.credsReady();
        return;
      }
      if (el.getAttribute && el.getAttribute("data-role") === "form-size") {
        const clean = el.value.replace(/[^\d.,]/g, "");
        if (clean !== el.value) el.value = clean;
        Store.state._form.size = clean;
      } else if (el.getAttribute && el.getAttribute("data-role") === "form-lev") {
        Store.state._form.lev = Number(el.value);
        const lv = el.parentElement.querySelector(".lv");
        if (lv) lv.textContent = "×" + el.value;
        const btn = document.querySelector(".btn-open");
        if (btn) {
          const f = Store.state._form;
          const sizeNum = Number(String(f.size).replace(",", ".")) || 0;
          btn.innerHTML = `${f.side === "лонг" ? "Открыть лонг" : "Открыть шорт"} · ${sizeNum ? Fmt.fmtNum(sizeNum) : "0"} ХРЮ`;
        }
      } else if (el.getAttribute && el.getAttribute("data-role") === "cab-balance") {
        const clean = el.value.replace(/[^\d.,\s]/g, "");
        if (clean !== el.value) el.value = clean;
      } else if (el.getAttribute && el.getAttribute("data-role") === "ai-limit") {
        const clean = el.value.replace(/[^\d]/g, "");
        if (clean !== el.value) el.value = clean;
      } else if (el.getAttribute && el.getAttribute("data-role") === "notify-minpnl") {
        const clean = el.value.replace(/[^\d]/g, "");
        if (clean !== el.value) el.value = clean;
      }
    });

    document.addEventListener("change", (e) => {
      const el = e.target;
      if (el && el.id === "live-risk" && window.Live) {
        Live.acceptRisk(el.checked);
        h.toast("info", el.checked ? "Риск подтверждён" : "Подтверждение риска снято",
          el.checked ? "Теперь можно разрешить отправку ордеров" : "Отправка ордеров запрещена");
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") h.closeModal();
    });
  }

  // ---------- загрузка ----------
  function bindGlobalGuards() {
    // самодиагностика: любые ошибки платформы попадают в ленту событий (и в консоль) —
    // ничего не ломается молча, состояние не сбрасывается
    window.addEventListener("error", (e) => {
      if (window.Store && Store.state && Store.state.started) {
        try { Store._diagError("окно", e.error || e.message); } catch (x) { /* noop */ }
      }
    });
    window.addEventListener("unhandledrejection", (e) => {
      if (window.Store && Store.state && Store.state.started) {
        try { Store._diagError("сеть/промисы", e.reason); } catch (x) { /* noop */ } 
      }
    });
    // несколько вкладок одного аккаунта: изменение в другой вкладке подтягивается сюда
    window.addEventListener("storage", (e) => {
      if (!window.Store || !Store.state.started) return;
      const login = Auth.sessionLogin();
      const key = login ? `xenoai_v3_${login.toLowerCase()}` : "";
      if (!key || e.key !== key || !e.newValue) return;
      try {
        const d = JSON.parse(e.newValue);
        if (typeof d.rev === "number" && d.rev > (Store.state.rev || 0)) {
          Store._applyArchive(d);
          Store.emit();
        }
      } catch (err) { /* битый кадр — игнор */ }
    });
  }

  function boot() {
    bindGlobalGuards();
    bindEvents();
    Store.subscribe(scheduleRender);
    // защита мобильного скролла: запоминаем любую прокрутку/тач (capture — ловим и скролл
    // внутри контейнеров). Полный ререндер откладывается, пока пользователь скроллит (см. scheduleRender)
    const markScroll = () => { lastUserScroll = Date.now(); };
    window.addEventListener("scroll", markScroll, { passive: true, capture: true });
    window.addEventListener("touchstart", markScroll, { passive: true });
    window.addEventListener("touchmove", markScroll, { passive: true });
    if (window.Live) Live.onChange(() => { scheduleRender(); });
    if (window.Binance) Binance.onSourceChange((id) => { Store.state.source = id; scheduleRender(); });
    // живой PnL: патчер на каждом тике WebSocket + страховка раз в секунду
    Store.onFastTick(patchPnl);
    setInterval(patchPnl, 1000);
    // PWA: service worker — оффлайн-кэш + показ системных уведомлений (только https/localhost)
    if ("serviceWorker" in navigator && (location.protocol === "https:" || ["localhost", "127.0.0.1"].indexOf(location.hostname) !== -1)) {
      window.addEventListener("load", () => { navigator.serviceWorker.register("sw.js").catch(() => { /* file:// или без поддержки — не критично */ }); });
    }
    // PWA: иконка полного экрана меняется, когда пользователь выходит из него системной кнопкой
    ["fullscreenchange", "webkitfullscreenchange"].forEach((evName) => {
      document.addEventListener(evName, () => {
        const fsOn = Boolean(window.Notify && Notify.fsElement());
        document.querySelectorAll(".fs-icon").forEach((b) => { b.innerHTML = h.icon(fsOn ? "minimize" : "maximize", 15); });
        refreshNotifyModal();
      });
    });
    // кнопки «назад/вперёд» и смена hash открывают соответствующую вкладку
    window.addEventListener("popstate", onUrlChange);
    window.addEventListener("hashchange", () => { if (!hashNav) onUrlChange(); });
    if (Auth.readSession()) {
      afterLogin();
    } else {
      renderAuth();
    }
    // ончейн-база китов + GLM-аналитик: фоновые опросы стартуют вместе с платформой
    if (window.WhalesDB && WhalesDB.start) WhalesDB.start();
    if (window.GLM && GLM.start) GLM.start();
  }

  return { boot, navigate, renderAuth, renderView, afterLogin, updateShell };
})();

window.App = App;

// скрипты с defer — DOM уже готов
App.boot();
