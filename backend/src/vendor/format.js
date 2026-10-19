// XenoAI Trade — форматтеры чисел (ru)
"use strict";

const Fmt = (() => {
  function fmtMoney(v, opts) {
    const sign = opts && opts.sign && v > 0 ? "+" : v < 0 ? "−" : "";
    const abs = Math.abs(v);
    const compactFrom = (opts && opts.compactFrom) || 1_000_000;
    if (compactFrom <= abs && abs >= 1_000_000) return `${sign}$${fmtCompact(abs)}`;
    const dec = abs >= 1000 ? 0 : 2;
    const str = abs.toLocaleString("ru-RU", { minimumFractionDigits: dec, maximumFractionDigits: dec });
    return `${sign}$${str}`;
  }
  function fmtCompact(v) {
    const abs = Math.abs(v);
    if (abs >= 1e9) return (v / 1e9).toFixed(1) + "B";
    if (abs >= 1e6) return (v / 1e6).toFixed(1) + "M";
    if (abs >= 1e3) return (v / 1e3).toFixed(1) + "K";
    return v.toFixed(0);
  }
  function fmtPct(v, opts) {
    const sign = v > 0 ? "+" : v < 0 ? "−" : "";
    const s = opts && opts.sign === false ? "" : sign;
    const abs = Math.abs(v);
    const dec = abs >= 100 ? 1 : 2;
    return `${s}${abs.toFixed(dec)}%`;
  }
  function fmtPrice(v) {
    const abs = Math.abs(v);
    let maxDec;
    if (abs >= 1000) maxDec = 2;
    else if (abs >= 10) maxDec = 3;
    else if (abs >= 1) maxDec = 4;
    else if (abs >= 0.01) maxDec = 5;
    else maxDec = 6;
    return Number(v).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: maxDec });
  }
  function fmtHru(v) {
    const abs = Math.abs(v);
    return abs.toLocaleString("ru-RU", { minimumFractionDigits: abs < 100 ? 2 : 0, maximumFractionDigits: 2 });
  }
  // долларовый эквивалент ХРЮ (курс 1:1): профит/убыток в хрювнах = долларовый
  function fmtUsd(v, dec) {
    const abs = Math.abs(v);
    const d = dec == null ? (abs >= 1000 || Number.isInteger(abs) ? 0 : 2) : dec;
    return "$" + abs.toLocaleString("ru-RU", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtUsdSigned(v, dec) {
    const sign = v > 0 ? "+" : v < 0 ? "−" : "";
    return sign + fmtUsd(v, dec);
  }
  function fmtNum(v, dec) {
    return Number(v).toLocaleString("ru-RU", { minimumFractionDigits: dec || 0, maximumFractionDigits: dec || 0 });
  }
  function fmtHeld(minutes) {
    if (minutes < 60) return `${Math.round(minutes)} мин`;
    if (minutes < 60 * 24) {
      const h = Math.floor(minutes / 60);
      const m = Math.round(minutes % 60);
      return m ? `${h} ч ${m} мин` : `${h} ч`;
    }
    const d = Math.floor(minutes / (60 * 24));
    const h = Math.floor((minutes % (60 * 24)) / 60);
    return h ? `${d} д ${h} ч` : `${d} д`;
  }
  function fmtTimeAgo(minutesAgo) {
    if (minutesAgo < 1) return "только что";
    if (minutesAgo < 60) return `${Math.round(minutesAgo)} мин`;
    if (minutesAgo < 60 * 24) return `${Math.floor(minutesAgo / 60)} ч`;
    return `${Math.floor(minutesAgo / (60 * 24))} д`;
  }
  function fmtClock(ms) {
    return new Date(ms).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  function fmtClockShort(ms) {
    return new Date(ms).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }
  return { fmtMoney, fmtCompact, fmtPct, fmtPrice, fmtHru, fmtUsd, fmtUsdSigned, fmtNum, fmtHeld, fmtTimeAgo, fmtClock, fmtClockShort };
})();

export { Fmt };
