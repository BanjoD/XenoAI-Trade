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

  return { sma, emaSeries, bollinger, rsiSeries, macdSeries, atrSeries, ichimoku, highest, lowest, rocSeries };
})();

window.Ind = Ind;
