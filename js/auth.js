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
    // синхронно с store.js (STORAGE_VER = xenoai_v3)
    return login ? `xenoai_v3_${login.toLowerCase()}` : "xenoai_v3_anon";
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

  // ===== детерминированный код облачной синхронизации аккаунта =====
  // Один и тот же логин на любом устройстве получает ОДИН И ТОТ ЖЕ ключ облака —
  // синхронизация работает сама, без ручного переноса кода. Компактный синхронный
  // SHA-256 (WebCrypto асинхронный, а код нужен уже при hydrate).
  const SHA_K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  function sha256hex(msg) {
    const bytes = [];
    for (let i = 0; i < msg.length; i++) {
      let c = msg.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) { bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63)); }
      else { bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
    }
    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (let i = 7; i >= 0; i--) bytes.push(Math.floor(bitLen / Math.pow(2, i * 8)) & 255);
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const w = new Array(64);
    const rr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < bytes.length; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = (bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) | (bytes[off + i * 4 + 2] << 8) | bytes[off + i * 4 + 3];
      for (let i = 16; i < 64; i++) {
        const s0 = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + SHA_K[i] + w[i]) | 0;
        const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
        const mj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + mj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H.map((x) => ("00000000" + (x >>> 0).toString(16)).slice(-8)).join("");
  }
  function syncCodeFor(login) {
    const lv = String(login || "").trim().toLowerCase();
    const acc = ADMINS.find((a) => a.login.toLowerCase() === lv);
    if (!acc) return null;
    const hex = sha256hex("xenoai-sync-v1|" + lv + "|" + acc.password).toUpperCase();
    return hex.slice(0, 4) + "-" + hex.slice(4, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16);
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
      <div class="auth-scan"></div>
      <div class="auth-inner">
        <div class="auth-logo">
          <span class="mark-wrap">${h.xenoMark(58)}</span>
          <div class="auth-brand">
            <span class="b1">Xeno<em class="neon-flicker">AI</em></span>
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

  return { ADMINS, readSession, sessionLogin, dataKey, login, logout, syncCodeFor, sha256hex, authScreen, submit, readInputs, credsReady() { return Boolean(lastLogin.trim() && lastPw); }, setTab(t) { tab = t; error = null; }, get tab() { return tab; }, toggleEye() { showPw = !showPw; }, get showPw() { return showPw; } };
})();

window.Auth = Auth;
