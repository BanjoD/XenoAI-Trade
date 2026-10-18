// XenoAI Trade — авторизация: два администраторских аккаунта.
// Регистрация закрыта: вход только по выданным доступам.
"use strict";

const Auth = (() => {
  const SESSION_KEY = "xenoai_session";

  // Учётные записи администраторов (полный доступ ко всем возможностям платформы)
  const ADMINS = [
    { login: "David", password: "ETH123aAgo" },
    { login: "Yura", password: "BTCmyB671" },
  ];

  function readSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const d = JSON.parse(raw);
      if (d && typeof d.login === "string" && ADMINS.some((a) => a.login.toLowerCase() === d.login.toLowerCase())) {
        return { login: d.login, role: "admin", at: typeof d.at === "number" ? d.at : 0 };
      }
    } catch (e) { /* noop */ }
    return null;
  }

  function sessionLogin() {
    const s = readSession();
    return s ? s.login : null;
  }

  function dataKey() {
    const login = sessionLogin();
    return login ? `xenoai_v2_${login.toLowerCase()}` : "xenoai_v2_anon";
  }

  function login(l, p) {
    const lv = String(l).trim().toLowerCase();
    const acc = ADMINS.find((a) => a.login.toLowerCase() === lv);
    if (!acc || acc.password !== p) return { ok: false, error: "Неверный логин или пароль" };
    const user = { login: acc.login, role: "admin", at: Date.now() };
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(user)); } catch (e) { /* noop */ }
    return { ok: true, user };
  }

  function logout() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* noop */ }
  }

  // ================= экран входа =================
  let tab = "login";
  let showPw = false;
  let error = null;
  let lastLogin = "", lastPw = "";

  function authScreen() {
    const h = UI;
    const loginTab = `
      <form id="auth-form">
        <label class="auth-field">
          <span class="auth-label">Логин</span>
          <input class="auth-inp" id="auth-login" value="${h.esc(lastLogin)}" placeholder="Введите логин" autocomplete="username" autofocus>
        </label>
        <label class="auth-field">
          <span class="auth-label">Пароль</span>
          <span class="auth-inp-wrap">
            <input class="auth-inp with-eye" id="auth-pass" type="${showPw ? "text" : "password"}" value="${h.esc(lastPw)}" placeholder="Введите пароль" autocomplete="current-password">
            <button type="button" class="eye-btn" data-action="auth:eye" aria-label="${showPw ? "Скрыть пароль" : "Показать пароль"}">${h.icon(showPw ? "eyeOff" : "eye", 16)}</button>
          </span>
        </label>
        ${error ? `<div class="auth-error">${h.esc(error)}</div>` : ""}
        <button type="submit" class="btn-enter" ${!lastLogin.trim() || !lastPw ? "disabled" : ""}>
          Войти в платформу ${h.icon("arrowRight", 15)}
        </button>
        <div class="auth-note">
          ${h.icon("shield", 14)}
          <span>Доступ открыт только для администраторов платформы. Регистрация новых аккаунтов временно закрыта.</span>
        </div>
      </form>`;

    const regTab = `
      <div class="reg-closed">
        <span class="reg-icon">${h.icon("lock", 20)}</span>
        <div class="reg-title">Регистрация закрыта</div>
        <p class="reg-text">Создание новых аккаунтов временно недоступно. Войти можно только по администраторским доступам.</p>
        <a class="btn-tg" href="https://t.me/Xeno_666" target="_blank" rel="noreferrer">${h.icon("send", 13)} По всем вопросам</a>
        <button class="reg-back" data-action="auth:tab" data-arg="login">Вернуться ко входу</button>
      </div>`;

    return `
    <div class="auth">
      <div class="auth-glow"><i class="g1"></i><i class="g2"></i><i class="g3"></i></div>
      <div class="auth-grid"></div>
      <div class="auth-inner">
        <div class="auth-logo">
          ${h.xenoMark(58)}
          <div class="auth-brand">
            <span class="b1">Xeno<em>AI</em></span>
            <span class="b2">Trade</span>
          </div>
          <p class="auth-tagline">Платформа автоматического ИИ-трейдинга<br>по реальным данным Binance</p>
        </div>

        <div class="auth-card">
          <div class="auth-tabs">
            <button class="auth-tab ${tab === "login" ? "active" : ""}" data-action="auth:tab" data-arg="login">Вход</button>
            <button class="auth-tab ${tab === "reg" ? "active" : ""}" data-action="auth:tab" data-arg="reg">Регистрация
              <span class="lock">${h.icon("lock", 8)}</span>
            </button>
          </div>
          ${tab === "login" ? loginTab : regTab}
        </div>

        <div class="auth-foot">
          <div class="live num"><span class="online-dot" style="width:5px;height:5px"></span> Реальные данные Binance · Демо-торговля в ХРЮ</div>
          <a class="tg" href="https://t.me/Xeno_666" target="_blank" rel="noreferrer">${h.icon("send", 11)} По всем вопросам</a>
        </div>
      </div>
    </div>`;
  }

  function readInputs() {
    const li = document.getElementById("auth-login");
    const pi = document.getElementById("auth-pass");
    if (li) lastLogin = li.value;
    if (pi) lastPw = pi.value;
  }

  function submit() {
    readInputs();
    const res = login(lastLogin, lastPw);
    if (!res.ok) {
      error = res.error;
      App.renderAuth();
      return;
    }
    error = null;
    lastLogin = ""; lastPw = "";
    App.afterLogin();
  }

  return { ADMINS, readSession, sessionLogin, dataKey, login, logout, authScreen, submit, readInputs, credsReady() { return Boolean(lastLogin.trim() && lastPw); }, setTab(t) { tab = t; error = null; }, get tab() { return tab; }, toggleEye() { showPw = !showPw; }, get showPw() { return showPw; } };
})();

window.Auth = Auth;
