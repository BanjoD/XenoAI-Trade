// XenoAI Trade — детерминированная генерация свечей (деградация без API)
"use strict";

const Candles = (() => {
  // mulberry32 — seeded RNG
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function genCandles(opts) {
    const seed = opts.seed, n = opts.n, start = opts.start;
    const end = opts.end != null ? opts.end : start;
    const volBase = opts.volBase != null ? opts.volBase : 0.006;
    const stepMin = opts.stepMin != null ? opts.stepMin : 5;
    const drift = opts.drift || 0;
    const rand = rng(seed * 7919 + n);
    const out = [];

    // кусочно-заданная «дорога»: чередуем фазы, чтобы график жил
    const phases = [];
    let total = 0, i = 0;
    while (total < n) {
      const len = Math.max(4, Math.round((rand() * 0.14 + 0.05) * n));
      const bias = (rand() - 0.5 + drift * (i % 2 === 0 ? 1.4 : 0.4)) * 2;
      phases.push({ len: Math.min(len, n - total), bias });
      total += len;
      i++;
    }

    let price = start;
    const ratio = end / start;
    const t0 = Date.now() - n * stepMin * 60000;

    for (let k = 0; k < n; k++) {
      let acc = 0, bias = 0;
      for (const p of phases) {
        if (k < acc + p.len) { bias = p.bias; break; }
        acc += p.len;
      }
      const globalPull = (ratio - 1) * (1 / n);
      const change = (rand() - 0.5) * volBase + bias * volBase * 0.35 + globalPull;
      const o = price;
      const c = o * (1 + change);
      const h = Math.max(o, c) * (1 + rand() * volBase * 0.45);
      const l = Math.min(o, c) * (1 - rand() * volBase * 0.45);
      const v = (0.35 + rand() * 0.9 + (Math.abs(change) > volBase * 0.8 ? 0.9 : 0)) * 40000;
      out.push({ o, h, l, c, v, t: Math.floor((t0 + k * stepMin * 60000) / 60000) });
      price = c;
    }

    const scale = end / price;
    if (Math.abs(scale - 1) > 1e-9) {
      for (const cd of out) { cd.o *= scale; cd.h *= scale; cd.l *= scale; cd.c *= scale; }
    }
    return out;
  }

  function timeLabel(t, stepMin) {
    const d = new Date(t * 60000);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    if (stepMin >= 60 * 6) return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (mm === "00") return `${hh}:00`;
    return `${hh}:${mm}`;
  }

  return { genCandles, timeLabel, rng };
})();

window.Candles = Candles;
