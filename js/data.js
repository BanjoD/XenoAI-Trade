// XenoAI Trade — инструменты (реальные пары Binance spot), стратегии, дефолтные цены
"use strict";

const DataLib = (() => {
  const WATCHLIST = [
    { sym: "BTC", pair: "BTCUSDT", color: "#f7931a", label: "₿", name: "bitcoin" },
    { sym: "ETH", pair: "ETHUSDT", color: "#627eea", label: "Ξ", name: "ethereum" },
    { sym: "SOL", pair: "SOLUSDT", color: "#9945ff", label: "S", name: "solana" },
    { sym: "XRP", pair: "XRPUSDT", color: "#23292f", label: "X", name: "ripple" },
    { sym: "BNB", pair: "BNBUSDT", color: "#f0b90b", label: "B", name: "binance coin" },
    { sym: "NEAR", pair: "NEARUSDT", color: "#00c08b", label: "N", name: "near protocol" },
    { sym: "SUI", pair: "SUIUSDT", color: "#4da2ff", label: "S", name: "sui" },
    { sym: "ARB", pair: "ARBUSDT", color: "#12aaff", label: "A", name: "arbitrum" },
    { sym: "TAO", pair: "TAOUSDT", color: "#e8e8e8", label: "τ", name: "bittensor" },
    { sym: "LINK", pair: "LINKUSDT", color: "#2a5ada", label: "⬡", name: "chainlink" },
    { sym: "UNI", pair: "UNIUSDT", color: "#ff66b2", label: "U", name: "uniswap" },
    { sym: "ZEC", pair: "ZECUSDT", color: "#f4b728", label: "Z", name: "zcash" },
    { sym: "ONDO", pair: "ONDOUSDT", color: "#3f6fe0", label: "O", name: "ondo finance" },
    { sym: "ENA", pair: "ENAUSDT", color: "#5b6470", label: "E", name: "ethena" },
    { sym: "PHA", pair: "PHAUSDT", color: "#7c5cff", label: "PH", name: "phala network" },
    { sym: "JUP", pair: "JUPUSDT", color: "#4fae4f", label: "J", name: "jupiter" },
    { sym: "FET", pair: "FETUSDT", color: "#1b2a4a", label: "F", name: "artificial superintelligence alliance" },
    { sym: "ZRO", pair: "ZROUSDT", color: "#2b2b2b", label: "Ø", name: "layerzero" },
    { sym: "LTC", pair: "LTCUSDT", color: "#345d9d", label: "Ł", name: "litecoin" },
    { sym: "QNT", pair: "QNTUSDT", color: "#5b8def", label: "Q", name: "quant network" },
    { sym: "GRASS", pair: "GRASSUSDT", color: "#8bc34a", label: "G", name: "grass" },
    { sym: "EIGEN", pair: "EIGENUSDT", color: "#1b1b4d", label: "E", name: "eigenlayer" },
    { sym: "KAITO", pair: "KAITOUSDT", color: "#111111", label: "K", name: "kaito" },
    { sym: "MNT", pair: "MNTUSDT", color: "#00c48c", label: "M", name: "mantle" },
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

  // стартовые цены до первого ответа источников (реальные уровни на момент релиза;
  // через ~4с всё перекрывается live-тикерами, недостающие монеты докачиваются индивидуально)
  const DEFAULT_PRICES = {
    BTC: 81315, ETH: 2388, SOL: 102.5, XRP: 1.279, BNB: 716.5, NEAR: 4.76, SUI: 0.964,
    ARB: 0.18, TAO: 263, LINK: 11.83, UNI: 7.12, ZEC: 1110, ONDO: 0.43, ENA: 0.183,
    PHA: 0.0498, JUP: 0.283, FET: 0.188, ZRO: 1.76, LTC: 59, QNT: 191.7,
    GRASS: 0.585, EIGEN: 0.233, KAITO: 0.275, MNT: 0.525,
  };

  function seedSpark(price, seed) {
    const out = [];
    for (let i = 0; i < 24; i++) out.push(price * (1 + Math.sin(i * 0.9 + seed) * 0.004));
    return out;
  }

  return { WATCHLIST, BY_SYM, ENGINE_TF, TF_MAP, STRATEGIES, DEFAULT_PRICES, seedSpark };
})();

window.DataLib = DataLib;
