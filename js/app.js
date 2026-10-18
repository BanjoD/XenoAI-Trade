// XenoAI Trade — каркас приложения: сайдбар + мобильная навигация + роутер
"use strict";

const App = (() => {
  const h = UI;
  let view = "desk";
  let moreOpen = false;
  let renderTimer = null;
  let lastRender = 0;

  const NAV = [
    { id: "desk", label: "Деск", icon: "grid" },
    { id: "signals", label: "Сигналы", icon: "zap" },
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

  function badgeFor(id) {
    const s = Store.state;
    if (id === "events") return s.events.length;
    if (id === "trades") return s.labPositions.length + s.userPositions.length;
    if (id === "signals") return s.signals.length;
    return undefined;
  }

  function navItem(n, active, badge) {
    return `<button class="nav-item ${active ? "active" : ""}" data-action="nav" data-arg="${n.id}">
      ${h.icon(n.icon, 17)}
      <span style="flex:1;text-align:left">${n.label}</span>
      ${badge !== undefined && badge > 0 ? `<span class="nv-badge num">${badge}</span>` : ""}
    </button>`;
  }

  function shellHtml() {
    const s = Store.state;
    const user = Auth.readSession();
    const btc = s.prices.BTC ? s.prices.BTC.price : 0;

    const sidebar = `
    <aside class="sidebar">
      <button class="sb-logo" data-action="nav" data-arg="desk">${h.xenoLogo()}</button>

      <div class="balance-card">
        <div class="balance-row">
          <span class="balance-label">Демо-баланс</span>
          <span class="balance-value num" id="sb-balance">${Fmt.fmtNum(s.balance)} ХРЮ</span>
        </div>
        <div class="balance-sub num">
          <span id="sb-btc">BTC $${Fmt.fmtPrice(btc)}</span>
          <span id="sb-live" class="${s.degraded ? "live-deg" : "live-ok"}">${s.degraded ? "симуляция" : "binance live"}</span>
        </div>
        <button class="btn-lime" data-action="cabinet:open">Кабинет · пополнить</button>
      </div>

      <nav class="sb-nav scroll">
        ${NAV.map((n) => navItem(n, view === n.id, badgeFor(n.id))).join("")}
        <div class="sb-sep"></div>
        ${NAV2.map((n) => navItem(n, view === n.id, badgeFor(n.id))).join("")}
      </nav>

      <div class="sb-foot">
        <div class="status-row">
          <div class="status-left">
            ${h.onlineDot()}
            <span id="sb-status">${s.degraded ? "Демо-симуляция" : "Реальные данные"}</span>
          </div>
          <span class="status-role">${user ? user.role : "admin"}</span>
        </div>
        <div class="user-card">
          <span class="user-avatar">${user ? user.login.slice(0, 1).toUpperCase() : "A"}</span>
          <div style="min-width:0;flex:1">
            <div class="user-name">${user ? h.esc(user.login) : "—"}</div>
            <div class="user-role">Администратор</div>
          </div>
          <button class="btn-logout" data-action="auth:logout" title="Выйти из аккаунта" aria-label="Выйти из аккаунта">${h.icon("logout", 15)}</button>
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
          <button class="btn-menu" data-action="menu:open" aria-label="Меню">${h.icon("menu", 18)}</button>
        </div>
      </div>
      <div class="desk-topline">
        <span class="t" id="dt-status">${s.degraded ? "Binance недоступен — работает симуляция" : "Данные в реальном времени · Binance spot"}</span>
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
    const set = (id, text, cls) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = text;
      if (cls !== undefined) el.className = cls;
    };
    set("sb-balance", `${Fmt.fmtNum(s.balance)} ХРЮ`);
    set("mh-balance", `${Fmt.fmtNum(s.balance)} ХРЮ`);
    set("sb-btc", `BTC $${Fmt.fmtPrice(btc)}`);
    set("dt-btc", `BTC $${Fmt.fmtPrice(btc)}`);
    const live = document.getElementById("sb-live");
    if (live) { live.textContent = s.degraded ? "симуляция" : "binance live"; live.className = s.degraded ? "live-deg" : "live-ok"; }
    set("sb-status", s.degraded ? "Демо-симуляция" : "Реальные данные");
    const dt = document.getElementById("dt-status");
    if (dt) dt.textContent = s.degraded ? "Binance недоступен — работает симуляция" : "Данные в реальном времени · Binance spot";
    // бейджи
    document.querySelectorAll(".nav-item[data-action=nav]").forEach((b) => {
      const id = b.getAttribute("data-arg");
      const badge = b.querySelector(".nv-badge");
      const val = badgeFor(id);
      if (val !== undefined && val > 0) {
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
    view = v;
    moreOpen = false;
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

  function afterLogin() {
    document.getElementById("root").innerHTML = `
    <div class="splash">
      <div class="splash-inner">
        ${h.xenoMark(52)}
        <div class="t"><span class="online-dot" style="background:var(--lime);width:6px;height:6px"></span> Загрузка платформы…</div>
      </div>
    </div>`;
    Store.switchUser();
    setTimeout(() => {
      document.getElementById("root").innerHTML = shellHtml();
      navigate("desk");
      Store.start();
    }, 350);
  }

  // ---------- обработка действий ----------
  function onAction(action, arg, ev) {
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
      case "cabinet:reset": Store.resetDemo(); h.toast("success", "Демо-счёт сброшен"); h.closeModal(); break;

      // сигналы
      case "sig:take": {
        if (s.balance < 100) { h.toast("error", "Недостаточно хрювен", "Пополните демо-счёт в кабинете"); break; }
        const sym = arg;
        Store.placeDemo({ sym, side: "лонг", size: 500, lev: 1 });
        h.toast("success", `Сигнал взят в демо: ${sym}`, `500 ХРЮ по текущей цене ${Fmt.fmtPrice((s.prices[sym] && s.prices[sym].price) || 0)}`);
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
        const f = s._form;
        const price = (s.prices[f.sym] && s.prices[f.sym].price) || 0;
        const sizeNum = Number(String(f.size).replace(",", ".")) || 0;
        if (!price) { h.toast("error", "Цена ещё загружается — секунду"); break; }
        if (sizeNum < 10) { h.toast("error", "Минимум 10 ХРЮ"); break; }
        if (sizeNum > s.balance) { h.toast("error", "Недостаточно хрювен на демо-счёте", `Доступно: ${Fmt.fmtNum(s.balance)} ХРЮ`); break; }
        Store.placeDemo({ sym: f.sym, side: f.side, size: sizeNum, lev: f.lev });
        h.toast("success", `${f.sym} ${f.side} ×${f.lev} открыт`, `${Fmt.fmtNum(sizeNum)} ХРЮ по реальной цене ${Fmt.fmtPrice(price)}`);
        break;
      }

      // сделки
      case "trades:tab": s._tradesTab = arg === "мои" ? "user" : "lab"; renderView(); break;
      case "pos:close": {
        const pos = s.userPositions.find((p) => p.id === arg);
        Store.closeDemo(arg);
        if (pos) h.toast("success", `Позиция ${pos.sym} закрыта по рыночной цене`);
        break;
      }

      // счета
      case "account:auto": Store.toggleAuto(); break;

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
          btn.innerHTML = `${f.side === "лонг" ? "Открыть лонг" : "Открыть шорт"} · ${sizeNum ? Fmt.fmtNum(sizeNum) : "0"} ХРЮ ×${f.lev}`;
        }
      } else if (el.getAttribute && el.getAttribute("data-role") === "cab-balance") {
        const clean = el.value.replace(/[^\d.,\s]/g, "");
        if (clean !== el.value) el.value = clean;
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") h.closeModal();
    });
  }

  // ---------- загрузка ----------
  function boot() {
    bindEvents();
    Store.subscribe(scheduleRender);
    if (Auth.readSession()) {
      afterLogin();
    } else {
      renderAuth();
    }
  }

  return { boot, navigate, renderAuth, renderView, afterLogin, updateShell };
})();

window.App = App;

// скрипты с defer — DOM уже готов
App.boot();
