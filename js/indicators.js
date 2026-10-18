// XenoAI Trade — технические индикаторы (реальные расчёты на свечах)
"use strict";

const Ind = (() => {
  function sma(vals, period) {
    const out = [];
    let sum = 0;
    for (let i = 0; i < vals.length; i++) {
      sum += vals[i];
      if (i >= period) sum -= vals[i - period];
      out.push(i >= period - 1 ? sum / period : null);
    }
    return out;
  }

  function emaSeries(vals, period) {
    const k = 2 / (period + 1);
    const out = [];
    let prev = null;
    for (let i = 0; i < vals.length; i++) {
      if (i < period - 1) { out.push(null); continue; }
      if (prev === null) {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += vals[j];
        prev = sum / period;
      } else {
        prev = vals[i] * k + prev * (1 - k);
      }
      out.push(prev);
    }
    return out;
  }

  // Боллинджер (20, 2)
  function bollinger(vals, period, mult) {
    period = period || 20; mult = mult || 2;
    const mid = sma(vals, period);
    const upper = [], lower = [];
    for (let i = 0; i < vals.length; i++) {
      const m = mid[i];
      if (m === null) { upper.push(null); lower.push(null); continue; }
      let sq = 0;
      for (let j = i - period + 1; j <= i; j++) sq += (vals[j] - m) ** 2;
      const sd = Math.sqrt(sq / period);
      upper.push(m + mult * sd);
      lower.push(m - mult * sd);
    }
    return { mid, upper, lower };
  }

  // RSI (Wilder)
  function rsiSeries(vals, period) {
    period = period || 14;
    const out = [null];
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i < vals.length; i++) {
      const ch = vals[i] - vals[i - 1];
      const gain = Math.max(0, ch);
      const loss = Math.max(0, -ch);
      if (i <= period) {
        avgGain += gain / period;
        avgLoss += loss / period;
        out.push(i === period ? 100 - 100 / (1 + avgGain / (avgLoss || 1e-12)) : null);
      } else {
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        out.push(100 - 100 / (1 + avgGain / (avgLoss || 1e-12)));
      }
    }
    return out;
  }

  // MACD (12, 26, 9)
  function macdSeries(vals) {
    const f = emaSeries(vals, 12);
    const s = emaSeries(vals, 26);
    const line = [], validIdx = [];
    for (let i = 0; i < vals.length; i++) {
      if (f[i] !== null && s[i] !== null) {
        line.push(f[i] - s[i]);
        validIdx.push(i);
      }
    }
    const sigRaw = emaSeries(line, 9);
    const signal = new Array(vals.length).fill(null);
    const macd = new Array(vals.length).fill(null);
    sigRaw.forEach((v, j) => {
      if (v !== null) { signal[validIdx[j]] = v; macd[validIdx[j]] = line[j]; }
    });
    return { macd, signal };
  }

  // ATR (Wilder)
  function atrSeries(bars, period) {
    period = period || 14;
    const trs = [];
    for (let i = 0; i < bars.length; i++) {
      if (i === 0) trs.push(bars[i].h - bars[i].l);
      else trs.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c)));
    }
    const out = [];
    let prev = null;
    for (let i = 0; i < trs.length; i++) {
      if (i < period - 1) { out.push(null); continue; }
      if (prev === null) {
        let sum = 0;
        for (let j = 0; j <= i; j++) sum += trs[j];
        prev = sum / (i + 1);
      } else {
        prev = (prev * (period - 1) + trs[i]) / period;
      }
      out.push(prev);
    }
    return out;
  }

  // Ишимоку (9, 26, 52)
  function ichimoku(bars, conv, base, spanB) {
    conv = conv || 9; base = base || 26; spanB = spanB || 52;
    const hh = (n, i) => Math.max(...bars.slice(Math.max(0, i - n + 1), i + 1).map((b) => b.h));
    const ll = (n, i) => Math.min(...bars.slice(Math.max(0, i - n + 1), i + 1).map((b) => b.l));
    const i = bars.length - 1;
    const tenkan = (hh(conv, i) + ll(conv, i)) / 2;
    const kijun = (hh(base, i) + ll(base, i)) / 2;
    const j = Math.max(0, i - base);
    const spanA26 = ((hh(conv, j) + ll(conv, j)) / 2 + (hh(base, j) + ll(base, j)) / 2) / 2;
    const spanB26 = (hh(spanB, j) + ll(spanB, j)) / 2;
    return { tenkan, kijun, spanA: spanA26, spanB: spanB26 };
  }

  function highest(bars, n, endIdx) {
    const e = endIdx == null ? bars.length - 1 : endIdx;
    return Math.max(...bars.slice(Math.max(0, e - n + 1), e + 1).map((b) => b.h));
  }

  function lowest(bars, n, endIdx) {
    const e = endIdx == null ? bars.length - 1 : endIdx;
    return Math.min(...bars.slice(Math.max(0, e - n + 1), e + 1).map((b) => b.l));
  }

  function rocSeries(vals, n) {
    n = n || 10;
    return vals.map((v, i) => (i >= n ? ((v - vals[i - n]) / vals[i - n]) * 100 : null));
  }

  // ADX (Wilder, 14): сила тренда 0..100 + направляющие DI+ / DI−
  function adxSeries(bars, period) {
    period = period || 14;
    const n = bars.length;
    const out = { adx: new Array(n).fill(null), pdi: new Array(n).fill(null), mdi: new Array(n).fill(null) };
    if (n < period * 2) return out;
    let trS = 0, pS = 0, mS = 0;
    const dxArr = [];
    for (let i = 1; i < n; i++) {
      const up = bars[i].h - bars[i - 1].h;
      const dn = bars[i - 1].l - bars[i].l;
      const pdm = up > dn && up > 0 ? up : 0;
      const mdm = dn > up && dn > 0 ? dn : 0;
      const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
      if (i <= period) {
        trS += tr; pS += pdm; mS += mdm;
        if (i < period) continue;
      } else {
        trS = trS - trS / period + tr;
        pS = pS - pS / period + pdm;
        mS = mS - mS / period + mdm;
      }
      const pdi = trS > 0 ? (pS / trS) * 100 : 0;
      const mdi = trS > 0 ? (mS / trS) * 100 : 0;
      out.pdi[i] = pdi; out.mdi[i] = mdi;
      const dx = pdi + mdi > 0 ? (Math.abs(pdi - mdi) / (pdi + mdi)) * 100 : 0;
      dxArr.push(dx);
      if (dxArr.length === period) out.adx[i] = dxArr.reduce((a, b) => a + b, 0) / period;
      else if (dxArr.length > period) {
        const prev = out.adx[i - 1] != null ? out.adx[i - 1] : dxArr[dxArr.length - 2];
        out.adx[i] = (prev != null) ? (prev * (period - 1) + dx) / period : out.adx[i];
      }
    }
    return out;
  }

  // Stochastic %K/%D (14, 3): 0..100, зоны перекупленности/перепроданности
  function stochSeries(bars, kPeriod, dPeriod) {
    kPeriod = kPeriod || 14; dPeriod = dPeriod || 3;
    const n = bars.length;
    const k = new Array(n).fill(null);
    for (let i = kPeriod - 1; i < n; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - kPeriod + 1; j <= i; j++) { hh = Math.max(hh, bars[j].h); ll = Math.min(ll, bars[j].l); }
      k[i] = hh > ll ? ((bars[i].c - ll) / (hh - ll)) * 100 : 50;
    }
    const d = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      if (k[i] == null) continue;
      let sum = 0, cnt = 0;
      for (let j = Math.max(0, i - dPeriod + 1); j <= i; j++) { if (k[j] != null) { sum += k[j]; cnt++; } }
      if (cnt === dPeriod) d[i] = sum / cnt;
    }
    return { k, d };
  }

  return { sma, emaSeries, bollinger, rsiSeries, macdSeries, atrSeries, ichimoku, highest, lowest, rocSeries, adxSeries, stochSeries };
})();

window.Ind = Ind;
