// XenoAI Trade — SVG-чарты: свечи+EMA+объём+уровни, линия+объём, спарклайн, донат, эквити
"use strict";

const Charts = (() => {
  const fmtPrice = (v) => Fmt.fmtPrice(v);

  const LEVEL_STYLES = {
    green: { line: "#ff4fa3", text: "#ffd3e8", bg: "rgba(255, 45, 120, 0.18)" },
    greenfill: { line: "#ff4fa3", text: "#3d0620", bg: "#ff4fa3" },
    red: { line: "#f87171", text: "#fecaca", bg: "rgba(239, 68, 68, 0.2)" },
    redfill: { line: "#f87171", text: "#450a0a", bg: "#f87171" },
    orange: { line: "#fb923c", text: "#fed7aa", bg: "rgba(251, 146, 60, 0.22)" },
    orangefill: { line: "#fb923c", text: "#431407", bg: "#fb923c" },
    violet: { line: "#a78bfa", text: "#ede9fe", bg: "rgba(167, 139, 250, 0.2)" },
    white: { line: "rgba(255,255,255,0.85)", text: "#18181b", bg: "#ffffff" },
    gray: { line: "rgba(255,255,255,0.4)", text: "#d4d4d8", bg: "rgba(255,255,255,0.1)" },
  };

  // ------- свечной график -------
  function candleChart(el, candles, opts) {
    opts = opts || {};
    const levels = opts.levels || [];
    const markers = opts.markers || [];
    const emas = opts.emas || [];
    const currentPrice = opts.currentPrice;
    const volume = opts.volume !== false;
    const rightPad = opts.rightPad != null ? opts.rightPad : 96;
    const timeEvery = opts.timeEvery != null ? opts.timeEvery : 5;

    const w = el.clientWidth, h = el.clientHeight;
    if (!candles.length || w === 0 || h === 0) return;

    const plotW = w - rightPad;
    let lo = Infinity, hi = -Infinity;
    for (const c of candles) { if (c.l < lo) lo = c.l; if (c.h > hi) hi = c.h; }
    for (const lv of levels) { if (lv.price < lo) lo = lv.price; if (lv.price > hi) hi = lv.price; }
    if (currentPrice) { if (currentPrice < lo) lo = currentPrice; if (currentPrice > hi) hi = currentPrice; }
    const span = hi - lo || hi * 0.01 || 1;
    lo -= span * 0.06; hi += span * 0.06;

    const volH = volume ? h * 0.16 : 0;
    const axisH = 18;
    const priceH = h - volH - axisH;
    const px = (i) => ((i + 0.5) / candles.length) * plotW;
    const py = (v) => priceH - ((v - lo) / (hi - lo)) * (priceH - 8) - 4;
    const cw = Math.max(2, (plotW / candles.length) * 0.62);
    const maxV = Math.max(...candles.map((c) => c.v));

    // оси времени
    const ticks = [];
    const step = Math.max(1, Math.floor(candles.length / timeEvery));
    const stepMin = candles.length > 1 ? candles[1].t - candles[0].t : 5;
    for (let i = 0; i < candles.length; i += step) ticks.push({ x: px(i), label: Candles.timeLabel(candles[i].t * 60, stepMin) });

    // правые ценовые деления
    const priceTicks = [];
    const nTicks = 6;
    for (let i = 0; i <= nTicks; i++) {
      const v = lo + ((hi - lo) * i) / nTicks;
      priceTicks.push({ y: py(v), label: fmtPrice(v) });
    }

    const emaSvgs = emas.map((p) => ({ period: p, vals: Ind.emaSeries(candles.map((c) => c.c), p) }));

    // пилоны уровней: разводим близкие по вертикали
    const rawYs = levels.map((lv) => py(lv.price));
    const order = levels.map((_, i) => i).sort((a, b) => rawYs[a] - rawYs[b]);
    const levelYs = [...rawYs];
    let prevY = -1e9;
    for (const i of order) {
      const y = Math.max(rawYs[i], prevY + 21);
      levelYs[i] = y;
      prevY = y;
    }

    const s = [];
    s.push(`<svg width="${w}" height="${h}" class="block select-none" style="width:100%">`);

    // сетка
    for (const t of priceTicks) s.push(`<line x1="0" x2="${plotW}" y1="${t.y}" y2="${t.y}" stroke="rgba(255,255,255,0.045)" stroke-width="1"/>`);
    // правая шкала
    for (const t of priceTicks) s.push(`<text x="${w - rightPad + 8}" y="${t.y + 3}" font-size="9.5" fill="#63636b" class="num">${t.label}</text>`);
    // объёмы
    if (volume) {
      candles.forEach((c, i) => {
        const bh = (c.v / maxV) * (volH - 6);
        s.push(`<rect x="${(px(i) - cw / 2).toFixed(1)}" y="${(priceH + (volH - bh)).toFixed(1)}" width="${cw.toFixed(1)}" height="${Math.max(1, bh).toFixed(1)}" fill="${c.c >= c.o ? "rgba(255,79,163,0.32)" : "rgba(167,139,250,0.16)"}" opacity="0.85"/>`);
      });
    }
    // EMA (неон-розовая + фиолетовая)
    const EMA_COLORS = ["#ff2d78", "#a78bfa"];
    for (let si = 0; si < emaSvgs.length; si++) {
      const vals = emaSvgs[si].vals;
      let d = "", started = false;
      for (let i = 0; i < vals.length; i++) {
        if (vals[i] == null) continue;
        d += `${started ? "L" : "M"}${px(i).toFixed(1)},${py(vals[i]).toFixed(1)} `;
        started = true;
      }
      if (d) s.push(`<path d="${d}" fill="none" stroke="${EMA_COLORS[si % EMA_COLORS.length]}" stroke-opacity="${(0.62 - si * 0.14).toFixed(2)}" stroke-width="1.15"/>`);
    }
    // свечи
    candles.forEach((c, i) => {
      const up = c.c >= c.o;
      const yO = py(c.o), yC = py(c.c);
      const top = Math.min(yO, yC);
      const bh = Math.max(1, Math.abs(yC - yO));
      s.push(`<g><line x1="${px(i).toFixed(1)}" x2="${px(i).toFixed(1)}" y1="${py(c.h).toFixed(1)}" y2="${py(c.l).toFixed(1)}" stroke="${up ? "#ff8ac6" : "#8a5560"}" stroke-width="1"/>`
        + `<rect x="${(px(i) - cw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${cw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${up ? "#ff4fa3" : "#332028"}" ${up ? "" : `stroke="#c25b6e" stroke-width="0.7"`} ${cw > 3 ? 'rx="1"' : ""}/></g>`);
    });
    // уровни
    levels.forEach((lv, i) => {
      const y = py(lv.price);
      const pillY = levelYs[i];
      const st = LEVEL_STYLES[lv.color] || LEVEL_STYLES.gray;
      const isFill = lv.color.endsWith("fill");
      const priceStr = fmtPrice(lv.price);
      const labelW = lv.label.length * 6.2 + 14;
      const priceW = Math.max(46, priceStr.length * 6.8 + 14);
      const totalW = (isFill ? labelW + 3 : 0) + priceW;
      const x0 = plotW - totalW;
      s.push(`<line x1="0" x2="${plotW}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${st.line}" stroke-width="${isFill ? 1.6 : 1.2}" ${lv.dashed ? 'stroke-dasharray="5 5"' : ""} opacity="${lv.dashed ? 0.85 : 0.95}"/>`);
      s.push(`<g transform="translate(0, ${pillY.toFixed(1)})">`);
      if (isFill) {
        s.push(`<rect x="${x0.toFixed(1)}" y="-10" width="${labelW}" height="20" rx="4" fill="${st.bg}"/>`);
        s.push(`<text x="${(x0 + labelW / 2).toFixed(1)}" y="3.5" text-anchor="middle" font-size="10" font-weight="700" fill="${st.text}">${lv.label}</text>`);
      }
      s.push(`<rect x="${(plotW - priceW).toFixed(1)}" y="-10" width="${priceW}" height="20" rx="4" fill="${isFill ? st.bg : "rgba(20,20,23,0.92)"}" ${isFill ? "" : `stroke="${st.line}" stroke-opacity="0.55"`}/>`);
      s.push(`<text x="${(plotW - priceW + priceW / 2).toFixed(1)}" y="3.5" text-anchor="middle" font-size="10.5" font-weight="600" fill="${isFill ? st.text : "#fafafa"}" class="num">${priceStr}</text>`);
      s.push(`</g>`);
    });
    // текущая цена
    if (currentPrice != null) {
      s.push(`<line x1="0" x2="${plotW}" y1="${py(currentPrice).toFixed(1)}" y2="${py(currentPrice).toFixed(1)}" stroke="rgba(255,138,210,0.6)" stroke-width="1" stroke-dasharray="5 5"/>`);
      s.push(`<rect x="${plotW + 2}" y="${(py(currentPrice) - 10).toFixed(1)}" width="${rightPad - 6}" height="20" rx="4" fill="#ff2d78"/>`);
      s.push(`<text x="${plotW + 8}" y="${(py(currentPrice) + 3.5).toFixed(1)}" font-size="10.5" font-weight="600" fill="#ffffff" class="num">${fmtPrice(currentPrice)}</text>`);
    }
    // маркеры китов
    markers.forEach((m) => {
      const x = px(Math.min(m.idx, candles.length - 1));
      const y = py(m.price);
      const buy = m.kind.indexOf("buy") === 0;
      const strong = m.kind.endsWith("plus");
      const col = buy ? "#ff4fa3" : "#f87171";
      const dy = buy ? 14 : -14;
      const arrow = buy
        ? `<path d="M0,6 L-4.5,-1 L-1.6,-1 L-1.6,-6 L1.6,-6 L1.6,-1 L4.5,-1 Z" fill="${col}" transform="scale(0.9)"/>`
        : `<path d="M0,-6 L-4.5,1 L-1.6,1 L-1.6,6 L1.6,6 L1.6,1 L4.5,1 Z" fill="${col}" transform="scale(0.9)"/>`;
      s.push(`<g transform="translate(${x.toFixed(1)}, ${(y + dy).toFixed(1)})">${arrow}${m.label ? `<text y="${buy ? -10 : 16}" text-anchor="middle" font-size="8.5" font-weight="600" fill="${col}" opacity="${strong ? 1 : 0.8}">${m.label}</text>` : ""}</g>`);
    });
    // ось времени
    for (const t of ticks) s.push(`<text x="${t.x.toFixed(1)}" y="${h - 4}" text-anchor="middle" font-size="9.5" fill="#63636b">${t.label}</text>`);

    s.push(`</svg>`);
    el.innerHTML = s.join("");
  }

  // ------- линия + объём -------
  function lineVolume(el, data, opts) {
    opts = opts || {};
    const volumes = opts.volumes;
    const lineColor = opts.lineColor || "#ff4fa3";
    const volColor = opts.volColor || "#a78bfa";
    const timeLabels = opts.timeLabels;

    const w = el.clientWidth, h = el.clientHeight;
    if (!data.length || w === 0) return;
    const min = Math.min(...data), max = Math.max(...data);
    const pad = (max - min) * 0.12 || 0.001;
    const lo = min - pad, hi = max + pad;
    const volH = volumes && volumes.length ? h * 0.2 : 0;
    const chartH = h - volH - 20;
    const maxV = volumes ? Math.max(...volumes) : 1;
    const px = (i) => (i / (data.length - 1)) * w;
    const py = (v) => chartH - ((v - lo) / (hi - lo)) * chartH;

    const d = data.map((v, i) => `${i === 0 ? "M" : "L"}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(" ");
    const gid = `g${lineColor.replace(/[^a-z0-9]/gi, "")}${Math.round(h)}${Math.round(w)}`;

    const s = [];
    s.push(`<svg width="${w}" height="${h}" style="width:100%" class="block">`);
    s.push(`<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${lineColor}" stop-opacity="0.22"/><stop offset="100%" stop-color="${lineColor}" stop-opacity="0"/></linearGradient></defs>`);
    for (const f of [0.25, 0.5, 0.75]) s.push(`<line x1="0" x2="${w}" y1="${chartH * f}" y2="${chartH * f}" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>`);
    if (volumes) {
      volumes.forEach((v, i) => {
        const bw = Math.max(2, w / volumes.length - 2);
        const bh = (v / maxV) * (volH - 4);
        s.push(`<rect x="${(px(i) - bw / 2).toFixed(1)}" y="${(h - 20 - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, bh).toFixed(1)}" fill="${volColor}" opacity="0.75" rx="1"/>`);
      });
    }
    s.push(`<path d="${d} L${w},${chartH} L0,${chartH} Z" fill="url(#${gid})"/>`);
    s.push(`<path d="${d}" fill="none" stroke="${lineColor}" stroke-width="1.6" stroke-linejoin="round"/>`);
    if (timeLabels) {
      timeLabels.forEach((t, i) => {
        s.push(`<text x="${(((i + 0.5) / timeLabels.length) * w).toFixed(1)}" y="${h - 4}" text-anchor="middle" font-size="10" fill="#71717a">${t}</text>`);
      });
    }
    s.push(`</svg>`);
    el.innerHTML = s.join("");
  }

  // ------- спарклайн (инлайном, фиксированный размер) -------
  function spark(data, opts) {
    opts = opts || {};
    const w = opts.w || 88, h = opts.h || 30;
    const dot = opts.dot !== false;
    if (!data || data.length < 2) return `<svg width="${w}" height="${h}"></svg>`;
    const min = Math.min(...data), max = Math.max(...data);
    const rng = max - min || 1;
    const stroke = opts.color || "#e4e4e7";
    const px = (i) => (i / (data.length - 1)) * (w - 6) + 3;
    const py = (v) => h - 4 - ((v - min) / rng) * (h - 8);
    const d = data.map((v, i) => `${i === 0 ? "M" : "L"}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(" ");
    const last = data.length - 1;
    return `<svg width="${w}" height="${h}" class="block"><path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/>${dot ? `<circle cx="${px(last).toFixed(1)}" cy="${py(data[last]).toFixed(1)}" r="2.2" fill="${stroke}"/>` : ""}</svg>`;
  }

  // ------- донат -------
  function donut(segments, centerHtml, opts) {
    opts = opts || {};
    const size = opts.size || 132, thickness = opts.thickness || 13;
    const total = segments.reduce((s, x) => s + x.value, 0) || 1;
    const r = (size - thickness) / 2;
    const c = size / 2;
    const circ = 2 * Math.PI * r;
    const lens = segments.map((x) => (x.value / total) * circ);
    const arcs = segments.map((x, i) => ({ color: x.color, len: lens[i], start: lens.slice(0, i).reduce((a, b) => a + b, 0) }));
    const rings = arcs.map((a, i) => `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${a.color}" stroke-width="${thickness}" stroke-dasharray="${Math.max(0, a.len - 3).toFixed(1)} ${(circ - Math.max(0, a.len - 3)).toFixed(1)}" stroke-dashoffset="${(-a.start).toFixed(1)}" stroke-linecap="round"/>`).join("");
    return `<div class="relative" style="position:relative;display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px">
      <svg width="${size}" height="${size}" style="transform:rotate(-90deg)">
        <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="rgba(255,255,255,0.09)" stroke-width="${thickness}"/>${rings}
      </svg>
      <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center">${centerHtml}</div>
    </div>`;
  }

  // ------- эквити (ступенчатая линия) -------
  function equity(el, data) {
    const w = el.clientWidth, h = el.clientHeight;
    if (!data || data.length < 2 || w === 0) return;
    const min = Math.min(...data), max = Math.max(...data);
    const rng = max - min || 1;
    const padY = 14;
    const px = (i) => (i / (data.length - 1)) * (w - 8) + 4;
    const py = (v) => padY + (1 - (v - min) / rng) * (h - padY * 2);
    let d = `M${px(0).toFixed(1)},${py(data[0]).toFixed(1)}`;
    for (let i = 1; i < data.length; i++) d += ` L${px(i).toFixed(1)},${py(data[i - 1]).toFixed(1)} L${px(i).toFixed(1)},${py(data[i]).toFixed(1)}`;
    const baseY = py(min) + 6;
    el.innerHTML = `<svg width="${w}" height="${h}" style="width:100%" class="block">
      <line x1="0" x2="${w}" y1="${baseY.toFixed(1)}" y2="${baseY.toFixed(1)}" stroke="rgba(255,138,210,0.2)" stroke-dasharray="3 4"/>
      <path d="${d}" fill="none" stroke="#ff8ad2" stroke-width="1.6" stroke-linejoin="round" style="filter:drop-shadow(0 0 4px rgba(255,45,120,.45))"/>
      <circle cx="${px(data.length - 1).toFixed(1)}" cy="${py(data[data.length - 1]).toFixed(1)}" r="3" fill="#ff8ad2"/>
    </svg>`;
  }

  // ------- точки прогресса -------
  function progressDots(total, filled, color) {
    color = color || "#ff4fa3";
    let out = `<span class="pdots">`;
    for (let i = 0; i < total; i++) out += `<i class="${i < filled ? "f" : ""}" ${i < filled ? `style="background:${color}"` : ""}></i>`;
    return out + `</span>`;
  }

  return { candleChart, lineVolume, spark, donut, equity, progressDots };
})();

window.Charts = Charts;
