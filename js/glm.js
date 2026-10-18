// XenoAI Trade — GLM-АНАЛИТИК: большая языковая модель как 13-й фактор ансамбля ИИ.
// Подключается своим ключом пользователя (Z.AI / BigModel — GLM бесплатного уровня тоже
// подходит, например glm-4-flash). Раз в 10 минут платформа собирает компактную сводку
// рынка (движения, тренды BTC/ETH, новостной фон, потоки китов) и спрашивает у GLM
// вердикт: лонг / шорт / вне рынка + уверенность + краткое обоснование. Ответ кормится
// в Engine.aiAnalyze как фактор extra.glm — наравне с индикаторами, и обучается вместе
// с ними (ключ "glm" в AI_BASE_WEIGHTS). Ключ хранится ТОЛЬКО в localStorage браузера
// и уходит напрямую в API провайдера — платформа-посредник не участвует.
"use strict";

const GLM = (() => {
  const LS_KEY = "xenoai_glm_v1";
  const ASK_MS = 10 * 60000; // интервал фонового опроса аналитика

  const PRESETS = [
    { id: "zai", label: "Z.AI (api.z.ai)", url: "https://api.z.ai/api/paas/v4/chat/completions", model: "glm-4.6" },
    { id: "bigmodel", label: "BigModel (open.bigmodel.cn)", url: "https://open.bigmodel.cn/api/paas/v4/chat/completions", model: "glm-4-flash" },
  ];

  let settings = { endpoint: PRESETS[0].url, model: PRESETS[0].model, apiKey: "", on: false };
  let verdict = { bias: null, confidence: 0, reasoning: "", ts: 0, model: "", status: "not-configured", error: null };
  let asking = false, timer = null;

  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (d && typeof d === "object") {
          settings = {
            endpoint: typeof d.endpoint === "string" && d.endpoint ? d.endpoint : PRESETS[0].url,
            model: typeof d.model === "string" && d.model ? d.model : PRESETS[0].model,
            apiKey: typeof d.apiKey === "string" ? d.apiKey : "",
            on: !!d.on,
          };
          if (d.lastVerdict) verdict = { ...verdict, ...d.lastVerdict };
        }
      }
    } catch (e) { /* noop */ }
  }
  function persist() {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ ...settings, lastVerdict: verdict })); } catch (e) { /* noop */ }
  }
  load();

  // ================= сводка рынка для модели =================
  function marketBrief() {
    const s = Store.state;
    const lines = [];
    const px = (sym) => (s.prices[sym] && s.prices[sym].price) || 0;
    const chg = (sym) => (s.prices[sym] && s.prices[sym].chg24h) || 0;
    lines.push(`BTC $${px("BTC").toFixed(0)} (${chg("BTC") >= 0 ? "+" : ""}${chg("BTC").toFixed(1)}%/24ч)`);
    lines.push(`ETH $${px("ETH").toFixed(0)} (${chg("ETH") >= 0 ? "+" : ""}${chg("ETH").toFixed(1)}%/24ч)`);
    const movers = Object.values(s.prices).filter((p) => p.price > 0).sort((a, b) => Math.abs(b.chg24h) - Math.abs(a.chg24h)).slice(0, 5);
    if (movers.length) lines.push("Топ движений 24ч: " + movers.map((p) => `${p.sym} ${p.chg24h >= 0 ? "+" : ""}${p.chg24h.toFixed(1)}%`).join(", "));
    const brain = s.aiBrain || {};
    if (brain.trades) lines.push(`Винрейт нашего ансамбля: ${Math.round((brain.wins / brain.trades) * 100)}% на ${brain.trades} сделках`);
    try {
      const onB = WhalesDB.bias("BTC"), onE = WhalesDB.bias("ETH");
      if (onB) lines.push("Ончейн BTC: " + onB.detail);
      if (onE) lines.push("Ончейн ETH: " + onE.detail);
    } catch (e) { /* киты не готовы */ }
    if (s.news && s.news.items && s.news.items.length) {
      lines.push("Свежие заголовки:");
      s.news.items.slice(0, 8).forEach((n) => lines.push("— " + String(n.title || "").slice(0, 110)));
    }
    return lines.join("\n");
  }

  const SYSTEM = "Ты — крипто-аналитик внутри торговой платформы. Тебе дают краткую сводку рынка. Дай ОДИН вердикт по рынку на ближайшие часы. Ответ строго в JSON без markdown: {\"bias\":\"long\"|\"short\"|\"flat\",\"confidence\":0-100,\"reasoning\":\"1-2 предложения по-русски с ключевой причиной\"}. Не выдумывай данные, которых нет в сводке.";

  async function ask() {
    if (!settings.apiKey || asking) return verdict;
    asking = true;
    verdict.status = "asking";
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 30000);
      const res = await fetch(settings.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + settings.apiKey },
        body: JSON.stringify({
          model: settings.model || "glm-4-flash",
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: marketBrief() },
          ],
          temperature: 0.3,
          max_tokens: 220,
        }),
        signal: ctl.signal,
      });
      clearTimeout(t);
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((j.error && j.error.message) || "HTTP " + res.status);
      const txt = (((j.choices || [])[0] || {}).message || {}).content || "";
      const m = txt.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("в ответе нет JSON");
      const parsed = JSON.parse(m[0]);
      const bias = parsed.bias === "long" ? "лонг" : parsed.bias === "short" ? "шорт" : "flat";
      const conf = Math.max(0, Math.min(100, Math.round(Number(parsed.confidence) || 0)));
      verdict = {
        bias, confidence: conf,
        reasoning: String(parsed.reasoning || "").slice(0, 240),
        ts: Date.now(), model: settings.model, status: "ok", error: null,
      };
      persist();
    } catch (e) {
      verdict.status = "error";
      verdict.error = String(e && e.message || e);
    } finally {
      asking = false;
    }
    return verdict;
  }

  function start() {
    if (timer) return;
    if (settings.on && settings.apiKey) ask();
    if (typeof setInterval === "function") timer = setInterval(() => { if (settings.on && settings.apiKey && !document.hidden) ask(); }, ASK_MS);
  }

  // ================= фактор для ансамбля =================
  // Рыночный вердикт GLM применяется ко всем монетам с угасанием по времени (2 часа)
  function factor() {
    if (!settings.on || verdict.status !== "ok" || !verdict.bias) return null;
    const ageH = (Date.now() - verdict.ts) / 36e5;
    if (ageH > 2) return null;
    const decay = Math.max(0.35, 1 - ageH / 2);
    const dir = verdict.bias === "лонг" ? 1 : verdict.bias === "шорт" ? -1 : 0;
    const strength = (verdict.confidence / 100) * decay;
    if (dir === 0 || strength < 0.15) {
      return { dir: 0, detail: `GLM вне рынка: ${verdict.reasoning || "без явного перевеса"}` };
    }
    return {
      dir: dir * strength,
      detail: `GLM ${verdict.bias} (${verdict.confidence}%${ageH > 0.25 ? `, ${Math.round(ageH * 60)} мин назад` : ""}): ${verdict.reasoning}`,
    };
  }

  // ---------- публичное API ----------
  function getSettings() { return { ...settings }; }
  function save(next) {
    const ep = String(next.endpoint || "").trim();
    const model = String(next.model || "").trim();
    if (ep && !/^https:\/\/.+/.test(ep)) return { ok: false, error: "Endpoint должен начинаться с https://" };
    settings.endpoint = ep || PRESETS[0].url;
    settings.model = model || "glm-4-flash";
    settings.apiKey = String(next.apiKey || "").trim();
    if (next.on !== undefined) settings.on = !!next.on;
    if (settings.on && !settings.apiKey) settings.on = false;
    persist();
    if (settings.on && settings.apiKey) ask();
    return { ok: true };
  }
  function status() { return { ...verdict, asking }; }
  function enabled() { return settings.on && Boolean(settings.apiKey); }
  function presets() { return PRESETS; }
  function setPreset(id) {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return { ok: false, error: "Неизвестный провайдер" };
    settings.endpoint = p.url; settings.model = p.model;
    persist();
    return { ok: true };
  }

  return { start, ask, factor, getSettings, save, status, enabled, presets, setPreset };
})();

window.GLM = GLM;
