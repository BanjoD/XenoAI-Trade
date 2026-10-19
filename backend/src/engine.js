// XenoAI Trade — движок (СЕРВЕР): автоматически собран из js/engine.js (build-engine.mjs).
// Байт-в-байт то же ядро, что у браузера и Стража: стратегии, политика выходов
// «тело + N%», ансамбль 13 факторов, трейлинг, обучение. Идентичность гарантирует
// паритет-тест (scripts/test-backend.js): оба движка обязаны давать одинаковые вердикты.
import { Ind } from "./vendor/indicators.js";
import { DataLib } from "./vendor/data.js";
import { Fmt } from "./vendor/format.js"; // движок не использует Fmt, но держим паритет зависимостей

export const Engine = (() => {

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

  // ================= ПОЛИТИКА ВЫХОДОВ: «ОЧЕВИДНО ПРОВАЛЬНАЯ СДЕЛКА» (R29) =================
  // Требование пользователя: ИИ больше НЕ флипает сделки на копейках из-за временного
  // минусового тренда. У каждой сделки есть «ТЕЛО» — плановый риск (расстояние вход→стоп).
  // Авто-закрытие в минусе происходит ТОЛЬКО когда убыток превысил тело + ещё N% от тела
  // (N — настройка «провальный порог», по умолчанию 50%): провальный уровень для лонга =
  // вход − тело×(1+N/100), для шорта зеркально. Во ВСЕХ остальных случаях позиция ждёт
  // профитной цели (или трейлинга в плюсе) — малый минус и фитиль за стоп-линией поводом
  // закрывать не являются: временный откат часто возвращается, а серия копеечных стопов
  // (кейс R29: 12 сделок «Стоп» за вечер, суммарно −55 ХРЮ при телах ~1%) разоряет
  // статистику быстрее настоящих провалов.
  //
  // Логика целиком:
  //   1) ЦЕЛЬ (2R) — фиксация профита (как раньше).
  //   2) СТОП В ПЛЮСЕ — трейлинг уже подтянул стоп к безубытку/+0.5R/+1R: пересечение
  //      такого стопа закрывает сделку В ПЛЮСЕ (это защита заработанного, а не убыток).
  //   3) ПРОВАЛ (тело + N%) — единственная точка авто-закрытия в минусе.
  //   4) ТРЕНД-ВЫХОД — только в плюсе, покрывающем комиссию (как раньше).
  // Стоп-линия исходного стопа становится ПРЕДУПРЕЖДЕНИЕМ: за ней позиция продолжает
  // жить (см. behindStopLine → событие «держит позицию» в ленте), закрывает её только
  // провальный уровень. failPct=0 возвращает классическое поведение «закрытие за стопом».
  const FAIL_SLACK = 0.0006; // гистерезис 0.06% поверх провального уровня: фитиль ровно на линии не закрывает

  function failLineOf(pos, failPct) {
    const dir = pos.side === "лонг" ? 1 : -1;
    // тело = плановый риск на момент входа; для позиций без r0 (лаборатория/ручные)
    // восстанавливаем из текущего стопа — трейлинг их стоп не двигает, это честное тело
    const body = (pos.r0 && pos.r0 > 0) ? pos.r0 : Math.abs(pos.entry - pos.stop);
    const n = Number.isFinite(Number(failPct)) ? Math.max(0, Math.min(200, Number(failPct))) : 50;
    return pos.entry - dir * body * (1 + n / 100);
  }

  function evalExit(pos, bars, price, failPct) {
    const dir = pos.side === "лонг" ? 1 : -1;
    if (dir * (price - pos.entry) >= dir * (pos.target - pos.entry)) return { reason: "Цель", price: pos.target };
    const slack = pos.entry * FAIL_SLACK;
    // 2) стоп в зоне профита (трейлинг подтянул к безубытку и выше): пересечение =
    //    фиксация заработанного с комиссионной планкой — всегда чистый плюс
    const stopInProfit = dir * (pos.stop - pos.entry) >= 0;
    if (stopInProfit && dir * (price - pos.entry) <= dir * (pos.stop - pos.entry) - slack) {
      return { reason: "Стоп", price: pos.stop };
    }
    // 3) ОЧЕВИДНЫЙ ПРОВАЛ: ход против сделки глубже тела + N% тела (единственный выход в минусе)
    const failLine = failLineOf(pos, failPct);
    if (dir * (price - pos.entry) <= dir * (failLine - pos.entry) - slack) {
      return { reason: "Провал", price: failLine };
    }
    // 4) тренд-выход — СИММЕТРИЧНО для лонга и шорта, но ТОЛЬКО когда сделка в плюсе,
    //    покрывающем комиссию с запасом: растущий тренд сломался — фиксируем профит;
    //    в малом минусе ИИ сделку не закрывает (ждёт цели)
    if (bars && bars.length >= 22 && dir * (price - pos.entry) > pos.entry * FEE_RATE * 1.2) {
      const closes = bars.map((b) => b.c);
      const bb = Ind.bollinger(closes, 20, 2);
      const m1 = bb.mid[bb.mid.length - 1];
      const m2 = bb.mid[bb.mid.length - 2];
      if (m1 != null && m2 != null && dir * (closes[closes.length - 1] - m1) < 0 && dir * (closes[closes.length - 2] - m2) < 0) {
        return { reason: "Сигнал выхода", price };
      }
    }
    return null;
  }

  // предупреждение: цена ушла за стоп-линию, но до провального уровня ещё далеко —
  // позиция ПРОДОЛЖАЕТ ЖИТЬ и ждёт цель (возвращается в ленту как событие-держание).
  // Работает только для стопа в минусе: у стопа в плюсе выход уже разрешён (см. evalExit).
  function behindStopLine(pos, price) {
    const dir = pos.side === "лонг" ? 1 : -1;
    if (dir * (pos.stop - pos.entry) >= 0) return false; // стоп в плюсе — там своя логика выхода
    return dir * (price - pos.entry) <= dir * (pos.stop - pos.entry);
  }

  // консервативное внутрисвечное исполнение (догоняющий движок браузера и Стража):
  // если за бар цена задевала и выходной уровень, и цель — первым считаем ВЫХОДНОЙ
  // УРОВЕНЬ (худший случай, как в реальной торговле). Уровень в минусе — НЕ старый
  // стоп, а ПРОВАЛЬНАЯ ЛИНИЯ (тело + N% от тела): временный минус за стоп-линией
  // сделку в догоне не закрывает, точно как в живом движке. Стоп, подтянутый
  // трейлингом в зону плюса, остаётся обычным стопом (защита заработанного).
  function catchExitOnBar(pos, bar, failPct) {
    const dir = pos.side === "лонг" ? 1 : -1;
    const stopInProfit = dir * (pos.stop - pos.entry) >= 0;
    const stopLevel = stopInProfit ? pos.stop : failLineOf(pos, failPct);
    const slack = pos.entry * FAIL_SLACK;
    const hitStop = dir === 1 ? bar.l <= stopLevel - slack : bar.h >= stopLevel + slack;
    const hitTarget = dir === 1 ? bar.h >= pos.target : bar.l <= pos.target;
    if (hitStop) return { reason: stopInProfit ? "Стоп" : "Провал", price: stopLevel };
    if (hitTarget) return { reason: "Цель", price: pos.target };
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
      pid: pos.id, // R30: id исходной позиции — слияние устройств схлопывает двойные закрытия и не воскрешает закрытое
      owner: pos.owner, strategy: pos.strategy, account: pos.account,
      sym: pos.sym, side: pos.side, size: pos.size, lev: pos.lev,
      entry: pos.entry, exit: exitPrice, pnl: net,
      pnlPct: (net / (pos.size * pos.lev)) * 100,
      exitReason: reason, openedAt: pos.openedAt, closedAt: Date.now(),
      ai: pos.ai || null, // снапшот ИИ (факторы) — нужен для обучения на результате
    };
  }

  // ================= ИИ-анализ: ансамбль индикаторов =================
  // Взвешенное голосование 13 факторов (тренд, RSI, MACD, BB, Ишимоку, объём,
  // импульс, новости, ADX, стохастик, старший таймфрейм, киты, GLM-аналитик) →
  // вердикт лонг/шорт/ожидание, уверенность, доля согласия (agreeShare) и уровни
  // сделки (стоп 1.2×ATR, цель 2R). brain = глобальная память ИИ (Store.state.aiBrain):
  // адаптивные веса, выученные на результатах сделок (в т.ч. лабораторных).
  const AI_BASE_WEIGHTS = { trend: 0.13, rsi: 0.1, macd: 0.11, bb: 0.08, ichi: 0.07, vol: 0.07, roc: 0.06, news: 0.08, adx: 0.09, stoch: 0.06, htf: 0.06, whale: 0.05, glm: 0.04 };

  // агрегирует 15м-свечи в старший таймфрейм (1ч = 4×15м) для фильтра HTF-тренда
  function toHigherTf(bars, group) {
    const out = [];
    for (let i = 0; i < bars.length; i += group) {
      const chunk = bars.slice(i, i + group);
      if (!chunk.length) break;
      out.push({
        o: chunk[0].o,
        c: chunk[chunk.length - 1].c,
        h: Math.max.apply(null, chunk.map((b) => b.h)),
        l: Math.min.apply(null, chunk.map((b) => b.l)),
        v: chunk.reduce((a, b) => a + (b.v || 0), 0),
        t: chunk[0].t,
      });
    }
    return out;
  }

  // ------- новостной сентимент: словарный анализ реальной ленты -------
  const LEX_BULL = ["surge", "rally", "bullish", "soar", "jump", "adoption", "partnership", "upgrade", "launch", "approval", "approved", "inflow", "accumulate", "milestone", "all-time high", "ath", "breakout", "integration", "mainnet", "staking", "etf", "institutional", "recovery", "bull run", "gains", "record", "expansion", "buy the dip", "positive", "growth", "surpassed", "milestone"];
  const LEX_BEAR = ["crash", "plunge", "slump", "drop", "fall", "sink", "bearish", "hack", "hacked", "exploit", "breach", "stolen", "drain", "lawsuit", "sues", "sued", "charges", "ban", "fraud", "scam", "ponzi", "liquidation", "liquidations", "outflow", "sell-off", "selloff", "warning", "warns", "risk", "dump", "delist", "delisting", "halt", "halted", "bankrupt", "insolvency", "fud", "tumble", "investigation", "fine", "loss", "decline", "selling pressure", "fear"];

  // возвращает { global, coin, coinItems, bull, bear } — оценки −1..1 с учётом свежести (полураспад 18ч)
  function newsSentiment(items, sym) {
    const meta = DataLib.BY_SYM[sym];
    const coinRe = sym ? new RegExp("\\b(" + sym + "|" + ((meta && meta.name) || sym) + ")\\b", "i") : null;
    const now = Date.now();
    let gNum = 0, gDen = 0, cNum = 0, cDen = 0, bull = 0, bear = 0, coinItems = 0;
    for (const it of items || []) {
      const ageH = Math.max(0, (now - (it.ts || now)) / 36e5);
      if (ageH > 48) continue; // новости старше 48ч не влияют
      const w = Math.pow(0.5, ageH / 18);
      const titleL = String(it.title || "").toLowerCase();
      const textL = (titleL + " " + String(it.body || "").toLowerCase());
      let s = 0;
      for (const k of LEX_BULL) if (textL.indexOf(k) !== -1) s += titleL.indexOf(k) !== -1 ? 1 : 0.5;
      for (const k of LEX_BEAR) if (textL.indexOf(k) !== -1) s -= titleL.indexOf(k) !== -1 ? 1 : 0.5;
      s = Math.max(-1, Math.min(1, s / 3));
      if (s > 0.05) bull++; else if (s < -0.05) bear++;
      gNum += s * w; gDen += w;
      if (coinRe && (coinRe.test(titleL) || coinRe.test(String(it.body || "")))) { cNum += s * w; cDen += w; coinItems++; }
    }
    return {
      global: gDen ? gNum / gDen : 0,
      coin: cDen ? cNum / cDen : 0,
      coinItems, bull, bear,
      fresh: gDen || 0,
    };
  }

  // ---- контекст анализа: базовые метрики + 12 факторов ансамбля ----
  // Используется и полным aiAnalyze (вердикт), и снапшотом для лабораторных сделок.
  function buildAiContext(sym, bars, brain, newsItems, extra) {
    const a = analyzeBars(bars);
    if (!a) return null;
    const closes = bars.map((b) => b.c);
    const n = closes.length;
    const price = a.price;
    const factors = [];
    const W = (k) => (brain && brain.weights && brain.weights[k] != null ? brain.weights[k] : AI_BASE_WEIGHTS[k]);

    // 1) Тренд: цена относительно EMA50
    factors.push({
      key: "trend", label: "Тренд · цена к EMA50", weight: W("trend"),
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
    factors.push({ key: "rsi", label: "RSI(14)", weight: W("rsi"), dir: rsiDir, detail: `${a.rsi.toFixed(0)} · ${rsiTxt}` });

    // 3) MACD: положение и наклон гистограммы
    const m = Ind.macdSeries(closes);
    const h1 = (m.macd[n - 1] != null && m.signal[n - 1] != null) ? m.macd[n - 1] - m.signal[n - 1] : null;
    const h2 = (m.macd[n - 2] != null && m.signal[n - 2] != null) ? m.macd[n - 2] - m.signal[n - 2] : null;
    if (h1 != null && h2 != null) {
      const growing = h1 > h2;
      const dir = h1 > 0 ? (growing ? 1 : 0.5) : (growing ? -0.5 : -1);
      factors.push({
        key: "macd", label: "MACD(12,26,9)", weight: W("macd"), dir,
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
        key: "bb", label: "Боллинджер %B", weight: W("bb"), dir,
        detail: `%B ${Math.round(pb * 100)}% · ${pb >= 1 ? "выход за канал" : pb > 0.72 ? "верхняя зона, импульс" : pb < 0.12 ? "глубоко внизу" : "внутри канала"}`,
      });
    }

    // 5) Ишимоку: цена относительно облака
    const ik = Ind.ichimoku(bars);
    const cloudTop = Math.max(ik.spanA, ik.spanB);
    const cloudBot = Math.min(ik.spanA, ik.spanB);
    const cloudDir = price > cloudTop ? 1 : price < cloudBot ? -1 : 0;
    factors.push({
      key: "ichi", label: "Ишимоку · облако", weight: W("ichi"), dir: cloudDir,
      detail: price > cloudTop ? "цена над облаком" : price < cloudBot ? "цена под облаком" : "внутри облака",
    });

    // 6) Объём: подтверждает ли направление последней свечи
    const chgSign = a.chg1 > 0 ? 1 : a.chg1 < 0 ? -1 : 0;
    const volDir = a.volRatio >= 1.35 ? chgSign * Math.min(1, 0.5 + (a.volRatio - 1.35)) : 0;
    factors.push({
      key: "vol", label: "Объём", weight: W("vol"), dir: volDir,
      detail: `×${a.volRatio.toFixed(1)} к среднему${a.volRatio >= 1.35 ? " · аномалия" : ""}`,
    });

    // 7) Импульс: ROC(10)
    const rocArr = Ind.rocSeries(closes, 10);
    const roc = rocArr[n - 1];
    if (roc != null) {
      const dir = roc > 1.2 ? 1 : roc > 0.35 ? 0.5 : roc < -1.2 ? -1 : roc < -0.35 ? -0.5 : 0;
      factors.push({
        key: "roc", label: "Импульс · ROC(10)", weight: W("roc"), dir,
        detail: `${roc >= 0 ? "+" : "−"}${Math.abs(roc).toFixed(2)}% за 10 баров`,
      });
    }

    // 8) Новостной фон: словарный сентимент реальной ленты (Cointelegraph) с учётом свежести
    if (newsItems && newsItems.length) {
      const ns = newsSentiment(newsItems, sym);
      const dir = ns.coinItems ? Math.max(-1, Math.min(1, ns.coin * 0.85 + ns.global * 0.4)) : Math.max(-1, Math.min(1, ns.global * 0.7));
      factors.push({
        key: "news", label: "Новостной фон", weight: W("news"), dir,
        detail: `${ns.coinItems ? `по ${sym}: ${ns.coin >= 0 ? "+" : "−"}${Math.abs(ns.coin).toFixed(2)}` : `по ${sym} новостей нет`} · рынок ${ns.global >= 0 ? "+" : "−"}${Math.abs(ns.global).toFixed(2)} · ${ns.bull}↑/${ns.bear}↓`,
      });
    }

    // 9) ADX(14): сила тренда и направление DI — сильный тренд подтверждает вход,
    //    слабый (ADX < 18) — рынок в боковике, ловить импульс опасно
    const adxRes = Ind.adxSeries(bars, 14);
    const adxV = adxRes.adx[n - 1];
    const pdiV = adxRes.pdi[n - 1], mdiV = adxRes.mdi[n - 1];
    let atrPct = 0.3, flashRatio = 1;
    if (adxV != null && pdiV != null && mdiV != null) {
      const diSign = pdiV > mdiV ? 1 : -1;
      const strength = Math.min(1, Math.max(0, (adxV - 15) / 30)); // 15..45 → 0..1
      const dir = adxV < 15 ? 0 : diSign * (0.35 + 0.65 * strength);
      factors.push({
        key: "adx", label: "ADX · сила тренда", weight: W("adx"), dir,
        detail: `ADX ${adxV.toFixed(0)} · DI${diSign > 0 ? "+" : "−"} ${Math.max(pdiV, mdiV).toFixed(0)} против ${Math.min(pdiV, mdiV).toFixed(0)} · ${adxV < 15 ? "боковик" : adxV < 25 ? "слабый тренд" : adxV < 40 ? "зрелый тренд" : "очень сильный тренд"}`,
      });
    }

    // 10) Stochastic (14,3): перекупленность/перепроданность по положению в диапазоне
    const st = Ind.stochSeries(bars, 14, 3);
    const kV = st.k[n - 1], dV = st.d[n - 1];
    if (kV != null && dV != null) {
      let dir, txt;
      if (kV <= 20) { dir = kV > dV ? 1 : 0.4; txt = `глубокая перепроданность %K ${kV.toFixed(0)}${kV > dV ? " · %K пересёк %D вверх" : ""}`; }
      else if (kV >= 80) { dir = kV < dV ? -1 : -0.4; txt = `перекупленность %K ${kV.toFixed(0)}${kV < dV ? " · %K пересёк %D вниз" : ""}`; }
      else if (kV > dV && kV < 55) { dir = 0.3; txt = `разворот %K вверх из нижней половины (${kV.toFixed(0)})`; }
      else if (kV < dV && kV > 45) { dir = -0.3; txt = `разворот %K вниз из верхней половины (${kV.toFixed(0)})`; }
      else { dir = 0; txt = `нейтрально %K ${kV.toFixed(0)} / %D ${dV.toFixed(0)}`; }
      factors.push({ key: "stoch", label: "Стохастик (14,3)", weight: W("stoch"), dir, detail: txt });
    }

    // 11) Старший таймфрейм (1ч): куда смотрит большая картина — против HTF
    //     входим только с дисконтом (контртренд = повышенный риск)
    const htfBars = toHigherTf(bars, 4);
    if (htfBars.length >= 25) {
      const hCloses = htfBars.map((b) => b.c);
      const hEma = Ind.emaSeries(hCloses, 20);
      const hEmaV = hEma[hEma.length - 1];
      const hEmaPrev = hEma[hEma.length - 4];
      if (hEmaV != null && hEmaPrev != null) {
        const hRel = ((price - hEmaV) / hEmaV) * 100;
        const hSlope = ((hEmaV - hEmaPrev) / hEmaPrev) * 100;
        const dir = hRel > 0.4 && hSlope > 0 ? 1 : hRel < -0.4 && hSlope < 0 ? -1 : hRel > 0 ? 0.3 : hRel < 0 ? -0.3 : 0;
        factors.push({
          key: "htf", label: "Старший ТФ · 1ч EMA20", weight: W("htf"), dir,
          detail: `цена ${hRel >= 0 ? "+" : "−"}${Math.abs(hRel).toFixed(2)}% к EMA20 · наклон ${hSlope >= 0 ? "+" : "−"}${Math.abs(hSlope).toFixed(2)}% · ${dir === 1 ? "восходящий" : dir === -1 ? "нисходящий" : "плоский"}`,
        });
      }
    }

    // 12) Киты: перевес крупных покупок над продажами (лента aggTrades биржи)
    //     + ончейн-потоки отслеживаемых кошельков-китов (база WhalesDB) — два
    //     независимых источника про одних и тех же больших игроков: смешиваем.
    const whaleMkt = extra && extra.whale && extra.whale.dir !== 0 ? extra.whale : null;
    const whaleChain = extra && extra.onchain && extra.onchain.dir !== 0 ? extra.onchain : null;
    if (whaleMkt || whaleChain) {
      let dir = 0, detail = "";
      if (whaleMkt && whaleChain) {
        dir = Math.max(-1, Math.min(1, whaleMkt.dir * 0.6 + whaleChain.dir * 0.4));
        detail = `${whaleMkt.detail} · ${whaleChain.detail}`;
      } else {
        const one = whaleMkt || whaleChain;
        dir = one.dir;
        detail = one.detail;
      }
      factors.push({
        key: "whale", label: "Киты · поток", weight: W("whale"), dir,
        detail,
      });
    }

    // 13) GLM-аналитик: большая языковая модель (Z.AI / BigModel) смотрит на сводку
    //     рынка и даёт вердикт лонг/шорт/вне рынка — работает наравне с индикаторами
    //     и обучается вместе с ними. Без ключа фактор просто отсутствует.
    if (extra && extra.glm && extra.glm.dir !== 0) {
      factors.push({
        key: "glm", label: "GLM · языковая модель", weight: W("glm"), dir: extra.glm.dir,
        detail: extra.glm.detail,
      });
    }

    // ---- производные метрики риска ----
    atrPct = (a.atr / price) * 100;
    const lastBar = bars[n - 1];
    flashRatio = a.atr > 0 ? (lastBar.h - lastBar.l) / a.atr : 1;

    return { a, factors, price, atrPct, flashRatio, closes, n };
  }

  // снапшот факторов для обучения: используется лабораторией при открытии сделки
  function aiFactorSnapshot(sym, bars, brain, newsItems, extra) {
    const ctx = buildAiContext(sym, bars, brain, newsItems, extra);
    if (!ctx) return null;
    return {
      confidence: null, // у лаборатории своя уверенность стратегии
      factors: ctx.factors.map((f) => ({ key: f.key, dir: f.dir, weight: f.weight })),
      score: null, lab: true,
    };
  }

  // ---- ВХОДНОЕ КАЧЕСТВО: отсекаем вход «в догонку» (эпидемия стопов R27) ----
  // Симптом: ИИ и лаборатория покупали ВЕРХ импульсной свечи (факторы мопента
  // голосуют «лонг» сразу после пампа) — первый же откат выбивал стоп через
  // 7–13 минут, минусы шли каскадом по всему рынку. Причины: (1) последняя
  // свеча — всплеск (аномально шире ATR): вход по её закрытию = покупка вершины;
  // (2) цена экстремально оторвалась от EMA50: тренд «перегрет», средняя далеко;
  // (3) R28: три свечи ПОДРЯД в сторону входа с ХОДОМ > 2.5 ATR за 3 бара — вертикальная
  // рампа: вход по её закрытию = покупка вершины (кейс R28: LINK и SOL лонгами на верху
  // хода, оба стопа через ~6 минут одним общим откатом). Ровный тренд с обычными
  // телами (ход ~2×ATR за 3 бара) проходит свободно — отсекается именно вертикаль.
  // В этих случаях вход откладываем до выдоха/отката — wait с честным объяснением.
  function entryQuality(a, lastBar, side, bars) {
    if (!a || !lastBar) return { ok: false, why: "нет данных" };
    const flash = a.atr > 0 ? (lastBar.h - lastBar.l) / a.atr : 0;
    if (flash > 1.8) {
      return { ok: false, why: `последняя свеча — всплеск ×${flash.toFixed(1)} к ATR: ждём выдох импульса, не догоняем памп` };
    }
    if (bars && bars.length >= 4 && a.atr > 0) {
      const l3 = bars.slice(-3);
      const netAtr = Math.abs(l3[2].c - l3[0].o) / a.atr; // чистый ход трёх баров в ATR
      const up = l3.every((b) => b.c >= b.o), dn = l3.every((b) => b.c <= b.o);
      if (side === "лонг" && up && netAtr > 2.5) {
        return { ok: false, why: `три свечи вертикального разгона вверх (+${(netAtr * 100).toFixed(0)}% ATR-хода за 3 бара) — не покупаем верх рампы, ждём выдох/откат` };
      }
      if (side === "шорт" && dn && netAtr > 2.5) {
        return { ok: false, why: `три свечи вертикального слива вниз (−${(netAtr * 100).toFixed(0)}% ATR-хода за 3 бара) — не шортим дно, ждём выдох/отскок` };
      }
    }
    if (side === "лонг" && a.ema50Rel > 7) {
      return { ok: false, why: `цена на +${a.ema50Rel.toFixed(1)}% оторвалась от EMA50 — вход в догонку, ждём откат` };
    }
    if (side === "шорт" && a.ema50Rel < -7) {
      return { ok: false, why: `цена на −${Math.abs(a.ema50Rel).toFixed(1)}% оторвалась от EMA50 — шорт в догонку, ждём откат` };
    }
    return { ok: true, why: "ок" };
  }
  function entryQualityFromBars(bars, side) {
    if (!bars || bars.length < 60) return { ok: false, why: "нет данных" };
    const a = analyzeBars(bars);
    if (!a) return { ok: false, why: "нет данных" };
    return entryQuality(a, bars[bars.length - 1], side, bars);
  }

  // ---- ЖЁСТКИЙ ФИЛЬТР СТАРШЕГО ТФ (R28) ----
  // Главный источник стопов-минусов — вход ПРОТИВ явного часового тренда: контртрендовый
  // лонг в падающем рынке (кейс R28: LINK и SOL лонгами в откате — стопы за ~6 минут).
  // Если 1ч-картина однозначно направлена (фактор htf = ровно ±1) ПРОТИВ стороны входа —
  // вход запрещён вовсе. Возвращает строку-причину для wait или null (можно входить).
  function htfVeto(bars, side) {
    if (!bars || bars.length < 60) return null;
    const htfBars = toHigherTf(bars, 4);
    if (htfBars.length < 25) return null;
    const hCloses = htfBars.map((b) => b.c);
    const hEma = Ind.emaSeries(hCloses, 20);
    const hEmaV = hEma[hEma.length - 1];
    const hEmaPrev = hEma[hEma.length - 4];
    if (hEmaV == null || hEmaPrev == null) return null;
    const price = hCloses[hCloses.length - 1];
    const hRel = ((price - hEmaV) / hEmaV) * 100;
    const hSlope = ((hEmaV - hEmaPrev) / hEmaPrev) * 100;
    const dir = hRel > 0.4 && hSlope > 0 ? 1 : hRel < -0.4 && hSlope < 0 ? -1 : 0;
    const sideSign = side === "шорт" ? -1 : 1;
    if (dir === -sideSign) {
      return `часовой тренд явно ${dir === -1 ? "нисходящий" : "восходящий"} (цена ${hRel >= 0 ? "+" : "−"}${Math.abs(hRel).toFixed(1)}% к EMA20, наклон ${hSlope >= 0 ? "+" : "−"}${Math.abs(hSlope).toFixed(2)}%) — против старшего ТФ не торгуем`;
    }
    return null;
  }

  function aiAnalyze(sym, bars, brain, newsItems, extra) {
    const ctx = buildAiContext(sym, bars, brain, newsItems, extra);
    if (!ctx) return null;
    const { a, factors, price, atrPct, flashRatio } = ctx;

    // взвешенный счёт (нормировка на сумму активных весов) + доля согласия
    let raw = 0, sumW = 0;
    for (const f of factors) { raw += f.dir * f.weight; sumW += f.weight; }
    let score = raw / (sumW || 1);
    score = Math.max(-1, Math.min(1, score));

    // доля веса факторов, голосующих с итоговым направлением (0..1):
    // чем одностороннее картина — тем надёжнее сигнал; разноголосица = риск
    const sideSign = score >= 0 ? 1 : -1;
    let agreeW = 0;
    for (const f of factors) if (f.dir * sideSign > 0) agreeW += f.weight;
    const agreeShare = sumW > 0 ? agreeW / sumW : 0;

    const ts = Date.now();
    if (Math.abs(score) < 0.14) {
      return {
        sym, ts, verdict: "wait", confidence: Math.round(40 + Math.abs(score) * 90),
        price, stop: 0, target: 0, riskPct: atrPct * 1.2, atrPct, flashRatio, factors, score, agreeShare,
        note: "факторы разнонаправлены — уверенного входа нет",
      };
    }

    const side = score > 0 ? "лонг" : "шорт";
    const baseConf = Math.round(Math.max(50, Math.min(93, 54 + Math.abs(score) * 46 + (agreeShare - 0.5) * 24)));
    const waitOut = (why, conf) => ({
      sym, ts, verdict: "wait", confidence: conf,
      price, stop: 0, target: 0, riskPct: atrPct * 1.2, atrPct, flashRatio, factors, score, agreeShare,
      note: why,
    });
    // ЖЁСТКИЙ ФИЛЬТР СТАРШЕГО ТФ (R28): вердикт против явного тренда 1ч не торгуем —
    // контртрендовые входы и есть главный источник быстрых стопов-минусов
    const hv = htfVeto(bars, side);
    if (hv) return waitOut(hv, Math.max(50, baseConf - 10));
    // стоп ≥ 0.5% от входа (УРОВЕНЬ «СУПЕР-УБЫТКА»): сделка закрывается в минус только
    // когда ход против неё очевидно провальный — много больше шума и комиссии 0.1%.
    // Цель 2R ≥ 1%: профит всегда существенно покрывает круговую комиссию.
    const risk = Math.max(a.atr * 1.2, price * 0.005);
    const stop = side === "лонг" ? price - risk : price + risk;
    const target = side === "лонг" ? price + risk * 2 : price - risk * 2;
    // уверенность: сила счёта + бонус за односторонность факторов − штраф за разноголосицу
    const confidence = baseConf;
    // АНТИ-ДОГОН: всплеск/перегрев/рампа — вход откладывается (verdict wait с объяснением);
    // автопилот, идеи и сигналы видят честную причину вместо слепого входа
    const eq = entryQuality(a, bars[bars.length - 1], side, bars);
    if (!eq.ok) {
      return waitOut(eq.why, Math.max(50, confidence - 12));
    }
    const top = [...factors].sort((x, y) => Math.abs(y.dir * y.weight) - Math.abs(x.dir * x.weight)).slice(0, 3);
    return {
      sym, ts, verdict: side, confidence, price, stop, target,
      riskPct: (risk / price) * 100, targetPct: ((risk * 2) / price) * 100,
      atrPct, flashRatio, factors, score, agreeShare,
      note: top.map((f) => `${f.label}: ${f.detail}`).join(" · "),
    };
  }

  // ---- трейлинг-защита ИИ-позиции: стоп двигается ТОЛЬКО в пользу сделки ----
  // +1R  → стоп в безубыток (вход + максимум из 0.1R и 0.25% — ПОКРЫВАЕТ комиссию 0.1% с запасом)
  // +1.5R → стоп фиксирует минимум +0.5R (и тоже не ниже комиссионной планки)
  // +2R  → трейлинг на расстоянии 1R от текущей цены
  // Убыток трейлинг не ускоряет: раньше стопа позицию не закрывает (требование 12).
  // ИСТОРИЧЕСКИЙ БАГ (кейс JUP): безубыток был «вход + 0.1R» — при крошечном R (0.47%)
  // это всего +0.047% хода, круговая комиссия 0.1% делала «безубыток» ГАРАНТИРОВАННЫМ
  // минусом (−0.27 ХРЮ). Теперь комиссионная планка учитывается явно.
  function aiTrailStop(pos, price) {
    if (!pos || !pos.ai || pos.strategy !== "ai") return null;
    // r0 фиксируем при первом трейлинге: после сдвига стопа |entry−stop| уже не исходный риск
    if (!pos.r0 || !(pos.r0 > 0)) pos.r0 = Math.abs(pos.entry - pos.stop);
    const r0 = pos.r0;
    if (!r0 || r0 <= 0) return null;
    const dir = pos.side === "лонг" ? 1 : -1;
    const gainR = (dir * (price - pos.entry)) / r0;
    if (gainR < 1) return null;
    const feeGap = ((pos.entry || price) * FEE_RATE * 2.5) / (pos.lev || 1); // ≈0.25% хода — комиссия 0.1% с запасом ×2.5
    let want;
    if (gainR >= 2) want = price - dir * r0;                              // трейлинг 1R
    else if (gainR >= 1.5) want = pos.entry + dir * Math.max(r0 * 0.5, feeGap); // фикс +0.5R (не ниже комиссии)
    else want = pos.entry + dir * Math.max(r0 * 0.1, feeGap);             // безубыток, реально покрывающий комиссию
    const better = dir === 1 ? want > pos.stop : want < pos.stop;
    return better ? want : null;
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

  return { STRATEGIES, analyzeBars, evalStrategy, evalExit, failLineOf, behindStopLine, catchExitOnBar, positionPnl, closeTrade, mkLabAccounts, aiAnalyze, aiFactorSnapshot, aiTrailStop, newsSentiment, AI_BASE_WEIGHTS, FEE_RATE, FAIL_SLACK, entryQuality, entryQualityFromBars, htfVeto };

})();

export default Engine;
