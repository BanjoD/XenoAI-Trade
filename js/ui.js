// XenoAI Trade — UI-хелперы: иконки, бейджи, монетки, тосты, модалки
"use strict";

const UI = (() => {
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ------- иконки (lucide-стиль, stroke) -------
  function svgWrap(inner, size) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  }
  const ICON_PATHS = {
    grid: `<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>`,
    zap: `<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>`,
    fish: `<path d="M6.5 12c.94-3.46 4.94-6 8.5-6 3.56 0 6.06 2.54 7 6-.94 3.47-3.44 6-7 6s-7.56-2.53-8.5-6z"/><path d="M18 12v.5"/><path d="M16 17.93a9.77 9.77 0 0 1 0-11.86"/><path d="M7 10.67C7 8 5.58 5.97 2.73 5.5c-1 1.5-1 5 .23 6.5-1.24 1.5-1.24 5-.23 6.5C5.58 18.03 7 16 7 13.33"/><path d="M10.46 7.26C10.2 5.88 9.17 4.24 8 3h5.8a2 2 0 0 1 1.98 1.67l.23 1.4"/>`,
    candles: `<path d="M9 5v4"/><rect x="7" y="9" width="4" height="6" rx="1"/><path d="M9 15v2"/><path d="M17 3v2"/><rect x="15" y="5" width="4" height="7" rx="1"/><path d="M17 12v3"/><path d="M3 3v18"/>`,
    radio: `<circle cx="12" cy="12" r="2"/><path d="M4.93 19.07a10 10 0 0 1 0-14.14"/><path d="M7.76 16.24a6 6 0 0 1 0-8.49"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>`,
    swap: `<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>`,
    wallet: `<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>`,
    trophy: `<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2z"/>`,
    logout: `<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>`,
    menu: `<path d="M4 6h16M4 12h16M4 18h16"/>`,
    x: `<path d="M18 6 6 18M6 6l12 12"/>`,
    send: `<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>`,
    eye: `<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>`,
    eyeOff: `<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><path d="m2 2 20 20"/>`,
    lock: `<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>`,
    shield: `<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>`,
    sparkles: `<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/><path d="M5 16l.7 1.6L7.3 18.3"/>`,
    cpu: `<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/>`,
    arrowRight: `<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>`,
    download: `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>`,
  };
  function icon(name, size) { return svgWrap(ICON_PATHS[name] || "", size || 17); }

  // ------- хрювна (ХРЮ) -------
  function hru(size, cls) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" ${cls ? `class="${cls}"` : ""} aria-label="ХРЮ">
      <circle cx="12" cy="12" r="11" fill="#f5c542"/>
      <circle cx="12" cy="12" r="11" fill="none" stroke="#d9a520" stroke-width="1.4"/>
      <path d="M5 8.2 L8 5.6 L9.4 8.4 Z" fill="#d9a520"/>
      <path d="M19 8.2 L16 5.6 L14.6 8.4 Z" fill="#d9a520"/>
      <circle cx="8.6" cy="10.4" r="1.05" fill="#5c4408"/>
      <circle cx="15.4" cy="10.4" r="1.05" fill="#5c4408"/>
      <ellipse cx="12" cy="14.6" rx="4.1" ry="3.1" fill="#ffe08a" stroke="#d9a520" stroke-width="0.9"/>
      <ellipse cx="10.6" cy="14.6" rx="0.85" ry="1.15" fill="#8a6a10"/>
      <ellipse cx="13.4" cy="14.6" rx="0.85" ry="1.15" fill="#8a6a10"/>
    </svg>`;
  }

  // ------- лого -------
  function xenoMark(size) {
    size = size || 36;
    return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" aria-label="XenoAI Trade">
      <defs>
        <linearGradient id="xenoGold${size}" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#ff2d78"/><stop offset="55%" stop-color="#c74fd8"/><stop offset="100%" stop-color="#8b5cf6"/></linearGradient>
        <linearGradient id="xenoX${size}" x1="0" y1="1" x2="1" y2="0"><stop offset="0%" stop-color="#8b5cf6"/><stop offset="100%" stop-color="#ff2d78"/></linearGradient>
        <radialGradient id="xenoBg${size}" cx="50%" cy="38%" r="70%"><stop offset="0%" stop-color="#241426"/><stop offset="100%" stop-color="#0d0a10"/></radialGradient>
      </defs>
      <rect width="100" height="100" rx="24" fill="url(#xenoBg${size})"/>
      <rect x="1" y="1" width="98" height="98" rx="23" fill="none" stroke="rgba(255,255,255,0.08)"/>
      <circle cx="50" cy="50" r="39" fill="none" stroke="url(#xenoGold${size})" stroke-width="3.5" opacity="0.9"/>
      <circle cx="50" cy="50" r="33" fill="none" stroke="url(#xenoGold${size})" stroke-width="1.4" opacity="0.5"/>
      <g stroke="#ff8ad2" stroke-width="1.6" opacity="0.5">
        <line x1="50" y1="17" x2="50" y2="20.5"/><line x1="62" y1="19.9" x2="60.7" y2="23.1"/>
        <line x1="72.8" y1="27.2" x2="70.4" y2="29.6"/><line x1="80.1" y1="38" x2="76.9" y2="39.3"/>
        <line x1="83" y1="50" x2="79.5" y2="50"/><line x1="80.1" y1="62" x2="76.9" y2="60.7"/>
        <line x1="72.8" y1="72.8" x2="70.4" y2="70.4"/><line x1="62" y1="80.1" x2="60.7" y2="76.9"/>
        <line x1="50" y1="83" x2="50" y2="79.5"/><line x1="38" y1="80.1" x2="39.3" y2="76.9"/>
        <line x1="27.2" y1="72.8" x2="29.6" y2="70.4"/><line x1="19.9" y1="62" x2="23.1" y2="60.7"/>
        <line x1="17" y1="50" x2="20.5" y2="50"/><line x1="19.9" y1="38" x2="23.1" y2="39.3"/>
        <line x1="27.2" y1="27.2" x2="29.6" y2="29.6"/><line x1="38" y1="19.9" x2="39.3" y2="23.1"/>
      </g>
      <path d="M27 25 L45 43 M73 75 L55 57" stroke="url(#xenoX${size})" stroke-width="9" stroke-linecap="round" fill="none"/>
      <path d="M73 25 L55 43 M27 75 L45 57" stroke="url(#xenoX${size})" stroke-width="9" stroke-linecap="round" fill="none" opacity="0.92"/>
      <circle cx="50" cy="50" r="5.5" fill="#0d0d10" stroke="url(#xenoX${size})" stroke-width="3"/>
      <circle cx="27" cy="25" r="3" fill="#ff8ad2"/><circle cx="73" cy="25" r="3" fill="#c74fd8"/>
      <circle cx="27" cy="75" r="3" fill="#c74fd8"/><circle cx="73" cy="75" r="3" fill="#ff8ad2"/>
      <path d="M27 25 L14 20 M73 25 L86 20 M27 75 L14 80 M73 75 L86 80" stroke="#ff5fa8" stroke-width="1.4" opacity="0.6"/>
    </svg>`;
  }

  function xenoLogo(compact) {
    return `<span style="display:inline-flex;align-items:center;gap:10px">
      ${xenoMark(34)}
      ${compact ? "" : `<span style="line-height:1">
        <span style="font-size:16.5px;font-weight:600;letter-spacing:-0.02em">Xeno<em style="font-style:normal;color:var(--accent-2);text-shadow:0 0 12px rgba(255,45,120,.55)">AI</em></span>
        <span style="margin-left:6px;font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:.18em;color:#71717a">Trade</span>
      </span>`}
    </span>`;
  }

  // ------- монетка -------
  function pickTextColor(bg) {
    if (!bg || bg[0] !== "#" || bg.length < 7) return "#fff";
    const r = parseInt(bg.slice(1, 3), 16), g = parseInt(bg.slice(3, 5), 16), b = parseInt(bg.slice(5, 7), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? "#141416" : "#ffffff";
  }
  function coin(sym, size) {
    size = size || 34;
    const meta = DataLib.BY_SYM[sym];
    const color = (meta && meta.color) || "hsl(200 55% 45%)";
    const label = (meta && meta.label) || sym.slice(0, 2);
    const fs = size <= 24 ? 8.5 : size <= 30 ? 10 : label.length > 2 ? 9.5 : 12;
    return `<span class="coin" style="width:${size}px;height:${size}px;background:${color};color:${pickTextColor(color)};font-size:${fs}px">${esc(label)}</span>`;
  }

  // ------- теги -------
  function tag(tone, html, cls) {
    return `<span class="tag ${tone} ${cls || ""}">${html}</span>`;
  }
  function sideTag(side, lev) {
    return `<span class="side-tag">${tag(side === "лонг" ? "green" : "red", side)}${lev != null ? tag("orange", "×" + lev) : ""}</span>`;
  }

  function hruAmount(v, signed, cls) {
    const sign = signed ? (v > 0 ? "+" : v < 0 ? "−" : "") : "";
    return `<span style="display:inline-flex;align-items:center;gap:4px" class="${cls || "num"}">${sign ? `<span>${sign}</span>` : ""}<span class="num">${Fmt.fmtHru(v)}</span>${hru(12)}<span style="font-size:.85em;font-weight:500;opacity:.8">ХРЮ</span></span>`;
  }

  function pctText(v, cls) {
    const s = v > 0 ? "+" : v < 0 ? "−" : "";
    return `<span class="num ${v >= 0 ? "text-green" : "text-red"} ${cls || ""}">${s}${Math.abs(v).toFixed(2)}%</span>`;
  }

  function statCard(label, valueHtml, valueClass, subHtml) {
    return `<div class="stat-card">
      <div class="stat-label">${label}</div>
      <div class="stat-value ${valueClass || ""}">${valueHtml}</div>
      ${subHtml ? `<div class="stat-sub">${subHtml}</div>` : ""}
    </div>`;
  }

  function sectionTitle(title, rightHtml) {
    return `<div class="section-head"><h2 class="section-title">${title}</h2>${rightHtml || ""}</div>`;
  }

  function onlineDot() { return `<span class="online-dot"></span>`; }

  function tfBar(value, action, options) {
    options = options || ["1м", "5м", "15м", "1ч"];
    return `<div class="tfbar">${options.map((o) => `<button data-action="${action}" data-arg="${o}" class="${o === value ? "active" : ""}">${o}</button>`).join("")}</div>`;
  }

  function togglePill(active, label, action) {
    return `<button data-action="${action}" class="toggle-pill ${active ? "active" : ""}">${label}</button>`;
  }

  // ------- тосты -------
  function toast(type, title, desc) {
    const root = document.getElementById("toast-root");
    if (!root) return;
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.innerHTML = `<div class="t">${esc(title)}</div>${desc ? `<div class="d">${esc(desc)}</div>` : ""}`;
    root.appendChild(el);
    setTimeout(() => { el.style.transition = "opacity .3s"; el.style.opacity = "0"; setTimeout(() => el.remove(), 300); }, 3400);
  }

  // ------- модалка -------
  let modalOnClose = null;
  function showModal(innerHtml, opts) {
    opts = opts || {};
    const root = document.getElementById("modal-root");
    modalOnClose = opts.onClose || null;
    root.innerHTML = `<div class="modal-wrap fade-in">
      <div class="modal-backdrop" data-action="modal:close"></div>
      <div class="modal ${opts.wide ? "wide" : ""}">
        <button class="modal-x" data-action="modal:close" aria-label="Закрыть">${icon("x", 18)}</button>
        ${innerHtml}
      </div>
    </div>`;
    document.body.style.overflow = "hidden";
  }
  function closeModal() {
    const root = document.getElementById("modal-root");
    if (root) root.innerHTML = "";
    document.body.style.overflow = "";
    const fn = modalOnClose; modalOnClose = null;
    if (fn) fn();
  }

  return {
    esc, icon, hru, xenoMark, xenoLogo, coin, tag, sideTag, hruAmount, pctText,
    statCard, sectionTitle, onlineDot, tfBar, togglePill, toast, showModal, closeModal,
  };
})();

window.UI = UI;
