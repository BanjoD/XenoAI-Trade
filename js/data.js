// XenoAI Trade — инструменты (реальные пары Binance spot), стратегии, дефолтные цены
"use strict";

const DataLib = (() => {
  const WATCHLIST = [
    { sym: "BTC", pair: "BTCUSDT", color: "#f7931a", label: "₿" },
    { sym: "ETH", pair: "ETHUSDT", color: "#627eea", label: "Ξ" },
    { sym: "SOL", pair: "SOLUSDT", color: "#9945ff", label: "S" },
    { sym: "XRP", pair: "XRPUSDT", color: "#23292f", label: "X" },
    { sym: "BNB", pair: "BNBUSDT", color: "#f0b90b", label: "B" },
    { sym: "NEAR", pair: "NEARUSDT", color: "#00c08b", label: "N" },
    { sym: "SUI", pair: "SUIUSDT", color: "#4da2ff", label: "S" },
    { sym: "ARB", pair: "ARBUSDT", color: "#12aaff", label: "A" },
    { sym: "TAO", pair: "TAOUSDT", color: "#e8e8e8", label: "τ" },
    { sym: "LINK", pair: "LINKUSDT", color: "#2a5ada", label: "⬡" },
    { sym: "UNI", pair: "UNIUSDT", color: "#ff66b2", label: "U" },
    { sym: "ZEC", pair: "ZECUSDT", color: "#f4b728", label: "Z" },
    { sym: "ONDO", pair: "ONDOUSDT", color: "#3f6fe0", label: "O" },
    { sym: "ENA", pair: "ENAUSDT", color: "#5b6470", label: "E" },
    { sym: "PHA", pair: "PHAUSDT", color: "#7c5cff", label: "PH" },
    { sym: "JUP", pair: "JUPUSDT", color: "#4fae4f", label: "J" },
    { sym: "FET", pair: "FETUSDT", color: "#1b2a4a", label: "F" },
    { sym: "ZRO", pair: "ZROUSDT", color: "#2b2b2b", label: "Ø" },
    { sym: "LTC", pair: "LTCUSDT", color: "#345d9d", label: "Ł" },
    { sym: "QNT", pair: "QNTUSDT", color: "#5b8def", label: "Q" },
    { sym: "GRASS", pair: "GRASSUSDT", color: "#8bc34a", label: "G" },
    { sym: "EIGEN", pair: "EIGENUSDT", color: "#1b1b4d", label: "E" },
    { sym: "KAITO", pair: "KAITOUSDT", color: "#111111", label: "K" },
    { sym: "MNT", pair: "MNTUSDT", color: "#00c48c", label: "M" },
  ];

  const BY_SYM = {};
  WATCHLIST.forEach((i) => { BY_SYM[i.sym] = i; });

  const ENGINE_TF = "15m";

  const TF_MAP = {
    "1м": { binance: "1m", stepMin: 1 },
    "5м": { binance: "5m", stepMin: 5 },
    "15м": { binance: "15m", stepMin: 15 },
    "1ч": { binance: "1h", stepMin: 60 },
    "4ч": { binance: "4h", stepMin: 240 },
    "1д": { binance: "1d", stepMin: 1440 },
  };

  const STRATEGIES = [
    { id: "bb", name: "Пробой верхней Боллинджера", short: "Пробой верхней Б.", tf: "15м", desc: "Закрытие выше BB(20,2) + объём ×1.2" },
    { id: "ichi", name: "Ichimoku полное вхождение", short: "Ichimoku полное в.", tf: "15м", desc: "Цена над облаком, Тенкан > Кидзюн" },
    { id: "macd", name: "MACD-кросс + RSI>50", short: "MACD-кросс + RSI", tf: "15м", desc: "Бычий кросс MACD при RSI>50" },
    { id: "vbreak", name: "Объёмный пробой", short: "Объёмный пробой", tf: "15м", desc: "Объём ×2 + пробой 20-барного максимума" },
    { id: "anomaly", name: "Продолжение аномалии", short: "Продолжение ано.", tf: "15м", desc: "ROC(10) > 2% при RSI 55–75" },
  ];

  const DEFAULT_PRICES = {
    BTC: 82200, ETH: 2725, SOL: 138, XRP: 2.14, BNB: 610, NEAR: 5.28, SUI: 1.02,
    ARB: 0.43, TAO: 389, LINK: 14.1, UNI: 8.4, ZEC: 53.9, ONDO: 0.48, ENA: 0.24,
    PHA: 0.063, JUP: 0.33, FET: 0.24, ZRO: 32.1, LTC: 12.45, QNT: 192.7,
    GRASS: 1.31, EIGEN: 2.09, KAITO: 1.66, MNT: 1.18,
  };

  function seedSpark(price, seed) {
    const out = [];
    for (let i = 0; i < 24; i++) out.push(price * (1 + Math.sin(i * 0.9 + seed) * 0.004));
    return out;
  }

  return { WATCHLIST, BY_SYM, ENGINE_TF, TF_MAP, STRATEGIES, DEFAULT_PRICES, seedSpark };
})();

window.DataLib = DataLib;
