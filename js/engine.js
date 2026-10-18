// XenoAI Trade — торговый движок: стратегии, сигналы, выходы, лаборатория
"use strict";

const Engine = (() => {
  const STRATEGIES = DataLib.STRATEGIES;

  function analyzeBars(bars) {
    if (!bars || bars.length < 60) return null;
    const closes = bars.map((b) => b.c);
    const price = closes[closes.length - 1];
    const atrArr = Ind.atrSeries(bars, 14);
    const atr = atrArr[atrArr.length - 1];
    if (atr == null) return null;
    const rsiArr = Ind.rsiSeries(closes, 14);
    const rsi = rsiArr[rsiArr.length - 1] != null ? rsiArr[rsiArr.length - 1] : 50;
    const vols = bars.map((b) => b.v);
    const vAvg = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20 || 1;
    const volRatio = vols[vols.length - 1] / vAvg;
    const chg1 = ((closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2]) * 100;
    const e50 = Ind.emaSeries(closes, 50);
    const e50v = e50[e50.length - 1] != null ? e50[e50.length - 1] : price;
    return { price, atr, rsi, volRatio, chg1, ema50Rel: ((price - e50v) / e50v) * 100 };
  }

  // проверяет условия стратегии; возвращает сигнал или null
  function evalStrategy(id, sym, bars) {
    const a = analyzeBars(bars);
    if (!a) return null;
    const n = bars.length;
    const closes = bars.map((b) => b.c);
    const last = bars[n - 1];
    const prev = bars[n - 2];
    const risk = Math.max(a.atr * 1.2, a.price * 0.0035);
    const stop = a.price - risk;
    const target = a.price + risk * 2;
    let hit = null;

    if (id === "bb") {
      const bb = Ind.bollinger(closes, 20, 2);
      const up = bb.upper[n - 2];
      if (up != null && prev.c > up && prev.c > prev.o && last.c >= a.price * 0.998) {
        const conf = Math.min(95, 58 + (a.volRatio - 1) * 18 + Math.max(0, a.ema50Rel) * 1.2);
        hit = { conf: Math.round(conf), note: `закрытие ${sym} выше верхней BB(20,2) · объём ×${a.volRatio.toFixed(1)}` };
      }
    } else if (id === "ichi") {
      const ik = Ind.ichimoku(bars);
      const cloudTop = Math.max(ik.spanA, ik.spanB);
      const cloudBot = Math.min(ik.spanA, ik.spanB);
      if (a.price > cloudTop && ik.tenkan > ik.kijun && a.price > cloudBot) {
        const above = ((a.price - cloudTop) / cloudTop) * 100;
        const conf = Math.min(93, 56 + above * 6 + (ik.tenkan / ik.kijun - 1) * 120);
        hit = { conf: Math.round(conf), note: `цена над облаком Ишимоку +${above.toFixed(1)}% · Тенкан > Кидзюн` };
      }
    } else if (id === "macd") {
      const m = Ind.macdSeries(closes);
      const m1 = m.macd[n - 1], m2 = m.macd[n - 2], s1 = m.signal[n - 1], s2 = m.signal[n - 2];
      if (m1 != null && m2 != null && s1 != null && s2 != null && m2 <= s2 && m1 > s1 && a.rsi > 50) {
        const conf = Math.min(92, 55 + (a.rsi - 50) * 0.7 + Math.max(0, a.ema50Rel) * 1.1);
        hit = { conf: Math.round(conf), note: `MACD-кросс вверх при RSI ${a.rsi.toFixed(0)}` };
      }
    } else if (id === "vbreak") {
      const hi20 = Ind.highest(bars.slice(0, -1), 20);
      if (a.volRatio >= 2 && last.c > hi20 && last.c > last.o) {
        const conf = Math.min(96, 60 + (a.volRatio - 2) * 8 + a.chg1 * 5);
        hit = { conf: Math.round(conf), note: `объём ×${a.volRatio.toFixed(1)} · пробой 20-барного максимума` };
      }
    } else if (id === "anomaly") {
      const roc = Ind.rocSeries(closes, 10);
      const r = roc[n - 1];
      if (r != null && r > 2 && a.rsi >= 55 && a.rsi <= 76 && a.ema50Rel > 0) {
        const conf = Math.min(90, 54 + r * 2 + (a.rsi - 55) * 0.4);
        hit = { conf: Math.round(conf), note: `импульс +${r.toFixed(1)}% за 10 баров · RSI ${a.rsi.toFixed(0)}` };
      }
    }

    if (!hit) return null;
    return {
      id: `${id}-${sym}-${Math.floor(Date.now() / 60000)}`,
      strategy: id, sym,
      entry: a.price, stop, target,
      confidence: hit.conf, atr: a.atr, ts: Date.now(), note: hit.note,
    };
  }

  // выход по живой цене: цель/стоп/сигнал (закрытие ниже средней BB)
  function evalExit(pos, bars, price) {
    const dir = pos.side === "лонг" ? 1 : -1;
    if (dir * (price - pos.entry) >= dir * (pos.target - pos.entry)) return { reason: "Цель", price: pos.target };
    if (dir * (price - pos.entry) <= dir * (pos.stop - pos.entry)) return { reason: "Стоп", price: pos.stop };
    if (bars && bars.length >= 22 && pos.side === "лонг") {
      const closes = bars.map((b) => b.c);
      const bb = Ind.bollinger(closes, 20, 2);
      const m1 = bb.mid[bb.mid.length - 1];
      const m2 = bb.mid[bb.mid.length - 2];
      if (m1 != null && m2 != null && closes[closes.length - 1] < m1 && closes[closes.length - 2] < m2) {
        return { reason: "Сигнал выхода", price };
      }
    }
    return null;
  }

  function positionPnl(pos, price) {
    const dir = pos.side === "лонг" ? 1 : -1;
    const pct = ((price / pos.entry - 1) * 100) * dir;
    const pnl = pos.size * pos.lev * (pct / 100);
    return { pnl, pct };
  }

  const FEE_RATE = 0.001; // условная комиссия 0.1% за круг

  function closeTrade(pos, exitPrice, reason) {
    const { pnl } = positionPnl(pos, exitPrice);
    const fee = pos.size * pos.lev * FEE_RATE;
    const net = pnl - fee;
    return {
      id: `${pos.id}-c${Date.now()}`,
      owner: pos.owner, strategy: pos.strategy, account: pos.account,
      sym: pos.sym, side: pos.side, size: pos.size, lev: pos.lev,
      entry: pos.entry, exit: exitPrice, pnl: net,
      pnlPct: (net / (pos.size * pos.lev)) * 100,
      exitReason: reason, openedAt: pos.openedAt, closedAt: Date.now(),
    };
  }

  // ================= ИИ-анализ: ансамбль индикаторов =================
  // Взвешенное голосование 7 факторов → вердикт лонг/шорт/ожидание,
  // уверенность и уровни сделки (стоп 1.2×ATR, цель 2R).
  function aiAnalyze(sym, bars) {
    const a = analyzeBars(bars);
    if (!a) return null;
    const closes = bars.map((b) => b.c);
    const n = closes.length;
    const price = a.price;
    const factors = [];

    // 1) Тренд: цена относительно EMA50
    factors.push({
      key: "trend", label: "Тренд · цена к EMA50", weight: 0.22,
      dir: a.ema50Rel > 0.12 ? 1 : a.ema50Rel < -0.12 ? -1 : a.ema50Rel > 0 ? 0.5 : -0.5,
      detail: `${a.ema50Rel >= 0 ? "+" : "−"}${Math.abs(a.ema50Rel).toFixed(2)}%`,
    });

    // 2) RSI(14): зоны перекупленности/перепроданности
    let rsiDir = 0;
    let rsiTxt = `нейтральная зона`;
    if (a.rsi <= 32) { rsiDir = 1; rsiTxt = "перепроданность, шанс отскока"; }
    else if (a.rsi < 46) { rsiDir = 0.4; rsiTxt = "ниже середины — слабость"; }
    else if (a.rsi <= 62) { rsiDir = 0.6; rsiTxt = "бычья зона"; }
    else if (a.rsi <= 74) { rsiDir = -0.4; rsiTxt = "приближается к перекупленности"; }
    else { rsiDir = -1; rsiTxt = "перекупленность, риск отката"; }
    factors.push({ key: "rsi", label: "RSI(14)", weight: 0.16, dir: rsiDir, detail: `${a.rsi.toFixed(0)} · ${rsiTxt}` });

    // 3) MACD: положение и наклон гистограммы
    const m = Ind.macdSeries(closes);
    const h1 = (m.macd[n - 1] != null && m.signal[n - 1] != null) ? m.macd[n - 1] - m.signal[n - 1] : null;
    const h2 = (m.macd[n - 2] != null && m.signal[n - 2] != null) ? m.macd[n - 2] - m.signal[n - 2] : null;
    if (h1 != null && h2 != null) {
      const growing = h1 > h2;
      const dir = h1 > 0 ? (growing ? 1 : 0.5) : (growing ? -0.5 : -1);
      factors.push({
        key: "macd", label: "MACD(12,26,9)", weight: 0.18, dir,
        detail: `гистограмма ${h1 >= 0 ? "+" : "−"}${Math.abs((h1 / price) * 100).toFixed(3)}% · ${growing ? "растёт" : "падает"}`,
      });
    }

    // 4) Боллинджер: %B — положение цены в канале
    const bb = Ind.bollinger(closes, 20, 2);
    const bTop = bb.upper[n - 1], bBot = bb.lower[n - 1], bMid = bb.mid[n - 1];
    if (bTop != null && bTop > bBot) {
      const pb = (price - bBot) / (bTop - bBot);
      const dir = pb >= 1 ? -0.4 : pb > 0.72 ? 0.8 : pb > 0.55 ? 0.4 : pb < 0.12 ? 0.6 : pb < 0.3 ? -0.6 : -0.2;
      factors.push({
        key: "bb", label: "Боллинджер %B", weight: 0.14, dir,
        detail: `%B ${Math.round(pb * 100)}% · ${pb >= 1 ? "выход за канал" : pb > 0.72 ? "верхняя зона, импульс" : pb < 0.12 ? "глубоко внизу" : "внутри канала"}`,
      });
    }

    // 5) Ишимоку: цена относительно облака
    const ik = Ind.ichimoku(bars);
    const cloudTop = Math.max(ik.spanA, ik.spanB);
    const cloudBot = Math.min(ik.spanA, ik.spanB);
    const cloudDir = price > cloudTop ? 1 : price < cloudBot ? -1 : 0;
    factors.push({
      key: "ichi", label: "Ишимоку · облако", weight: 0.12, dir: cloudDir,
      detail: price > cloudTop ? "цена над облаком" : price < cloudBot ? "цена под облаком" : "внутри облака",
    });

    // 6) Объём: подтверждает ли направление последней свечи
    const chgSign = a.chg1 > 0 ? 1 : a.chg1 < 0 ? -1 : 0;
    const volDir = a.volRatio >= 1.35 ? chgSign * Math.min(1, 0.5 + (a.volRatio - 1.35)) : 0;
    factors.push({
      key: "vol", label: "Объём", weight: 0.1, dir: volDir,
      detail: `×${a.volRatio.toFixed(1)} к среднему${a.volRatio >= 1.35 ? " · аномалия" : ""}`,
    });

    // 7) Импульс: ROC(10)
    const rocArr = Ind.rocSeries(closes, 10);
    const roc = rocArr[n - 1];
    if (roc != null) {
      const dir = roc > 1.2 ? 1 : roc > 0.35 ? 0.5 : roc < -1.2 ? -1 : roc < -0.35 ? -0.5 : 0;
      factors.push({
        key: "roc", label: "Импульс · ROC(10)", weight: 0.08, dir,
        detail: `${roc >= 0 ? "+" : "−"}${Math.abs(roc).toFixed(2)}% за 10 баров`,
      });
    }

    // взвешенный счёт
    let score = 0;
    for (const f of factors) score += f.dir * f.weight;
    score = Math.max(-1, Math.min(1, score));

    const ts = Date.now();
    if (Math.abs(score) < 0.14) {
      return {
        sym, ts, verdict: "wait", confidence: Math.round(40 + Math.abs(score) * 90),
        price, stop: 0, target: 0, riskPct: 0, factors, score,
        note: "факторы разнонаправлены — уверенного входа нет",
      };
    }

    const side = score > 0 ? "лонг" : "шорт";
    const risk = Math.max(a.atr * 1.2, price * 0.004);
    const stop = side === "лонг" ? price - risk : price + risk;
    const target = side === "лонг" ? price + risk * 2 : price - risk * 2;
    const confidence = Math.round(Math.min(93, 56 + Math.abs(score) * 48));
    const top = [...factors].sort((x, y) => Math.abs(y.dir * y.weight) - Math.abs(x.dir * x.weight)).slice(0, 3);
    return {
      sym, ts, verdict: side, confidence, price, stop, target,
      riskPct: (risk / price) * 100, targetPct: ((risk * 2) / price) * 100,
      factors, score,
      note: top.map((f) => `${f.label}: ${f.detail}`).join(" · "),
    };
  }

  function mkLabAccounts() {
    return STRATEGIES.map((s, i) => ({
      id: `lab-${s.id}`,
      strategy: s.id,
      name: s.name,
      isProtected: i % 2 === 1, // каждый второй — защищённый вариант (ЗАЩ)
      balance: 10000,
      start: 10000,
      equityHist: Array.from({ length: 12 }, () => 10000),
      days: 0,
    }));
  }

  return { STRATEGIES, analyzeBars, evalStrategy, evalExit, positionPnl, closeTrade, mkLabAccounts, aiAnalyze, FEE_RATE };
})();

window.Engine = Engine;
