// XenoAI Trade — глобальный store: реальные данные Binance + торговый движок
// + демо-счёт в ХРЮ (персистится в localStorage). При недоступности API —
// деградация в симуляцию, чтобы платформа оставалась живой.
"use strict";

const Store = (() => {
  const { WATCHLIST, BY_SYM, ENGINE_TF, TF_MAP, DEFAULT_PRICES, seedSpark } = DataLib;
  const WATCH_SYMS = WATCHLIST.map((i) => i.sym);
  // обратный индекс «биржевая пара → символ платформы»: у GRAM (оригинальный Toncoin,
  // сеть The Open Network) биржевая пара TONUSDT, а не GRAMUSDT — без индекса
  // тикер из общей ленты не нашёл бы свою монету
  const PAIR_TO_SYM = {};
  WATCHLIST.forEach((i) => { if (i.pair) PAIR_TO_SYM[i.pair] = i.sym; });

  const listeners = new Set();
  const state = {
    prices: {},
    bars: {},            // ключ `${sym}:${tf}`
    degraded: false,
    source: null,        // рабочий источник данных: binance / bybit / okx / null (симуляция)
    lastSync: 0,
    signals: [],
    labAccounts: Engine.mkLabAccounts(),
    labPositions: [],
    labClosed: [],
    // автоторговля лаборатории ВКЛЮЧЕНА по умолчанию: сигналы движка принимаются
    // счетами стратегий автоматически (запрос пользователя — «предложения в сигналах
    // висят, приходится принимать вручную»). Лабораторные сделки живут внутри своих
    // 10 000 ХРЮ и не трогают баланс владельца; выключить можно тумблером в «Счетах».
    autoTrade: true,
    labAutoMigrated: false, // одноразовая миграция: старые аккаунты с autoTrade=false переводятся на вкл (один раз)
    events: [],
    whales: {},
    whaleScannedAt: {},
    balance: 10000,
    startBalance: 10000,
    userPositions: [],
    userClosed: [],
    equityHist: [],
    updatedAt: 0,       // время последнего изменения аккаунта (настенные часы для слияния синка)
    started: false,
    activeSym: "BTC",
    mode: "demo",       // demo | live (реальный рынок)
    aiAuto: true,       // ИИ-автопилот: сам заходит в монеты и флипает, спот-only
    aiIdeas: [],        // сканер ИИ: лучшие идеи по всем монетам
    // R43 «Теневая торговля»: журнал отказов ИИ и их проверка фактом через 8 часов
    shadow: { list: [], stats: { right: 0, wrong: 0, flat: 0, avoidedSum: 0, avoidedN: 0, since: 0 } },
    liveOrders: [],     // отправленные реальные ордера (заготовка реальной торговли)
    liveStats: { n: 0, wins: 0, losses: 0, pnlUsdt: 0, since: 0 }, // R49: итог обучения ИИ на реальных сделках (считает сервер)
    glmSrv: null,       // R49: вердикт GLM-аналитика СЕРВЕРА (13-й фактор 24/7; без ключа — только вердикт)
    okx: { on: false, auto: false, mask: "", balanceUSDT: null, balanceEq: null, ts: 0, lastSync: 0, lastErr: "" }, // R51: полная синхронизация OKX (публичное состояние; ключи живут на сервере)
    aiBrain: null,      // память ИИ: адаптивные веса, статистика монет, уроки (обучение на сделках)
    aiSession: null,    // сессия автопилота: { startEquity, openedAt } — база для авто-стопа ±лимит
    aiStop: null,       // причина авто-стопа сессии: { reason: profit|loss, pct, ts, threshold, closed }
    aiThreshold: 50,    // лимит сессии ИИ, % от базы: +50% профита или −50% просадки → стоп (настраивается)
    failPct: 50,        // R29 «провальный порог», % от тела: авто-закрытие в минусе ТОЛЬКО когда ход против сделки глубже тела ещё на N% (0..200)
    aiMaxPos: 5,        // ручной максимум одновременных ИИ-позиций (1..8; работает в режиме "вручную")
    aiPosMode: "auto",  // кто задаёт число одновременных ИИ-позиций: "auto" (из лимитов) или 1..8
    maxDeal: 1000,      // максимальная сумма ОДНОЙ сделки, ХРЮ (≈ $) — действует на все сделки счёта
    maxTotal: 5000,     // максимальная СУММАРНАЯ сумма всех сделок в рынке, ХРЮ (≈ $)
    news: { items: [], ts: 0, source: null }, // реальная новостная лента (для ИИ и карточки фона)
    aiAutoLive: false,  // автопилот в РЕАЛЬНОМ режиме: по умолчанию ВЫКЛ (требование безопасности)
    lastCatchUp: 0,     // когда платформа последний раз «догоняла» рынок после офлайна
    lastScanAt: 0,      // хартбит ИИ-сканера: время последнего прогона движка по монете
    rev: 0,             // ревизия состояния: растёт с каждой записью (для слияния синка устройств)
    aiCooldownUntil: 0, // пауза автопилота после серии минусов (до какого времени новые входы закрыты)
    aiCooldownSeen: 0,  // длина серии, на которую пауза УЖЕ отработана (иначе пауза продлевала бы сама себя вечно)
    aiBan: {},          // R28: тайм-аут по монете после стопа ИИ: sym → до какого времени НЕ входить (тихий час 4ч)
    aiLastEntryTs: 0,   // R28: когда автопилот ПОСЛЕДНИЙ раз открывал сделку (для снятия «заморозки» порога при простое)
    aiRelaxAt: 0,       // R28: когда порог входа последний раз снижался из-за простоя (не чаще раза в 4 часа)
    clearedU: [],       // «могилки» очищенной истории пользователя (id удалённых закрытых сделок) — чтобы облако не воскресило их
    clearedL: [],       // «могилки» очищенной истории лаборатории
    pushSubs: [],       // R30: push-подписки устройств (Web Push) — Страж шлёт по ним пуши о сделках
    ntfy: { on: false, topic: "", last: null }, // R50: резервный канал ntfy (не зависит от Chrome/SW)
    sync: { code: null, enabled: false, lastPush: 0, lastPull: 0, lastError: null, lastSeenRev: 0, sawRemote: false }, // синхронизация устройств
    host: null,         // R31 «серверный аккаунт»: кто сейчас исполнитель автоторговли { id, tag, until } (аренда уезжает в облако)
  };

  // ------- память ИИ (обучение на результатах сделок) -------
  function defaultBrain() {
    return {
      v: 1,
      weights: null,       // null → базовые Engine.AI_BASE_WEIGHTS; далее — адаптивные
      rel: {},             // надёжность фактора (множитель веса) 0.55..1.5, старт 1
      symStats: {},        // sym → { n, wins, streak, avgPct, long:{…}, short:{…} } — опыт по монетам (R52: + направления)
      confThreshold: 74,   // динамический порог входа автопилота (калибруется результатами; база 74 — запрос пользователя: всё выше 74% открывается само)
      trades: 0, wins: 0, losses: 0,
      longTrades: 0, longWins: 0, // R52: лонг-опыт отдельно (валюта решений реального рынка)
      lessons: [],         // что ИИ вынес из сделок (лента выводов)
      wFlags: {},          // защита уроков от повторов
      updatedAt: 0,
    };
  }
  state.aiBrain = defaultBrain();

  // ------- ГЛОБАЛЬНАЯ ПАМЯТЬ ИИ: одна на всех пользователей и все режимы -------
  // Мозг живёт НЕ в аккаунте, а в общем хранилище устройства + синхронизируется с
  // бесплатным анонимным облаком (textdb.online, без регистрации и ключей). Итог:
  // один ИИ учится на каждой закрытой сделке каждого пользователя (David, Yura и все
  // будущие) — что в демо, что в реальном режиме (общий анализ), память переживает
  // перезагрузку, смену аккаунта и работает между устройствами.
  const GLOBAL_BRAIN_KEY = "xenoai_global_brain_v1";
  const BRAIN_CLOUD_KEY = "xenoai-global-brain-a7x42";
  const BRAIN_READ_URL = "https://textdb.online/" + BRAIN_CLOUD_KEY;

  function normalizeBrain(b) {
    const base = defaultBrain();
    if (!b || typeof b !== "object" || b.v !== 1) return base;
    const br = { ...base, ...b, v: 1 };
    if (!br.rel || typeof br.rel !== "object") br.rel = {};
    if (!Array.isArray(br.lessons)) br.lessons = [];
    if (!br.symStats || typeof br.symStats !== "object") br.symStats = {};
    if (!br.wFlags || typeof br.wFlags !== "object") br.wFlags = {};
    if (!Number.isFinite(br.trades) || br.trades < 0) { br.trades = 0; br.wins = 0; br.losses = 0; }
    if (!Number.isFinite(br.wins) || br.wins < 0) br.wins = 0;
    if (!Number.isFinite(br.losses) || br.losses < 0) br.losses = 0;
    if (!Number.isFinite(br.confThreshold)) br.confThreshold = 74;
    // R52: лонг-счётчики (опыт именно по лонгам — применяются на реальном рынке)
    if (!Number.isFinite(br.longTrades) || br.longTrades < 0) { br.longTrades = 0; br.longWins = 0; }
    if (!Number.isFinite(br.longWins) || br.longWins < 0) br.longWins = 0;
    if (br.longWins > br.longTrades) br.longWins = br.longTrades;
    // R29: диапазон 70..80 (было 70..84). Потолок 80: истории серии минусов (кейс R29:
    // 12 стопов за вечер) калибровка задирала порог до 84 — уверенность ансамбля выше
    // 84 почти недостижима, и автопилот замерал («открывает очень редко»). 80 остаётся
    // строгим, но проходимым; старые значения 81–84 мягко сжимаются сюда при загрузке.
    br.confThreshold = Math.max(70, Math.min(80, Math.round(br.confThreshold)));
    return br;
  }

  function loadGlobalBrain() {
    try {
      const raw = localStorage.getItem(GLOBAL_BRAIN_KEY);
      if (raw) return normalizeBrain(JSON.parse(raw));
    } catch (e) { /* noop */ }
    return null;
  }

  // слияние двух мозгов (миграция старой локальной памяти, приход из облака):
  // «умнее» тот, кто изучил больше сделок; недостающий опыт другого подтягиваем
  function mergeBrains(a, b) {
    if (!a || !a.trades) a = null;
    if (!b || !b.trades) b = null;
    if (!a && !b) return null;
    if (!a) return normalizeBrain(b);
    if (!b) return normalizeBrain(a);
    const main = normalizeBrain(b.trades > a.trades ? b : a);
    const other = b.trades > a.trades ? a : b;
    for (const k in other.rel || {}) if (main.rel[k] == null) main.rel[k] = other.rel[k];
    for (const sym in other.symStats || {}) {
      const o = other.symStats[sym], m = main.symStats[sym];
      if (o && (!m || o.n > m.n)) main.symStats[sym] = o;
      // R52: под-статистики по направлениям подтягиваем недостающим (max по n)
      else if (o && m) {
        for (const sk of ["long", "short"]) {
          const os = o[sk], ms = m[sk];
          if (os && (!ms || os.n > ms.n)) m[sk] = os;
        }
      }
    }
    if ((other.longTrades || 0) > (main.longTrades || 0)) { main.longTrades = other.longTrades; main.longWins = other.longWins; } // R52
    const seen = new Set((main.lessons || []).map((l) => l.text));
    (other.lessons || []).forEach((l) => { if (l && l.text && !seen.has(l.text)) main.lessons.push(l); });
    main.lessons = main.lessons.sort((x, y) => (y.ts || 0) - (x.ts || 0)).slice(0, 24);
    for (const k in other.wFlags || {}) if (!main.wFlags[k]) main.wFlags[k] = other.wFlags[k];
    if (!main.weights && other.weights) main.weights = other.weights;
    main.updatedAt = Math.max(main.updatedAt || 0, other.updatedAt || 0);
    return main;
  }

  // --- облачная синхронизация памяти (textdb.online: бесплатно, анонимно, CORS ок) ---
  const brainSync = { busy: false, pending: false, lastOkAt: 0, lastPushAt: 0, mode: "подключение…" };
  function fetchT(url, ms, opts) {
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const t = ctl ? setTimeout(() => ctl.abort(), ms || 7000) : null;
    const p = fetch(url, ctl ? Object.assign({}, opts || {}, { signal: ctl.signal }) : (opts || {}));
    return p.then((r) => { if (t) clearTimeout(t); return r; }, (e) => { if (t) clearTimeout(t); throw e; });
  }
  // дневной бюджет записей в облако: textdb.online ограничивает 500 записей/сутки с одного
  // IP (чтения не ограничены). Мозг ИИ и архив аккаунта делят общий счётчик; при исчерпании
  // запись откладывается до завтра, локальная работа и чтения продолжаются как обычно.
  let budgetCache = null;
  function budgetTake() {
    const day = new Date().toISOString().slice(0, 10);
    if (!budgetCache || budgetCache.day !== day) {
      budgetCache = { day, n: 0 };
      try {
        const raw = JSON.parse(localStorage.getItem(dataKey() + "__budget") || "null");
        if (raw && raw.day === day && Number.isFinite(raw.n)) budgetCache.n = raw.n;
      } catch (e) { /* noop */ }
    }
    if (budgetCache.n >= 400) return false;
    budgetCache.n++;
    try { localStorage.setItem(dataKey() + "__budget", JSON.stringify(budgetCache)); } catch (e) { /* noop */ }
    return true;
  }
  function saveGlobalBrainLocal() {
    try { localStorage.setItem(GLOBAL_BRAIN_KEY, JSON.stringify(state.aiBrain)); } catch (e) { /* noop */ }
  }
  function brainPush() {
    if (!state.started) return; // не пушим до старта платформы (и из тестов)
    if (brainSync.busy) { brainSync.pending = true; return; }
    if (!budgetTake()) return; // дневной лимит облака: мозг уже на устройстве, уедет при следующем окне
    brainSync.busy = true;
    // ЗАЩИТА ОТ ЗАТИРАНИЯ (R29): перед записью сверяемся с облаком. Если там мозг
    // опытнее (пока у нас не было сети, другой пользователь/Страж обучил общий мозг
    // на своих сделках), сначала вливаем его в локальный — глобальная память никогда
    // не откатывается назад, даже при сбое сетевого чтения на старте.
    fetchT(BRAIN_READ_URL, 7000)
      .then((r) => r.text())
      .then((txt) => {
        txt = (txt || "").trim();
        if (txt) {
          try {
            const remote = normalizeBrain(JSON.parse(txt));
            if (remote.trades > (state.aiBrain.trades || 0)) {
              state.aiBrain = mergeBrains(state.aiBrain, remote) || state.aiBrain;
              saveGlobalBrainLocal();
            }
          } catch (e) { /* пусто или битый ответ — пишем то, что есть */ }
        }
      })
      .catch(() => { /* облако не ответило на чтение — запись всё равно пробуем */ })
      .then(() => {
        // POST вместо GET: мозг с большим symStats не влезает в URL, а POST /update держит 200 000 символов
        const body = "key=" + encodeURIComponent(BRAIN_CLOUD_KEY) + "&value=" + encodeURIComponent(JSON.stringify(state.aiBrain));
        return fetchT(SYNC_UPDATE_URL, 9000, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body })
          .then((r) => { if (!r.ok) throw new Error("push " + r.status); return r.json().catch(() => ({})); })
          .then((j) => { if (j && j.status === 0) throw new Error("облако отклонило запись"); brainSync.lastOkAt = Date.now(); brainSync.lastPushAt = Date.now(); brainSync.mode = "облако"; })
          .catch(() => { brainSync.mode = brainSync.lastOkAt ? "облако" : "локально (нет сети)"; });
      })
      .then(() => { brainSync.busy = false; if (brainSync.pending) { brainSync.pending = false; setTimeout(brainPush, 2000); } })
      .catch(() => { brainSync.busy = false; });
  }
  let brainPushTimer = null;
  function scheduleBrainPush() {
    if (brainPushTimer || typeof setTimeout !== "function") return; // typeof — для vm-тестов
    brainPushTimer = setTimeout(() => { brainPushTimer = null; brainPush(); }, 4000);
  }
  function brainPull() {
    if (brainSync.busy) return;
    brainSync.busy = true;
    fetchT(BRAIN_READ_URL, 7000)
      .then((r) => { if (!r.ok) throw new Error("pull " + r.status); return r.text(); })
      .then((txt) => {
        txt = (txt || "").trim();
        if (txt) {
          const remote = normalizeBrain(JSON.parse(txt));
          const ahead = remote.trades > state.aiBrain.trades
            || (remote.trades === state.aiBrain.trades && remote.updatedAt > state.aiBrain.updatedAt);
          if (ahead) {
            state.aiBrain = mergeBrains(state.aiBrain, remote) || state.aiBrain;
            saveGlobalBrainLocal();
            emit();
          }
        }
        brainSync.lastOkAt = Date.now(); brainSync.mode = "облако";
      })
      .catch(() => { brainSync.mode = brainSync.lastOkAt ? "облако" : "локально (нет сети)"; })
      .then(() => { brainSync.busy = false; });
  }
  function brainSyncInfo() {
    return { mode: brainSync.mode, lastOkAt: brainSync.lastOkAt, lastPushAt: brainSync.lastPushAt, trades: state.aiBrain.trades };
  }
  let brainSyncInited = false;
  function initBrainSync() {
    if (brainSyncInited) return;
    brainSyncInited = true;
    brainPull();          // подтянуть память, накопленную другими устройствами/пользователями
    scheduleBrainPush();  // и отдать свою (обе стороны сходятся по числу изученных сделок)
    if (typeof setInterval === "function") setInterval(() => { if (state.started) brainPull(); }, 120000); // опрос каждые 2 мин
  }

  WATCH_SYMS.forEach((sym, i) => {
    const p = DEFAULT_PRICES[sym] != null ? DEFAULT_PRICES[sym] : 1;
    state.prices[sym] = { sym, price: p, prev: p, chg24h: 0, high24: p * 1.01, low24: p * 0.99, vol24: 0, open24: p, spark: seedSpark(p, i), ts: 0 };
  });

  // свежесть цены: монеты, которых нет на текущем источнике, докачиваются индивидуально
  // (у бирж разные листинги: ZEC нет на Bybit, GRASS/MNT нет на Binance)
  const PRICE_STALE_MS = 30000;
  function isPriceFresh(sym) {
    const p = state.prices[sym];
    return Boolean(p && p.ts && Date.now() - p.ts <= PRICE_STALE_MS);
  }

  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function emit() { listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } }); }

  // быстрые слушатели (тик цены без перерисовки): живой PnL, сайдбар
  const fastTickListeners = new Set();
  function onFastTick(fn) { fastTickListeners.add(fn); return () => fastTickListeners.delete(fn); }

  // ---------- персистентность ----------
  // Версия v3: хранилище аккаунта. Каждая запись дублируется в «зеркальный» ключ:
  // если основная копия повреждена (сбой диска, квота, приватный режим) — аккаунт
  // восстанавливается из зеркала. Данные НИКОГДА не обнуляются сами по себе:
  // при невозможности распарсить обе копии хранилище остаётся нетронутым, а сбой
  // попадает в журнал самодиагностики.
  const STORAGE_VER = "xenoai_v3";
  // Сделки может открывать только администратор David или Yura.
  const TRADE_ACCOUNTS = ["david", "yura"];
  let persistTimer = null;
  function dataKey() {
    const login = Auth.sessionLogin();
    return login ? `${STORAGE_VER}_${login.toLowerCase()}` : `${STORAGE_VER}_anon`;
  }
  function backupKey(key) { return key + "__bak"; }

  function writeRawSafe(key, val) {
    // зеркальная запись: сначала основная копия, потом зеркало
    try { localStorage.setItem(key, val); } catch (e) {
      // квота/приватный режим: пробуем хотя бы зеркало
      try { localStorage.setItem(backupKey(key), val); } catch (e2) { diagError("запись хранилища", e); return false; }
      diagError("запись хранилища (основная копия)", e);
      return false;
    }
    try { localStorage.setItem(backupKey(key), val); } catch (e) { /* зеркало не критично */ }
    return true;
  }

  function readRawSafe(key) {
    let raw = null, primaryBad = false, hadData = false;
    try { raw = localStorage.getItem(key); } catch (e) { primaryBad = true; }
    if (raw != null && raw.length) {
      hadData = true;
      try { JSON.parse(raw); return { raw, fromBackup: false }; } catch (e) { primaryBad = true; }
    }
    // основная копия пуста/побита — пробуем зеркало
    try {
      const bak = localStorage.getItem(backupKey(key));
      if (bak) {
        hadData = true;
        JSON.parse(bak);
        if (primaryBad) {
          try { localStorage.setItem(key, bak); } catch (e2) { /* восстановить основную не вышло — не критично */ }
        }
        return { raw: bak, fromBackup: primaryBad };
      }
    } catch (e) { /* зеркало тоже побит */ }
    // broken только если данные БЫЛИ и обе копии нечитаемы; пустое хранилище — норма (новый аккаунт)
    return { raw: primaryBad ? null : raw, fromBackup: false, broken: hadData };
  }

  function wipeOldStorages() {
    // одноразовая уборка демо-данных прошлой версии (xenoai_v2_*) — полный сброс сделок и статистик
    try {
      const kill = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.indexOf("xenoai_v2_") === 0 || k.indexOf("xenoai_v1_") === 0)) kill.push(k);
      }
      kill.forEach((k) => localStorage.removeItem(k));
    } catch (e) { /* noop */ }
  }

  // снимок аккаунта: единый формат для localStorage, облака синка и файлового бэкапа
  function archiveAccount() {
    const s = state;
    return {
      v: 3, rev: s.rev || 0, updatedAt: s.updatedAt || Date.now(),
      balance: s.balance, startBalance: s.startBalance,
      userPositions: s.userPositions, userClosed: s.userClosed.slice(0, 400),
      labAccounts: s.labAccounts, labPositions: s.labPositions, labClosed: s.labClosed.slice(0, 400),
      events: s.events.slice(0, 80), autoTrade: s.autoTrade, labAutoMigrated: true, equityHist: s.equityHist.slice(-300),
      mode: s.mode, aiAuto: s.aiAuto, aiAutoLive: s.aiAutoLive, liveOrders: s.liveOrders.slice(0, 50),
      liveStats: s.liveStats && typeof s.liveStats === "object" ? { ...s.liveStats } : { n: 0, wins: 0, losses: 0, pnlUsdt: 0, since: 0 }, // R49
      glmVerdict: s.glmSrv && typeof s.glmSrv === "object" ? { ...s.glmSrv } : null, // R49: вердикт (без ключа)
      okx: s.okx && typeof s.okx === "object" ? { on: !!s.okx.on, auto: s.okx.auto !== false, mask: String(s.okx.mask || ""), balanceUSDT: s.okx.balanceUSDT, balanceEq: s.okx.balanceEq, ts: s.okx.ts || 0, lastSync: s.okx.lastSync || 0, lastErr: String(s.okx.lastErr || "").slice(0, 160) } : null, // R51: публичное состояние (секретов нет — они только на сервере)
      aiSession: s.aiSession, aiStop: s.aiStop, aiThreshold: s.aiThreshold, aiMaxPos: s.aiMaxPos,
      failPct: s.failPct, // провальный порог едет в облако: Страж закрывает по тем же правилам
      maxDeal: s.maxDeal, maxTotal: s.maxTotal, aiPosMode: s.aiPosMode,
      lastCatchUp: s.lastCatchUp, lastScanAt: s.lastScanAt,
      aiCooldownUntil: s.aiCooldownUntil || 0, aiCooldownSeen: s.aiCooldownSeen || 0,
      aiBan: s.aiBan && typeof s.aiBan === "object" ? s.aiBan : {},
      aiLastEntryTs: s.aiLastEntryTs || 0, aiRelaxAt: s.aiRelaxAt || 0,
      clearedU: (s.clearedU || []).slice(-800), clearedL: (s.clearedL || []).slice(-800),
      // R30: push-подписки устройств (Web Push) — по ним Страж шлёт пуши о сделках
      pushSubs: (s.pushSubs || []).slice(0, 8),
      // R50: резервный канал ntfy — конфиг едет с архивом (сервер авторитарен)
      ntfy: s.ntfy && typeof s.ntfy === "object" ? { on: !!s.ntfy.on, topic: String(s.ntfy.topic || ""), last: s.ntfy.last || null } : { on: false, topic: "", last: null },
      // R31: аренда исполнителя автоторговли — часть серверного состояния аккаунта
      host: s.host && s.host.id ? { id: s.host.id, tag: s.host.tag || "", until: s.host.until || 0 } : null,
      // идеи сканера сохраняются: после перезапуска вкладки «Сигналы» сразу полные,
      // а не ждут 45с, пока сканер обойдёт все монеты заново
      aiIdeas: s.aiIdeas.slice(0, 8).map((i) => ({
        sym: i.sym, guard: i.guard, ts: i.ts,
        res: i.res ? {
          sym: i.res.sym, ts: i.res.ts, verdict: i.res.verdict, confidence: i.res.confidence,
          price: i.res.price, stop: i.res.stop, target: i.res.target,
          riskPct: i.res.riskPct, targetPct: i.res.targetPct, atrPct: i.res.atrPct,
          flashRatio: i.res.flashRatio, score: i.res.score, agreeShare: i.res.agreeShare,
          note: i.res.note, factors: i.res.factors || [],
        } : null,
      })),
      // aiBrain здесь нет: память ИИ глобальная (GLOBAL_BRAIN_KEY + облако), одна на всех
      // R43: теневая торговля — журнал отказов и статистика едут с архивом; R44: + история подстроек порога
      // R45: + trust/skip — доверие по монетам из исходов отказов и пропуски скана
      shadow: s.shadow && Array.isArray(s.shadow.list) ? { list: s.shadow.list.slice(0, 60), stats: s.shadow.stats || {}, tune: Array.isArray(s.shadow.tune) ? s.shadow.tune.slice(0, 10) : [], trust: s.shadow.trust && typeof s.shadow.trust === "object" ? s.shadow.trust : {}, skip: s.shadow.skip && typeof s.shadow.skip === "object" ? s.shadow.skip : {} } : { list: [], stats: {}, tune: [], trust: {}, skip: {} },
    };
  }

  // R31: ЧАСЫ ИЗМЕНЕНИЯ ДВИГАЮТСЯ ТОЛЬКО РЕАЛЬНЫМИ ИЗМЕНЕНИЯМИ. Раньше updatedAt
  // ставило время КАЖДОЕ сохранение — включая фоновый персист эквити раз в 30 секунд.
  // Открытая вкладка всегда считала себя «самой свежей» и перетирала облако без
  // слияния (главная причина расхождения ПК/телефон). Теперь: если отпечаток
  // содержимого (fpOf) не изменился — это фоновая запись, часы не трогаем.
  let lastPersistFp = null;
  function persistNow() {
    if (!Auth.sessionLogin()) return;
    persistTimer = null;
    const data = archiveAccount();
    const fp = fpOf(data);
    state.rev = (state.rev || 0) + 1; // каждая запись — новая ревизия (слияние синка)
    if (fp !== lastPersistFp) state.updatedAt = Date.now(); // только содержательные изменения двигают часы
    lastPersistFp = fp;
    data.rev = state.rev;
    writeRawSafe(dataKey(), JSON.stringify(data));
    scheduleSyncPush(); // облачная синхронизация устройств (если включена)
  }
  function persist() {
    if (!Auth.sessionLogin()) return;
    if (persistTimer) return;
    persistTimer = setTimeout(persistNow, 400);
  }
  // применение снимка аккаунта к состоянию (общее для hydrate, облачного синка и файлового бэкапа)
  function applyArchive(d) {
    if (typeof d.balance === "number") state.balance = d.balance;
    if (typeof d.startBalance === "number") state.startBalance = d.startBalance;
    if (Array.isArray(d.userPositions)) state.userPositions = d.userPositions;
    if (Array.isArray(d.userClosed)) state.userClosed = d.userClosed;
    if (Array.isArray(d.labAccounts) && d.labAccounts.length === Engine.STRATEGIES.length) state.labAccounts = d.labAccounts;
    if (Array.isArray(d.labPositions)) state.labPositions = d.labPositions;
    if (Array.isArray(d.labClosed)) state.labClosed = d.labClosed;
    if (Array.isArray(d.events)) state.events = d.events;
    if (Array.isArray(d.equityHist)) state.equityHist = d.equityHist;
    // автоторговля лаборатории: для старых аккаунтов (без метки миграции) одноразово
    // включаем — сигналы принимаются сами (запрос пользователя); после миграции
    // уважаем то, что выставлено тумблером в «Счетах»
    if (typeof d.autoTrade === "boolean") state.autoTrade = d.labAutoMigrated ? d.autoTrade : true;
    state.labAutoMigrated = true;
    if (d.mode === "demo" || d.mode === "live") state.mode = d.mode;
    if (typeof d.aiAuto === "boolean") state.aiAuto = d.aiAuto;
    if (typeof d.aiAutoLive === "boolean") state.aiAutoLive = d.aiAutoLive;
    if (Array.isArray(d.liveOrders)) state.liveOrders = d.liveOrders;
    // R49: реальные сделки (статистика обучения) и вердикт GLM-аналитика сервера
    if (d.liveStats && typeof d.liveStats === "object") {
      const ls = state.liveStats = state.liveStats || { n: 0, wins: 0, losses: 0, pnlUsdt: 0, since: 0 };
      for (const k of ["n", "wins", "losses", "pnlUsdt"]) { const v = Number(d.liveStats[k]); if (Number.isFinite(v) && v >= 0) ls[k] = v; }
      if (Number(d.liveStats.since) > 0) ls.since = Number(d.liveStats.since);
    }
    if (d.glmVerdict && typeof d.glmVerdict === "object") {
      const v = d.glmVerdict;
      state.glmSrv = {
        bias: v.bias === "лонг" || v.bias === "шорт" || v.bias === "flat" ? v.bias : "flat",
        confidence: Math.max(0, Math.min(100, Math.round(Number(v.confidence) || 0))),
        reasoning: String(v.reasoning || "").slice(0, 240),
        ts: Number(v.ts) || 0, model: String(v.model || "").slice(0, 40),
        status: v.status === "ok" || v.status === "error" ? v.status : "error",
        error: String(v.error || "").slice(0, 160),
      };
    }
    // R51: публичное состояние синхронизации OKX (маска/баланс; ключи остаются на сервере)
    if (d.okx && typeof d.okx === "object") {
      state.okx = {
        on: d.okx.on === true,
        auto: d.okx.auto !== false,
        mask: String(d.okx.mask || "").slice(0, 16),
        balanceUSDT: Number.isFinite(Number(d.okx.balanceUSDT)) ? Number(d.okx.balanceUSDT) : null,
        balanceEq: Number.isFinite(Number(d.okx.balanceEq)) ? Number(d.okx.balanceEq) : null,
        ts: Number(d.okx.ts) || 0,
        lastSync: Number(d.okx.lastSync) || 0,
        lastErr: String(d.okx.lastErr || "").slice(0, 160),
      };
    }
    if (d.aiSession && typeof d.aiSession.startEquity === "number") state.aiSession = d.aiSession;
    if (d.aiStop && (d.aiStop.reason === "profit" || d.aiStop.reason === "loss")) state.aiStop = d.aiStop;
    if (typeof d.aiThreshold === "number" && d.aiThreshold >= 5 && d.aiThreshold <= 500) state.aiThreshold = d.aiThreshold;
    if (typeof d.failPct === "number" && d.failPct >= 0 && d.failPct <= 200) state.failPct = d.failPct;
    if (typeof d.aiMaxPos === "number" && d.aiMaxPos >= 1 && d.aiMaxPos <= 8) state.aiMaxPos = d.aiMaxPos;
    if (typeof d.maxDeal === "number" && d.maxDeal >= 5 && d.maxDeal <= 100000) state.maxDeal = d.maxDeal;
    if (typeof d.maxTotal === "number" && d.maxTotal >= 5 && d.maxTotal <= 1000000) state.maxTotal = d.maxTotal;
    if (d.aiPosMode === "auto" || (typeof d.aiPosMode === "number" && d.aiPosMode >= 1 && d.aiPosMode <= 8)) state.aiPosMode = d.aiPosMode;
    if (typeof d.lastCatchUp === "number" && d.lastCatchUp > 0) state.lastCatchUp = d.lastCatchUp;
    if (typeof d.lastScanAt === "number" && d.lastScanAt > 0) state.lastScanAt = d.lastScanAt;
    // пауза автопилота после серии минусов: персистентна, чтобы перезагрузка страницы
    // не обнуляла её и не ставила заново (пауза честно отработана — серия зафиксирована)
    if (typeof d.aiCooldownUntil === "number" && d.aiCooldownUntil > 0) state.aiCooldownUntil = d.aiCooldownUntil;
    if (typeof d.aiCooldownSeen === "number" && d.aiCooldownSeen > 0) state.aiCooldownSeen = d.aiCooldownSeen;
    // R28: тайм-ауты по монетам после стопов и метки простоя автопилота — тоже персистентны
    if (d.aiBan && typeof d.aiBan === "object") {
      const clean = {};
      for (const k of Object.keys(d.aiBan)) if (typeof d.aiBan[k] === "number" && d.aiBan[k] > Date.now()) clean[k] = d.aiBan[k];
      state.aiBan = { ...state.aiBan, ...clean }; // просроченные не resurrect — тихий час честно истекает
    }
    if (typeof d.aiLastEntryTs === "number" && d.aiLastEntryTs > (state.aiLastEntryTs || 0)) state.aiLastEntryTs = d.aiLastEntryTs;
    if (typeof d.aiRelaxAt === "number" && d.aiRelaxAt > 0) state.aiRelaxAt = d.aiRelaxAt;
    // могилки очищенной истории: удалённое не имеет права воскреснуть из старого архива
    if (Array.isArray(d.clearedU)) state.clearedU = d.clearedU.slice(-800);
    if (Array.isArray(d.clearedL)) state.clearedL = d.clearedL.slice(-800);
    // R30: push-подписки из облака/бэкапа (union уже сделан в mergeArchives; здесь — валидация)
    if (Array.isArray(d.pushSubs)) {
      state.pushSubs = d.pushSubs
        .filter((s) => s && typeof s.endpoint === "string" && s.endpoint.indexOf("https://") === 0 && s.keys && s.keys.p256dh && s.keys.auth)
        .slice(0, 8);
    }
    // R50: резервный канал ntfy — валидация структуры (тема 6–64, латиница/цифры/-/_)
    if (d.ntfy && typeof d.ntfy === "object") {
      state.ntfy = {
        on: d.ntfy.on === true && /^[a-zA-Z0-9_-]{6,64}$/.test(String(d.ntfy.topic || "")),
        topic: /^[a-zA-Z0-9_-]{6,64}$/.test(String(d.ntfy.topic || "")) ? String(d.ntfy.topic) : "",
        last: d.ntfy.last && typeof d.ntfy.last === "object" ? { ts: Number(d.ntfy.last.ts) || 0, status: Number(d.ntfy.last.status) || 0, ok: Boolean(d.ntfy.last.ok) } : null,
      };
    }
    // R31: аренда исполнителя автоторговли (кто сейчас ведёт входы/флипы — видно в Кабинете)
    if (d.host === null) state.host = null;
    else if (d.host && typeof d.host === "object" && typeof d.host.id === "string" && d.host.id && typeof d.host.until === "number") {
      state.host = { id: d.host.id, tag: typeof d.host.tag === "string" ? d.host.tag.slice(0, 40) : "", until: d.host.until };
    }
    if (state.clearedU.length) {
      const tomb = new Set(state.clearedU);
      state.userClosed = (state.userClosed || []).filter((c) => !tomb.has(c.id));
    }
    if (state.clearedL.length) {
      const tombL = new Set(state.clearedL);
      state.labClosed = (state.labClosed || []).filter((c) => !tombL.has(c.id));
    }
    // восстановление идей сканера: проверяем структуру, чтобы чужой/битый архив не сломал рендер
    if (Array.isArray(d.aiIdeas)) {
      state.aiIdeas = d.aiIdeas.filter((i) => i && i.sym && i.res && typeof i.res.verdict === "string" && typeof i.res.confidence === "number")
        .slice(0, 8);
    }
    // R43: теневая торговля (журнал отказов ИИ) — с валидацией структуры; R44: + tune
    if (d.shadow && Array.isArray(d.shadow.list)) {
      state.shadow = {
        list: d.shadow.list.filter((e) => e && typeof e.id === "string" && e.sym && (e.side === "лонг" || e.side === "шорт") && typeof e.price === "number").slice(0, 60),
        stats: d.shadow.stats && typeof d.shadow.stats === "object" ? d.shadow.stats : {},
        tune: Array.isArray(d.shadow.tune) ? d.shadow.tune.filter((t) => t && typeof t.ts === "number" && Number.isFinite(Number(t.from)) && Number.isFinite(Number(t.to))).slice(0, 10) : [],
        // R45: доверие по монетам + пропуски скана (сервер считает, клиент хранит/показывает)
        trust: d.shadow.trust && typeof d.shadow.trust === "object" && !Array.isArray(d.shadow.trust) ? d.shadow.trust : {},
        skip: d.shadow.skip && typeof d.shadow.skip === "object" && !Array.isArray(d.shadow.skip) ? d.shadow.skip : {},
      };
    }
    if (typeof d.rev === "number" && d.rev > (state.rev || 0)) state.rev = d.rev;
    // время последнего изменения берём из архива (настенные часы для слияния устройств):
    // устройство, не заходившее 3 дня, должно остаться «старым», а не казаться свежим
    if (typeof d.updatedAt === "number" && d.updatedAt > (state.updatedAt || 0)) state.updatedAt = d.updatedAt;
    // в реальном режиме после перезагрузки страницы соединение надо перепроверить
    if (state.mode === "live" && !(window.Live && Live.isConnected())) state.mode = "demo";
  }

  function hydrate() {
    wipeOldStorages();
    // ГЛОБАЛЬНЫЙ мозг: единая память всех пользователей — не зависит от аккаунта
    state.aiBrain = loadGlobalBrain() || defaultBrain();
    const res = readRawSafe(dataKey());
    if (res.broken) {
      // обе копии повреждены: НЕ трогаем хранилище и не обнуляем счёт —
      // работаем в памяти, чтобы пользователь мог выгрузить бэкап/синк
      diagError("хранилище аккаунта", "обе копии повреждены — работаем в памяти до восстановления");
      initBrainSync();
      return;
    }
    if (!res.raw) { welcomeIfFresh(); initBrainSync(); return; }
    try {
      const d = JSON.parse(res.raw);
      applyArchive(d);
      // старая локальная память ИИ (до глобальной) — одноразовая миграция в общий мозг
      if (d.aiBrain && typeof d.aiBrain === "object") {
        const legacy = normalizeBrain(d.aiBrain);
        if (legacy.trades > state.aiBrain.trades) {
          state.aiBrain = mergeBrains(state.aiBrain, legacy) || state.aiBrain;
          saveGlobalBrainLocal();
        }
      }
      if (res.fromBackup) {
        pushEvent({ tone: "neutral", title: "Хранилище восстановлено из резервной копии", detail: "основная копия была повреждена — аккаунт поднят с зеркала, все сделки и история целы" });
      }
    } catch (e) { diagError("чтение хранилища", e); }
    restorePriceSnapshot(); // R30: цены прошлого сеанса — до первого ответа источников
    loadDeviceId(); // R31: идентичность устройства для аренды исполнителя
    lastPersistFp = fpOf(archiveAccount()); // фоновый персист после загрузки не должен двигать часы
    // R32: СЕРВЕРНЫЙ РЕЖИМ — подтянуть состояние сервера и включить опрос (12 с);
    // локальный архив одноразово предлагается серверу (union без потерь при первом входе)
    if (serverMode()) {
      try {
        Server.bootstrap(archiveAccount());
        Server.startPolling(() => { if (state.started && !document.hidden) Server.pull(applyServerArchive); });
      } catch (e) { /* сервер недоступен — остаёмся в локальном режиме */ }
      setTimeout(() => { if (window.Server && Server.active()) Server.pull(applyServerArchive); }, 800);
    }
    initSyncRuntime(); // синхронизация устройств: метаданные + опрос облака
    initBrainSync(); // тянет облако и запускает периодический опрос (один раз за загрузку страницы)
  }
  function switchUser() {
    const started = state.started;
    state.prices = {};
    WATCH_SYMS.forEach((sym, i) => {
      const p = DEFAULT_PRICES[sym] != null ? DEFAULT_PRICES[sym] : 1;
      state.prices[sym] = { sym, price: p, prev: p, chg24h: 0, high24: p * 1.01, low24: p * 0.99, vol24: 0, open24: p, spark: seedSpark(p, i), ts: 0 };
    });
    state.bars = {}; state.degraded = false; state.lastSync = 0;
    state.signals = []; state.labAccounts = Engine.mkLabAccounts();
    state.labPositions = []; state.labClosed = []; state.autoTrade = true; state.labAutoMigrated = false;
    state.events = []; state.whales = {}; state.whaleScannedAt = {};
    state.balance = 10000; state.startBalance = 10000;
    state.userPositions = []; state.userClosed = []; state.equityHist = [];
    state._ai = null;
    state.aiIdeas = []; state.liveOrders = [];
    state.liveStats = { n: 0, wins: 0, losses: 0, pnlUsdt: 0, since: 0 }; state.glmSrv = null; // R49
    state.okx = { on: false, auto: false, mask: "", balanceUSDT: null, balanceEq: null, ts: 0, lastSync: 0, lastErr: "" }; // R51
    state.aiBrain = defaultBrain(); state.aiSession = null; state.aiStop = null;
    state.aiThreshold = 50; // дефолт до загрузки персист-данных пользователя
    state.failPct = 50;
    state.aiMaxPos = 5;
    state.aiPosMode = "auto"; state.maxDeal = 1000; state.maxTotal = 5000;
    state.aiAutoLive = false; // в реальном режиме автопилот всегда стартует выключенным
    state.lastCatchUp = 0; state.rev = 0; state.updatedAt = 0;
    state.aiCooldownUntil = 0; state.aiCooldownSeen = 0;
    state.aiBan = {}; state.aiLastEntryTs = 0; state.aiRelaxAt = 0;
    state.clearedU = []; state.clearedL = [];
    state.host = null; // R31: аренда исполнителя не переходит между аккаунтами
    lastPersistFp = null;
    state.sync = { code: null, enabled: false, lastPush: 0, lastPull: 0, lastError: null, lastSeenRev: 0, sawRemote: false };
    // sync-рантайм перезапускается для нового пользователя: метаданные читаются заново,
    // авто-включение синка срабатывает для его аккаунта (initSyncRuntime — одноразовый)
    if (typeof syncCtl !== "undefined" && syncCtl.pollTimer) { try { clearInterval(syncCtl.pollTimer); } catch (e) { /* noop */ } syncCtl.pollTimer = null; }
    if (typeof syncCtl !== "undefined") { syncCtl.inited = false; syncCtl.busy = false; syncCtl.pending = false; }
    state.started = started; state.activeSym = "BTC";
    hydrate();
    initSyncRuntime(); // после смены пользователя — метаданные и авто-включение синка его аккаунта
  }

  // сделки может открывать/закрывать только аккаунт David или Yura
  function canTrade() {
    const login = Auth.sessionLogin();
    return Boolean(login && TRADE_ACCOUNTS.indexOf(login.toLowerCase()) !== -1);
  }

  // ================= СИНХРОНИЗАЦИЯ МЕЖДУ УСТРОЙСТВАМИ =================
  // Полный архив аккаунта (баланс, открытые позиции, ВСЯ история сделок, лаборатория,
  // события, эквити, настройки) уезжает в бесплатное анонимное облако textdb.online
  // под персональным кодом синхронизации. На другом устройстве достаточно войти в тот
  // же аккаунт и ввести этот код в Кабинете — данные подтянутся и будут поддерживаться
  // актуальными автоматически (пул каждые 2 минуты + пуш после каждого изменения).
  // Слияние умное: история сделок и события ОБЪЕДИНЯЮТСЯ (ничего не теряется, даже
  // если устройства торговали параллельно в офлайне), а «опережающая» ревизия
  // определяет баланс и открытые позиции.
  const SYNC_BASE = "https://textdb.online/";
  // ЗАПИСЬ — только POST на /update (без слэша): value до 200 000 символов в теле запроса.
  // Предыдущий вариант писал GET-запросом (?key=..&value=..) и МОЛЧА умирал на ~16 КБ:
  // архив аккаунта с историей (сотни КБ) не помещался в URL, сервер отвечал HTTP 414,
  // пуш не доезжал — и второе устройство вечно видело пустоту (кейс: телефон 7 сделок,
  // ПК 0). Чтение — как раньше: GET https://textdb.online/{key}, всегда HTTP 200,
  // CORS открыты на обе операции.
  const SYNC_UPDATE_URL = "https://textdb.online/update";
  const syncCtl = { busy: false, pending: false, pushTimer: null, pollTimer: null, inited: false, lastPushedFp: null };

  function syncKey() { return "xenoai-sync-" + (state.sync && state.sync.code ? String(state.sync.code).trim() : ""); }
  function genSyncCode() {
    const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let out = "";
    try {
      const arr = new Uint8Array(16);
      (window.crypto || {}).getRandomValues ? crypto.getRandomValues(arr) : arr.forEach((_, i) => { arr[i] = Math.floor(Math.random() * 256); });
      for (let i = 0; i < 16; i++) out += abc[arr[i] % abc.length];
    } catch (e) {
      for (let i = 0; i < 16; i++) out += abc[Math.floor(Math.random() * abc.length)];
    }
    return out.slice(0, 4) + "-" + out.slice(4, 8) + "-" + out.slice(8, 12) + "-" + out.slice(12, 16);
  }
  function persistSyncMeta() {
    try { localStorage.setItem(dataKey() + "__sync", JSON.stringify(state.sync)); } catch (e) { /* noop */ }
  }
  function loadSyncMeta() {
    try {
      const raw = localStorage.getItem(dataKey() + "__sync");
      if (raw) {
        const d = JSON.parse(raw);
        if (d && typeof d === "object") state.sync = Object.assign(state.sync, {
          code: typeof d.code === "string" ? d.code : null,
          enabled: true, // синхронизация ВСЕГДА включена: единый аккаунт = единые данные, без опций вкл/выкл
          lastPush: d.lastPush || 0, lastPull: d.lastPull || 0, lastSeenRev: d.lastSeenRev || 0,
          sawRemote: !!d.sawRemote,
        });
      }
    } catch (e) { /* noop */ }
  }

  // слияние двух архивов: закрытые сделки и события — объединение (union по id),
  // скаляры и открытые позиции — от архива, который менялся ПОСЛЕДНИМ по настенным
  // часам (updatedAt). Нельзя сравнивать rev: это ЛОКАЛЬНЫЙ счётчик записей — у давно
  // используемого ПК он в тысячи раз больше, чем у свежего телефона, и «старый» ПК
  // перетирал бы актуальные позиции телефона (классический рассинхрон устройств)
  // id исходной позиции из записи закрытия: новые записи несут pid, старые восстанавливаются
  // из суффикса id (u1234-c5678 → u1234; догон: u<ts>-<sym>-c<ts> → u<ts>-<sym>)
  function pidOfClosed(c) {
    return (c && c.pid) || String((c && c.id) || "").replace(/-c\d+$/, "");
  }

  // R30: слияние ОТКРЫТЫХ ПОЗИЦИЙ по каждой сделке (union по id), а не «всё или ничего».
  // Раньше список открытых позиций брался ЦЕЛИКОМ от устройства, которое менялось
  // последним: пока телефон просто лежал открытым (персист эквити каждые 30 секунд
  // двигал его updatedAt), он перетирал позиции ПК и наоборот — классический рассинхрон
  // «на ПК одни позиции, на смартфоне другие». Теперь позиция, открытая на любом
  // устройстве, переживает слияние; пропадает она только одним способом — закрытием
  // (запись закрытия того же pid есть в объединённой истории).
  function mergeOpenPositions(aPos, bPos, closedPids) {
    const byId = new Map();
    const put = (p) => {
      if (!p || !p.id) return;
      const cur = byId.get(p.id);
      if (!cur || ((p.mt || 0) > (cur.mt || 0))) byId.set(p.id, p); // свежая правка (трейлинг и т.п.) важнее
    };
    (aPos || []).forEach(put);
    (bPos || []).forEach(put);
    const out = [];
    for (const p of byId.values()) {
      if (closedPids.has(p.id)) continue; // позиция закрыта (на любом устройстве) — открытой быть не может
      out.push(p);
    }
    return out;
  }

  // объединение закрытых сделок по pid исходной позиции: двойное исполнение одного
  // закрытия (браузер и Страж догоняли один период параллельно) даёт две записи с одним
  // pid — зачёт результата проходит ОДИН раз (берём самое раннее закрытие = реальное)
  function mergeClosed(listA, listB, cap) {
    const byPid = new Map();
    const add = (c) => {
      if (!c || !c.id) return;
      const pid = pidOfClosed(c);
      if (!pid) return;
      const cur = byPid.get(pid);
      if (!cur || (c.closedAt || 0) < (cur.closedAt || 0)) byPid.set(pid, c);
    };
    (listA || []).forEach(add);
    (listB || []).forEach(add);
    return Array.from(byPid.values()).sort((x, y) => (y.closedAt || 0) - (x.closedAt || 0)).slice(0, cap);
  }

  // push-подписки устройств (Web Push): union по endpoint — подписка каждого устройства
  // живёт в облаке, и Страж шлёт пуши на ВСЕ устройства аккаунта
  function mergePushSubs(aSubs, bSubs) {
    const byEp = new Map();
    const add = (s) => {
      if (!s || !s.endpoint || !s.keys || !s.keys.p256dh || !s.keys.auth) return;
      const cur = byEp.get(s.endpoint);
      if (!cur || ((s.ts || 0) > (cur.ts || 0))) byEp.set(s.endpoint, s);
    };
    (aSubs || []).forEach(add);
    (bSubs || []).forEach(add);
    return Array.from(byEp.values()).sort((x, y) => (y.ts || 0) - (x.ts || 0)).slice(0, 8);
  }

  function mergeArchives(a, b) {
    if (!a || typeof a !== "object") return b;
    if (!b || typeof b !== "object") return a;
    const main = ((b.updatedAt || 0) > (a.updatedAt || 0)) ? b : a;
    const other = main === b ? a : b;
    const out = JSON.parse(JSON.stringify(main));

    // --- закрытые сделки: union по pid, двойные исполнения схлопываются ---
    out.userClosed = mergeClosed(a.userClosed, b.userClosed, 400);
    out.labClosed = mergeClosed(a.labClosed, b.labClosed, 400);

    // --- открытые позиции: union по id минус закрытые ---
    const closedPids = new Set(out.userClosed.map(pidOfClosed).filter(Boolean));
    out.userPositions = mergeOpenPositions(a.userPositions, b.userPositions, closedPids);
    const labClosedPids = new Set(out.labClosed.map(pidOfClosed).filter(Boolean));
    out.labPositions = mergeOpenPositions(a.labPositions, b.labPositions, labClosedPids);

    // --- баланс согласован с объединённым набором позиций ---
    // main.balance соответствует ИМЕННО позициям main. Правки:
    //  1) позиция есть только у other (открыта на другом устройстве) — резервируем её маржу;
    //  2) позиция была у main, но закрыта на other — зачисляем результат закрытия.
    let bal = main.balance;
    const mainOpenIds = new Set((main.userPositions || []).map((p) => p.id));
    const outOpenIds = new Set(out.userPositions.map((p) => p.id));
    for (const p of out.userPositions) {
      if (!mainOpenIds.has(p.id)) bal -= (p.size || 0); // чужая открытая позиция: маржа уходит в рынок
    }
    for (const p of main.userPositions || []) {
      if (outOpenIds.has(p.id)) continue;
      const c = out.userClosed.find((x) => pidOfClosed(x) === p.id);
      if (c) bal += (p.size || 0) + (c.pnl || 0); // закрыта на другом устройстве: маржа + результат
    }
    out.balance = bal;

    const seenE = new Set((out.events || []).map((e) => e.id));
    (other.events || []).forEach((e) => { if (e && e.id && !seenE.has(e.id)) out.events.push(e); });
    out.events = (out.events || []).sort((x, y) => (y.ts || 0) - (x.ts || 0)).slice(0, 80);

    // push-подписки всех устройств
    out.pushSubs = mergePushSubs(a.pushSubs, b.pushSubs);
    // R50: резервный канал ntfy — целиком от более свежего источника (last.ts),
    // при равенстве — включённый важнее выключенного
    out.ntfy = (() => {
      const na = a.ntfy && typeof a.ntfy === "object" ? a.ntfy : null;
      const nb = b.ntfy && typeof b.ntfy === "object" ? b.ntfy : null;
      if (!na) return nb || { on: false, topic: "", last: null };
      if (!nb) return na;
      const ta = (na.last && na.last.ts) || 0, tb = (nb.last && nb.last.ts) || 0;
      if (ta !== tb) return ta > tb ? na : nb;
      if (!!na.on !== !!nb.on) return na.on ? na : nb;
      return String(na.topic || "") ? na : nb;
    })();

    // R51: синхронизация OKX — сервер авторитарен; при слиянии берём того, у кого свежее
    // состояние баланса (lastSync), при равенстве — подключённого
    out.okx = (() => {
      const oa = a.okx && typeof a.okx === "object" ? a.okx : null;
      const ob = b.okx && typeof b.okx === "object" ? b.okx : null;
      if (!oa) return ob || null;
      if (!ob) return oa;
      const la = Number(oa.lastSync) || 0, lb = Number(ob.lastSync) || 0;
      if (la !== lb) return la > lb ? oa : ob;
      return oa.on ? oa : ob;
    })();

    // R43: теневая торговля — union записей по id, счётчики по максимуму (они монотонные)
    {
      const byId = new Map();
      for (const e of [...((b.shadow && b.shadow.list) || []), ...((a.shadow && a.shadow.list) || [])]) {
        if (e && e.id && !byId.has(e.id)) byId.set(e.id, e);
      }
      const stA = (a.shadow && a.shadow.stats) || {}, stB = (b.shadow && b.shadow.stats) || {};
      const stats = {};
      for (const k of ["right", "wrong", "flat", "avoidedSum", "avoidedN"]) stats[k] = Math.max(Number(stA[k]) || 0, Number(stB[k]) || 0);
      const sA = Number(stA.since) || 9e15, sB = Number(stB.since) || 9e15;
      stats.since = Math.min(sA, sB) >= 9e15 ? Date.now() : Math.min(sA, sB);
      // R44: история подстроек порога — union по ts, свежие сверху
      const tuneById = new Map();
      for (const t of [...((b.shadow && b.shadow.tune) || []), ...((a.shadow && a.shadow.tune) || [])]) {
        if (t && typeof t.ts === "number" && !tuneById.has(t.ts)) tuneById.set(t.ts, t);
      }
      const tune = Array.from(tuneById.values()).sort((x, y) => (y.ts || 0) - (x.ts || 0)).slice(0, 10);
      // R45: доверие по монетам — union по sym; счётчики монотонные → по максимуму,
      // adj/ts — от более свежей записи; пропуски скана — позднейший until
      const trA = (a.shadow && a.shadow.trust) || {}, trB = (b.shadow && b.shadow.trust) || {};
      const trustOut = {};
      for (const sym of new Set([...Object.keys(trA), ...Object.keys(trB)])) {
        const ta = trA[sym] || null, tb = trB[sym] || null;
        if (!ta) { trustOut[sym] = tb; continue; }
        if (!tb) { trustOut[sym] = ta; continue; }
        const newer = (tb.ts || 0) >= (ta.ts || 0) ? tb : ta;
        trustOut[sym] = {
          right: Math.max(Number(ta.right) || 0, Number(tb.right) || 0),
          wrong: Math.max(Number(ta.wrong) || 0, Number(tb.wrong) || 0),
          flat: Math.max(Number(ta.flat) || 0, Number(tb.flat) || 0),
          adj: Number(newer.adj) || 0,
          ts: Math.max(Number(ta.ts) || 0, Number(tb.ts) || 0),
        };
      }
      const skA = (a.shadow && a.shadow.skip) || {}, skB = (b.shadow && b.shadow.skip) || {};
      const skipOut = {};
      for (const sym of new Set([...Object.keys(skA), ...Object.keys(skB)])) {
        const until = Math.max(Number(skA[sym]) || 0, Number(skB[sym]) || 0);
        if (until > Date.now()) skipOut[sym] = until; // истёкшие пропуски не resurrect
      }
      out.shadow = { list: Array.from(byId.values()).sort((x, y) => (y.ts || 0) - (x.ts || 0)).slice(0, 60), stats, tune, trust: trustOut, skip: skipOut };
    }

    // R31: аренда исполнителя — действует аренда с БОЛЕЕ ПОЗДНИМ сроком (кто последний
    // продлил, тот и жив); просроченная ни на что не влияет (hostActive проверяет until)
    const ha = a.host && a.host.id ? a.host : null;
    const hb = b.host && b.host.id ? b.host : null;
    out.host = !ha ? hb : !hb ? ha : (((hb.until || 0) >= (ha.until || 0)) ? hb : ha);

    // могилки очистки истории объединяются с обеих сторон: удалённое на любом
    // устройстве не воскресает из архива другого устройства или облака
    out.clearedU = Array.from(new Set([...(a.clearedU || []), ...(b.clearedU || [])])).slice(-800);
    out.clearedL = Array.from(new Set([...(a.clearedL || []), ...(b.clearedL || [])])).slice(-800);
    if (out.clearedU.length) {
      const tombU = new Set(out.clearedU);
      out.userClosed = (out.userClosed || []).filter((c) => !tombU.has(c.id));
    }
    if (out.clearedL.length) {
      const tombL = new Set(out.clearedL);
      out.labClosed = (out.labClosed || []).filter((c) => !tombL.has(c.id));
    }
    out.rev = Math.max(a.rev || 0, b.rev || 0);
    out.updatedAt = Math.max(a.updatedAt || 0, b.updatedAt || 0);
    return out;
  }

  function applySyncArchive(d, sourceLabel) {
    const before = { bal: state.balance, closed: state.userClosed.length, open: state.userPositions.length };
    applyArchive(d);
    state.updatedAt = Date.now(); // содержимое аккаунта только что изменилось — фиксируем сразу, не дожидаясь debounce persist
    const after = { bal: state.balance, closed: state.userClosed.length, open: state.userPositions.length };
    // ВАЖНО (R31): событие в ленту — ТОЛЬКО для ручного восстановления. Облачное
    // слияние применяется молча: иначе каждое слияние добавляло бы событие, оно
    // меняло бы отпечаток → пуш → слияние у второго устройства → его событие →
    // бесконечная перезапись облака (цикл пожирал бы дневной лимит записей).
    if (sourceLabel === "файловый бэкап") {
      pushEvent({
        tone: "neutral",
        title: `Архив аккаунта восстановлен (${sourceLabel})`,
        detail: `баланс ${Fmt.fmtNum(Math.round(before.bal))} → ${Fmt.fmtNum(Math.round(after.bal))} ХРЮ · закрытых сделок ${before.closed} → ${after.closed} · в рынке ${before.open} → ${after.open} · история объединена без потерь`,
      });
    }
    persist();
    emit();
  }

  // облако textdb хранит value до 200 000 символов; полный локальный архив (до 300 сделок
  // со снапшотами факторов, ~850 байт на сделку) может превышать лимит. Режем ХВОСТ
  // истории, не трогая баланс, открытые позиции, настройки и свежие сделки: в облаке
  // всегда живут последние ≥150 сделок, полная история — локально и в файловом бэкапе.
  function trimForCloud(src) {
    const d = JSON.parse(JSON.stringify(src));
    const steps = [
      { uc: 150, lc: 150, ev: 60, eq: 300 },
      { uc: 80, lc: 80, ev: 40, eq: 150 },
      { uc: 40, lc: 40, ev: 24, eq: 80 },
      { uc: 20, lc: 20, ev: 12, eq: 40 },
    ];
    for (const st of steps) {
      d.userClosed = (d.userClosed || []).slice(0, st.uc);
      d.labClosed = (d.labClosed || []).slice(0, st.lc);
      d.events = (d.events || []).slice(0, st.ev);
      d.equityHist = (d.equityHist || []).slice(-st.eq);
      if (JSON.stringify(d).length <= 190000) return d;
    }
    return d;
  }

  // «девственный» аккаунт: торгов ещё не было, менять в облаке нечего. Такой архив
  // НЕ имеет права затирать облако — классическая потеря данных: свежий ПК с пустым
  // счётом перезаписывал телефон с 7 открытыми позициями.
  function isVirginArchive(d) {
    return (!d.userPositions || !d.userPositions.length)
      && (!d.userClosed || !d.userClosed.length)
      && (!d.labPositions || !d.labPositions.length)
      && (!d.labClosed || !d.labClosed.length)
      && (!d.equityHist || !d.equityHist.length)
      && d.balance === d.startBalance;
  }

  // ============ R31: СЕРВЕРНЫЙ АККАУНТ ============
  // До R31 синхронизация была «перекрёстной записью целых архивов»: устройство,
  // считавшее себя самым свежим, затирало облако ЦЕЛИКОМ без слияния, а фоновый
  // персист эквити раз в 30 секунд постоянно двигал его часы (updatedAt) — поэтому
  // ПК и телефон бесконечно перетирали друг друга (на ПК одни позиции, на телефоне
  // другие — кейс со скринов). Теперь аккаунт ЖИВЁТ НА СЕРВЕРЕ (облако), устройства —
  // тонкие клиенты:
  //   1) каждый цикл: ПРОЧИТАТЬ облако → СЛИТЬ с локальным (union позиций и истории)
  //      → записать слитое. Пути «записать без слияния» больше НЕ СУЩЕСТВУЕТ;
  //   2) автоторговлю ведёт ОДИН исполнитель (аренда «host» — часть облака аккаунта):
  //      входы ИИ, флипы и входы лаборатории делает только он, дублей не появляется;
  //   3) часы изменения двигают только реальные изменения (см. persistNow), а не
  //      фоновые сохранения — «свежесть» снова стала честной.
  const HOST_TTL = 10 * 60000;        // аренда исполнителя: 10 минут
  const HOST_RENEW_LEFT = 4 * 60000;  // продлеваем, когда аренде осталось меньше 4 минут
  let deviceId = null;
  function loadDeviceId() {
    if (deviceId) return deviceId;
    try { deviceId = localStorage.getItem(dataKey() + "__device"); } catch (e) { /* noop */ }
    if (!deviceId || typeof deviceId !== "string") {
      deviceId = "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      try { localStorage.setItem(dataKey() + "__device", deviceId); } catch (e2) { /* noop */ }
    }
    return deviceId;
  }
  function hostActive() {
    // R32: в серверном режиме исполнителем показываем сам сервер
    if (serverMode()) return { id: "server", tag: "Сервер XenoAI", until: 9e15 };
    return (state.host && state.host.id && (state.host.until || 0) > Date.now()) ? state.host : null;
  }
  function isAutoHost() {
    const h = hostActive();
    return !!h && h.id === (deviceId || loadDeviceId());
  }
  function hostFree() { return !hostActive(); }
  // заявка на исполнение: свободно → берём; уже наше → true; чужая живая аренда → false
  function claimHost(tag) {
    if (serverMode()) return false; // аренда принадлежит серверу
    loadDeviceId();
    if (isAutoHost()) return true;
    if (!hostFree()) return false;
    state.host = { id: deviceId, tag: String(tag || "устройство").slice(0, 40), until: Date.now() + HOST_TTL };
    persist(); emit();
    return true;
  }
  function renewHostIfDue() {
    if (!isAutoHost()) return false;
    if ((state.host.until || 0) - Date.now() >= HOST_RENEW_LEFT) return false;
    state.host.until = Date.now() + HOST_TTL; // отпечаток изменится — аренда уедет в облако ближайшей записью
    persist();
    return true;
  }
  function releaseHost(silent) {
    if (!isAutoHost()) return false;
    state.host = null;
    if (!silent) { persist(); emit(); }
    return true;
  }
  // исполнитель берётся сам, как только аренда освободилась и включена автоторговля.
  // R32: в серверном режиме исполнитель — сам сервер, устройства ничего не заявляют
  function maybeTakeHost() {
    if (serverMode()) return;
    if (!state.started || syncCtl.busy) return;
    if (!(state.aiAuto || state.autoTrade)) return;
    if (isAutoHost() || !hostFree()) return;
    setTimeout(() => {
      if (!state.started || syncCtl.busy || isAutoHost() || !hostFree()) return;
      let tag = "устройство";
      try { tag = navigator.userAgent && navigator.userAgent.indexOf("Mobi") !== -1 ? "смартфон" : "браузер"; } catch (e) { /* noop */ }
      if (claimHost(tag)) {
        pushEvent({ tone: "neutral", title: "Автоторговля на этом устройстве", detail: "получена серверная аренда исполнителя: входы ИИ, флипы и входы лаборатории ведёт эта вкладка. Состояние аккаунта при этом одно и то же на всех устройствах — различается только то, кто исполняет." });
      }
    }, Math.floor(Math.random() * 3000)); // джиттер: два устройства не должны схватить аренду в один миг
  }

  let lastWriteAt = 0;
  let lastCycleOkAt = 0;
  function putArchive(local, force) {
    // пустой счёт не затирает облако, где уже есть данные другого устройства
    if (state.sync.sawRemote && isVirginArchive(local)) return Promise.resolve(false);
    const fp = fpOf(local);
    if (force !== "seed" && fp === syncCtl.lastPushedFp) return Promise.resolve(false); // содержимое не менялось — запись не тратим
    // троттлинг записи (лимит облака — 500 записей/сутки с IP): не чаще раза в 15 секунд
    const since = Date.now() - (state.sync.lastPush || 0);
    if (force !== "seed" && since < 15000) {
      if (!syncCtl.pushTimer) syncCtl.pushTimer = setTimeout(() => { syncCtl.pushTimer = null; syncCycle(); }, Math.max(2000, 15000 - since));
      return Promise.resolve(false);
    }
    if (!budgetTake()) { state.sync.lastError = "дневной лимит записей облака исчерпан — данные уедут при следующем окне"; return Promise.resolve(false); }
    const body = "key=" + encodeURIComponent(syncKey()) + "&value=" + encodeURIComponent(JSON.stringify(trimForCloud(local)));
    return fetchT(SYNC_UPDATE_URL, 20000, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body })
      .then((r) => { if (!r.ok) throw new Error("запись " + r.status); return r.json().catch(() => ({})); })
      .then((j) => {
        if (j && j.status === 0) throw new Error("облако отклонило запись");
        state.sync.lastPush = Date.now(); state.sync.lastError = null;
        lastWriteAt = Date.now();
        syncCtl.lastPushedFp = fp;
        return true;
      })
      .catch((e) => { state.sync.lastError = "запись: " + String(e && e.message || e); return false; });
  }

  // ЕДИНЫЙ ЦИКЛ СИНХРОНИЗАЦИИ: прочитать → слить → записать слитое.
  // Вызывается по расписанию (20 с), после изменений (debounce 8 с), по фокусу/сети
  // и вручную («Синхронизировать сейчас»).
  function syncCycle() {
    // R32: серверный режим — цикл синхронизации = опрос состояния сервера
    if (serverMode()) { Server.pull(applyServerArchive); return Promise.resolve(false); }
    if (!state.started || !state.sync.enabled || !state.sync.code) return Promise.resolve(false);
    if (syncCtl.busy) { syncCtl.pending = true; return Promise.resolve(false); }
    syncCtl.busy = true;
    return fetchT(SYNC_BASE + syncKey(), 12000)
      .then((r) => { if (!r.ok) throw new Error("чтение " + r.status); return r.text(); })
      .then((txt) => {
        txt = (txt || "").trim();
        state.sync.lastPull = Date.now();
        state.sync.lastError = null;
        if (!txt) {
          // облако пустое (новый аккаунт): сеем своим архивом, если есть чем
          return putArchive(archiveAccount(), "seed");
        }
        const remote = JSON.parse(txt);
        if (!remote || typeof remote !== "object" || !Array.isArray(remote.userClosed)) throw new Error("чужой или битый архив");
        state.sync.sawRemote = true; // облако живо и с данными: пустой локальный счёт его не затрёт
        const local = archiveAccount();
        local.updatedAt = state.updatedAt || 0;
        if (fpOf(remote) === fpOf(local)) {
          state.rev = Math.max(state.rev || 0, remote.rev || 0);
          syncCtl.lastPushedFp = fpOf(local);
          renewHostIfDue();
          return false;
        }
        // СЕРВЕРНАЯ ДИСЦИПЛИНА: прежде чем писать — ВСЕГДА сливаем облако с локальным.
        // Путь «моя копия свежее — запишу её как есть» удалён: именно он гонял устройства
        // по кругу и разваливал аккаунт на два разных.
        const merged = mergeArchives(local, remote);
        if (fpOf(merged) !== fpOf(local)) applySyncArchive(merged, "облако");
        renewHostIfDue();
        return putArchive(archiveAccount(), false);
      })
      .catch((e) => { state.sync.lastError = String(e && e.message || e); return false; })
      .then((ok) => {
        syncCtl.busy = false;
        if (ok) lastCycleOkAt = Date.now();
        persistSyncMeta();
        maybeTakeHost();
        emit();
        if (syncCtl.pending) { syncCtl.pending = false; setTimeout(() => syncCycle(), 3000); }
        return ok;
      });
  }
  // совместимые имена: всё, что звало syncPull/syncPush, получает единый цикл
  function syncPull() { return syncCycle(); }
  function syncPush() { return syncCycle(); }
  function scheduleSyncPush() {
    // R32: в серверном режиме (бэкенд задеплоен и активен) textdb-запись не нужна —
    // сервер и есть облако, состояние уезжает с действиями и опросом
    if (serverMode()) return;
    if (!state.sync.enabled || !state.sync.code || syncCtl.pushTimer) return;
    syncCtl.pushTimer = setTimeout(() => { syncCtl.pushTimer = null; syncCycle(); }, 8000);
  }

  // ======== R32: СЕРВЕРНЫЙ РЕЖИМ (бэкенд Cloudflare Worker + Durable Object) ========
  // Бэкенд задеплоен (backend-config.js с URL) и в этом браузере есть токен → аккаунт
  // ЖИВЁТ НА СЕРВЕРЕ: все действия (открыть/закрыть/очистить историю/настройки) исполняются
  // сервером, локальное состояние — его отражение (опрос каждые 12 с). Автопилот торгует
  // на сервере каждые 2 минуты — браузер может быть полностью выключен.
  function serverMode() {
    return Boolean(typeof window !== "undefined" && window.Server && Server.active());
  }
  // применение серверного архива: сервер — единственный источник правды, его архив
  // заменяет локальное содержимое целиком (действия и так исполняются на сервере)
  function applyServerArchive(a) {
    if (!a || typeof a !== "object" || !Array.isArray(a.userClosed)) return;
    applyArchive(a);
    state.updatedAt = a.updatedAt || Date.now();
    lastPersistFp = null; // локальный кэш должен переписаться серверным содержимым
    persist();
    emit();
  }
  // серверное исполнение действия + мгновенный optimistic-отклик для UI.
  // Локально применяем ту же логику (тот же код, что и раньше) — сервер повторит
  // действие АВТОРИТАРНО со своим свежим состоянием; расхождения исчезают при
  // ближайшем опросе (≤12 с), серверная версия всегда побеждает.
  function serverAction(type, payload, localFn) {
    const localRes = localFn ? localFn() : { ok: true };
    Server.action(type, payload, applyServerArchive).then((srv) => {
      if (srv && srv.ok === false && localRes && localRes.ok) {
        // сервер отказал (его состояние свежее/строже) — честно сообщаем в ленту
        pushEvent({ tone: "bear", title: "Сервер отклонил действие: " + type, detail: String(srv.error || "") });
      }
    }).catch(() => { /* сеть — сервер примет действие при повторе или истечёт по опросу */ });
    return localRes;
  }
  // «отпечаток» архива: состав баланса/позиций/истории/настроек без ревизий.
  // Нужен, чтобы синхронизация не зацикливалась: если содержимое после слияния
  // совпало с облачным — просто принимаем его ревизию, без повторного пуша.
  function fpOf(a) {
    if (!a || typeof a !== "object") return "";
    const c0 = (a.userClosed || [])[0] || {};
    const e0 = (a.events || [])[0] || {};
    const cu = a.clearedU || [], cl = a.clearedL || [];
    return [
      a.balance,
      // R30: не только id, но и содержимое позиций (стоп движется трейлингом) — иначе
      // сдвиг стопа не уезжал бы в облако, пока не изменится состав позиций
      (a.userPositions || []).map((p) => p.id + ":" + (p.stop || 0) + ":" + (p.mt || 0)).sort().join(","),
      (a.userClosed || []).length + ":" + (c0.id || ""),
      (a.events || []).length + ":" + (e0.id || ""),
      cu.length + ":" + (cu.length ? cu[cu.length - 1] : ""),
      cl.length + ":" + (cl.length ? cl[cl.length - 1] : ""),
      a.maxDeal, a.maxTotal, a.aiThreshold, a.aiPosMode,
      a.failPct, // R30: провальный порог — Страж должен получить его как можно раньше
      (a.pushSubs || []).length, // новая подписка устройства обязана уехать в облако
      a.ntfy ? (a.ntfy.on ? 1 : 0) + ":" + (a.ntfy.topic || "") + ":" + ((a.ntfy.last && a.ntfy.last.ts) || 0) : "-", // R50: резервный канал обязан уезжать
      a.host ? a.host.id + ":" + a.host.until : "-", // R31: аренда исполнителя обязана уезжать (заявка/продление/освобождение)
      a.mode, a.autoTrade ? 1 : 0, a.aiAuto ? 1 : 0, a.aiAutoLive ? 1 : 0,
      a.okx ? (a.okx.on ? 1 : 0) + (a.okx.auto !== false ? 1 : 0) + ":" + (a.okx.mask || "") + ":" + ((Number(a.okx.lastSync) || 0) / 60000 | 0) : "okx-", // R51: состояние OKX обязано уезжать
    ].join("|");
  }

  function enableSync(code) {
    const c = String(code || "").trim().toUpperCase();
    if (c && !/^[A-Z0-9-]{8,24}$/.test(c)) return { ok: false, error: "Код синхронизации — 8–24 латинских букв, цифр и дефисов" };
    // без явного кода берём детерминированный код аккаунта — тогда все устройства
    // с этим логином объединяются сами, а не разъезжаются по разным облакам
    state.sync.code = c || (typeof Auth !== "undefined" && Auth.syncCodeFor ? Auth.syncCodeFor(Auth.sessionLogin()) : genSyncCode());
    state.sync.enabled = true;
    state.sync.lastError = null;
    persistSyncMeta();
    // порядок важен: СНАЧАЛА тянем облачный архив (если код уже используется другим
    // устройством — подтянем его историю, а не затрём её своим пустым состоянием),
    // потом делимся своим
    syncPull().then(() => { if (state.sync.enabled) syncPush(); });
    if (typeof setInterval === "function" && !syncCtl.pollTimer) {
      syncCtl.pollTimer = setInterval(() => { if (state.started && state.sync.enabled) syncPull(); }, 20000);
    }
    persist(); emit();
    return { ok: true, code: state.sync.code };
  }
  function syncInfo() {
    const h = hostActive();
    return {
      code: state.sync.code, enabled: state.sync.enabled, lastPush: state.sync.lastPush, lastPull: state.sync.lastPull, lastError: state.sync.lastError, busy: syncCtl.busy,
      // R31: кто сейчас исполнитель автоторговли (видно в Кабинете на любом устройстве)
      host: h ? { id: h.id, tag: h.tag || "", until: h.until } : null,
      me: deviceId || loadDeviceId(),
      isHost: isAutoHost(),
    };
  }
  function initSyncRuntime() {
    if (syncCtl.inited) return;
    syncCtl.inited = true;
    loadSyncMeta();
    // ЕДИНЫЙ АККАУНТ = ЕДИНЫЕ ДАННЫЕ: синхронизация включена ВСЕГДА, без опций вкл/выкл
    // (требование пользователя). Код выводится детерминированно из логина (Auth.syncCodeFor),
    // поэтому один и тот же аккаунт на любом устройстве попадает в одно и то же облако сам:
    // баланс, открытые позиции и вся история объединяются без ручных действий. Старый код из
    // метаданных (эпохи ручных кодов) заменяется кодом аккаунта — иначе устройство смотрело
    // бы в чужое/одинокое облако и «не видило» данные основного устройства.
    const autoCode = (typeof Auth !== "undefined" && Auth.syncCodeFor) ? Auth.syncCodeFor(Auth.sessionLogin()) : null;
    const prevCode = state.sync.code;
    const wasOff = !state.sync.enabled || !state.sync.code;
    state.sync.code = autoCode || state.sync.code || genSyncCode();
    state.sync.enabled = true;
    state.sync.lastError = null;
    if (wasOff || prevCode !== state.sync.code) {
      persistSyncMeta();
      pushEvent({ tone: "neutral", title: "Синхронизация устройств включена", detail: `единый аккаунт — единые данные: баланс, открытые позиции и вся история синхронизируются между устройствами автоматически (код аккаунта ${state.sync.code}, виден в Кабинете; отключения не предусмотрено)` });
    }
    if (state.sync.enabled && state.sync.code) {
      // R32: в серверном режиме textdb-таймеры и beacon не нужны — сервер опрашивается
      // своим циклом (Server.startPolling), действия уезжают по факту
      if (serverMode()) { persistSyncMeta(); return; }
      if (typeof setInterval === "function" && !syncCtl.pollTimer) {
        syncCtl.pollTimer = setInterval(() => { if (state.started && state.sync.enabled) syncPull(); }, 20000);
      }
      setTimeout(() => { if (state.started) syncPull(); }, 3000);
      // мгновенный цикл при возврате во вкладку / восстановлении сети:
      // рассинхрон между устройствами живёт секунды, а не минуты
      if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
        const kick = () => { if (state.started && state.sync.enabled && !syncCtl.busy) setTimeout(() => { if (state.sync.enabled) syncPull(); }, 1500); };
        window.addEventListener("focus", kick);
        window.addEventListener("online", kick);
        document.addEventListener("visibilitychange", () => { if (!document.hidden) kick(); });
        // R31: вкладка ушла в фон — освобождаем аренду исполнителя (быстрая передача
        // другому устройству/Стражу), иначе фоновые таймеры замедляются и торговля ждала бы
        let hiddenAt = 0;
        document.addEventListener("visibilitychange", () => {
          if (document.hidden) { hiddenAt = Date.now(); }
          else { hiddenAt = 0; maybeTakeHost(); }
        });
        if (typeof setInterval === "function") {
          setInterval(() => {
            if (document.hidden && hiddenAt && Date.now() - hiddenAt > 3 * 60000) releaseHost(); // фон > 3 мин — отдаём исполнительство
          }, 60000);
        }
        // финальная досылка при закрытии страницы: последнее состояние уезжает
        // в облако через sendBeacon (не зависит от выгрузки документа).
        // R31: beacon несёт СЛИТОЕ с сервером состояние — пишем только если серверный
        // цикл был свежее 25 секунд (иначе можно перетереть чужие изменения), и
        // освобождаем аренду исполнителя — вкладка закрывается.
        window.addEventListener("pagehide", () => {
          try {
            savePriceSnapshot(); // R30: цены последнего сеанса — на устройство
            if (isAutoHost()) state.host = null; // аренда освобождается даже если beacon не пройдёт
            const local = archiveAccount();
            if (state.sync.sawRemote && isVirginArchive(local)) return;
            if (Date.now() - lastCycleOkAt > 25000) return; // вид облака устарел — лучше не рисковать
            const fp = fpOf(local);
            if (fp === syncCtl.lastPushedFp) return;
            const j = JSON.stringify(trimForCloud(local));
            if (typeof navigator === "undefined" || !navigator.sendBeacon || j.length > 64000) return;
            const body = "key=" + encodeURIComponent(syncKey()) + "&value=" + encodeURIComponent(j);
            const okB = navigator.sendBeacon(SYNC_UPDATE_URL, new Blob([body], { type: "application/x-www-form-urlencoded" }));
            if (okB) { syncCtl.lastPushedFp = fp; state.sync.lastPush = Date.now(); persistSyncMeta(); }
          } catch (e) { /* noop */ }
        });
      }
    }
  }

  // файловый бэкап: выгрузка полного архива в JSON-файл и восстановление из него
  // (работает без сети — перенос между устройствами через файл)
  function exportBackup() {
    const d = archiveAccount();
    d.exportedAt = new Date().toISOString();
    d.login = (Auth.readSession() || {}).login || null;
    return d;
  }
  function importBackup(jsonText) {
    let d;
    try { d = JSON.parse(jsonText); } catch (e) { return { ok: false, error: "Файл не читается как JSON" }; }
    if (!d || typeof d !== "object" || !Array.isArray(d.userClosed) || typeof d.balance !== "number") {
      return { ok: false, error: "Это не архив XenoAI Trade (нет баланса или истории сделок)" };
    }
    const merged = mergeArchives(archiveAccount(), d); // слияние: ничего не теряем
    applySyncArchive(merged, "файловый бэкап");
    return { ok: true };
  }

  // ---------- R30: PUSH-ПОДПИСКИ УСТРОЙСТВ (нативный Web Push) ----------
  // Разрешение на уведомления — единственное действие от пользователя. Подписка
  // устройства (PushSubscription браузера) сохраняется в архив аккаунта и уезжает
  // в облако синхронизации; Страж (GitHub Actions) читает подписки и шлёт пуши о
  // сделках прямо в браузер/PWA — даже когда приложение полностью закрыто.
  // Никаких сторонних приложений и ручных тем (ntfy убран — он требовал лишних шагов).
  function addPushSub(sub) {
    if (!sub || typeof sub.endpoint !== "string" || sub.endpoint.indexOf("https://") !== 0
      || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return { ok: false, error: "подписка неполная" };
    // R47: origin домена, создавшего подписку, сохраняется и в стейт, и на сервере —
    // модалка сравнивает его с текущим доменом (переезд xenoai-chi → xenotrade)
    const origin = String(sub.origin || (typeof location !== "undefined" && location.origin) || "");
    const rest = (state.pushSubs || []).filter((s) => s.endpoint !== sub.endpoint);
    rest.unshift({
      endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      ts: Date.now(), ua: (typeof navigator !== "undefined" && navigator.userAgent || "").slice(0, 140),
      origin,
    });
    state.pushSubs = rest.slice(0, 8);
    // R32: подписка немедленно регистрируется НА СЕРВЕРЕ (пуши шлёт сервер) —
    // и не зависит от синхронизации текстового облака
    if (serverMode()) {
      try { Server.pushSub({ endpoint: sub.endpoint, keys: sub.keys, origin }, (typeof navigator !== "undefined" && navigator.userAgent || "")); } catch (e) { /* пуш не критичен */ }
    }
    pushEvent({
      tone: "neutral",
      title: "Push-подписка устройства сохранена",
      detail: "Страж будет присылать на это устройство пуши о сделках ИИ даже при полностью закрытом приложении · разрешение на уведомления — единственное, что требуется",
    });
    persist(); emit();
    return { ok: true };
  }
  function removePushSub(endpoint) {
    if (!endpoint) return;
    const before = (state.pushSubs || []).length;
    state.pushSubs = (state.pushSubs || []).filter((s) => s.endpoint !== endpoint);
    if (state.pushSubs.length !== before) persist();
  }

  // ---------- R50: РЕЗЕРВНЫЙ КАНАЛ NTFY ----------
  // Web Push — основной канал, но живая диагностика (r50) показала: на части
  // Android-устройств Chrome не будит service worker в фоне (OEM-менеджеры батареи).
  // ntfy — независимое приложение, получает события своим соединением и показывает
  // их при полностью закрытом браузере. Тема — несгадываемый случайный идентификатор.
  function generateNtfyTopic() {
    // без «0/o/1/l» — тема произносится и перепечатывается руками
    const abc = "abcdefghjkmnpqrstuvwxyz23456789";
    let s = "";
    try {
      const rnd = new Uint8Array(10);
      (window.crypto || crypto).getRandomValues(rnd);
      for (const b of rnd) s += abc[b % abc.length];
    } catch (e) {
      for (let i = 0; i < 10; i++) s += abc[Math.floor(Math.random() * abc.length)];
    }
    return "xenoai-" + s;
  }
  function setNtfy(on, topic) {
    const t = String(topic || (state.ntfy && state.ntfy.topic) || "").trim();
    if (!/^[a-zA-Z0-9_-]{6,64}$/.test(t)) return { ok: false, error: "Тема ntfy: 6–64 символа, латиница/цифры/дефис/подчёркивание" };
    const localRes = (() => {
      state.ntfy = { on: on !== false, topic: t, last: (state.ntfy && state.ntfy.last) || null };
      persist(); emit();
      return { ok: true };
    })();
    if (serverMode()) serverAction("ntfySet", { on: on !== false, topic: t });
    return localRes;
  }

  // R51: аварийный выключатель авто-ордеров OKX (баланс продолжает синхронизироваться)
  function setOkxAuto(on) {
    state.okx = state.okx && typeof state.okx === "object" ? state.okx : { on: false, auto: false, mask: "", balanceUSDT: null, balanceEq: null, ts: 0, lastSync: 0, lastErr: "" };
    state.okx.auto = on !== false;
    persist(); emit();
    if (serverMode()) serverAction("okxAuto", { on: on !== false });
    return { ok: true };
  }

  // шина системных уведомлений: модуль Notify подписывается и показывает
  // push-оповещения по событиям, помеченным notify: { kind } (см. js/notify.js)
  const notifyBus = new Set();
  function onNotify(fn) { notifyBus.add(fn); return () => notifyBus.delete(fn); }

  function pushEvent(e, tsOverride) {
    // R31: явный id — для дедупликации. Одно и то же закрытие, исполненное двумя
    // устройствами параллельно (защитные стопы/цели работают везде), даёт ОДИНАКОВЫЙ
    // id события → слияние облака оставляет одну запись в ленте, а не две.
    const id = e.id || `e${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    state.events = [{ ...e, id, ts: tsOverride || Date.now() }, ...state.events].slice(0, 60);
    if (e.notify && e.notify.kind && notifyBus.size) {
      const data = Object.assign({ title: e.title, body: e.detail || "", sym: e.sym }, e.notify.data || {});
      notifyBus.forEach((fn) => { try { fn(e.notify.kind, data); } catch (err) { /* noop */ } });
    }
  }

  // журнал диагностики: ошибки платформы не теряются молча, а попадают в ленту
  // (с троттлингом и дедупликацией) — на экране «События» видно, что именно сломалось.
  // ЧУЖИЕ ошибки в ленту не попадают: если в стеке нет ни одного файла платформы,
  // ошибку выбросило расширение браузера или инъекция хостинга — чинить её мы не
  // можем, а пользователя она только пугает (реальный кейс: «Cannot read properties
  // of undefined (reading 'M_ID')» — 259 раз за сессию; в коде платформы «M_ID»
  // не встречается НИ РАЗУ, источник — посторонний скрипт в браузере).
  let lastDiagAt = 0, diagCount = 0, foreignCount = 0;
  const OUR_SRC_RE = /(?:\/js\/|js\/[a-z]+\.js|sw\.js|guardian\.js|tools\/|index\.html|404\.html|file:\/\/|localhost|127\.0\.0\.1|space-z\.ai|github\.io|githubusercontent\.com|vercel\.app|pages\.dev)/i;
  const diagSeen = new Map(); // сигнатура сбоя → { n, lastAt }: один и тот же сбой не спамит ленту
  function diagError(where, err) {
    diagCount++;
    const stack = err && typeof err.stack === "string" ? err.stack : "";
    if (stack && !OUR_SRC_RE.test(stack)) {
      // чужой скрипт (расширение/инъекция): считаем молча, пользователя не пугаем
      foreignCount++;
      try { console.info("[xenoai] ошибка постороннего скрипта (не платформа) в «" + where + "»:", err && err.message || err); } catch (e) { /* noop */ }
      return;
    }
    const raw = String((err && err.message) || err || "неизвестная ошибка");
    const human = raw.indexOf("Failed to fetch") !== -1
      ? "источник данных не ответил (сеть) — повторим при следующем прогоне"
      : raw;
    const sig = where + "|" + human.slice(0, 80);
    const now = Date.now();
    if (diagSeen.size > 40) diagSeen.clear();
    const seen = diagSeen.get(sig) || { n: 0, lastAt: 0 };
    seen.n++;
    diagSeen.set(sig, seen);
    if (now - lastDiagAt < 45000) return;          // не чаще раза в 45 секунд
    if (seen.n > 1 && now - seen.lastAt < 20 * 60000) return; // тот же сбой уже показан — копим счётчик молча
    lastDiagAt = now; seen.lastAt = now;
    pushEvent({
      tone: "bear",
      title: `Самодиагностика: сбой в «${where}» — работа продолжается`,
      detail: human.slice(0, 160) + (seen.n > 1 ? ` · повторов: ${seen.n}` : "") + ` · сбоев за сессию: ${diagCount} · данные не пострадали`,
    });
  }

  // ---------- очистка истории закрытых сделок (запрос пользователя) ----------
  // Удалённое не просто исчезает локально: id попадают в «могилки» (clearedU/clearedL),
  // которые едут в облако и объединяются при синке — иначе union-слияние архивов
  // воскресило бы удалённые сделки из облака или с другого устройства.
  function clearClosedHistory(which) {
    if (!canTrade()) return { ok: false, error: "Историю может очищать только аккаунт David или Yura" };
    // R32: удаление истории ФИКСИРУЕТСЯ НА СЕРВЕРЕ — могилки серверного архива обязаны
    // приехать на все устройства (кейс пользователя: на ПК удалено, на мобиле живёт).
    // В серверном режиме могилки живут в серверном состоянии и никакой union их не воскресит.
    if (serverMode()) return serverAction("clearHistory", { which }, () => clearClosedHistoryLocal(which));
    return clearClosedHistoryLocal(which);
  }
  function clearClosedHistoryLocal(which) {
    const isUser = which !== "lab";
    const list = isUser ? state.userClosed : state.labClosed;
    const n = list.length;
    if (!n) return { ok: false, error: "История закрытых сделок и так пуста" };
    if (isUser) {
      state.clearedU = Array.from(new Set([...(state.clearedU || []), ...list.map((c) => c.id)])).slice(-800);
      state.userClosed = [];
    } else {
      state.clearedL = Array.from(new Set([...(state.clearedL || []), ...list.map((c) => c.id)])).slice(-800);
      state.labClosed = [];
    }
    pushEvent({
      tone: "neutral",
      title: `История закрытых сделок очищена: удалено ${n}`,
      detail: (isUser ? "ваша история закрытых сделок" : "история закрытых сделок лаборатории")
        + " · баланс и открытые позиции не тронуты · память ИИ сохранена · после синхронизации история очистится и на других устройствах",
    });
    persist();
    emit();
    return { ok: true, n };
  }

  // первый запуск аккаунта: приветственная лента вместо пустого экрана
  function welcomeIfFresh() {
    pushEvent({
      tone: "neutral",
      title: "Счёт XenoAI Trade активирован: 10 000 ХРЮ",
      detail: "демо-средства · реальные рыночные цены · сделки открывает только владелец аккаунта",
    });
    pushEvent({
      tone: "neutral",
      title: "Как открыть первую сделку на базе ИИ",
      detail: "Рынок или Сделки → блок «Сделка на базе ИИ» → «Проанализировать» → «Открыть по сигналу ИИ»",
    });
    pushEvent({
      tone: "neutral",
      title: "ИИ-сканер ищет лучшие идеи по рынку",
      detail: "автопилот вкл: сам заходит в монеты · скам- и новостная защита · авто-стоп сессии при ±50% (лимит настраивается)",
    });
    pushEvent({
      tone: "neutral",
      title: "Мозг ИИ — глобальный: одна память на всех",
      detail: "ИИ учится на каждой закрытой сделке каждого пользователя (демо и реальный режим) · память синхронизируется между устройствами",
    });
  }

  function klineToBars(rows) {
    return rows.map((k) => ({ o: k.o, h: k.h, l: k.l, c: k.c, v: k.v, t: Math.floor(k.openTime / 60000) }));
  }

  // ---------- R30: ПОСЛЕДНИЕ ИЗВЕСТНЫЕ ЦЕНЫ (переживают перезагрузку страницы) ----------
  // Раньше при полной недоступности бирж цены каждый раз стартовали с зашитых дефолтов —
  // PnL открытых позиций «воскресал» одним и тем же числом после каждого обновления
  // (кейс R30: −0.10 и −0.18 ХРЮ при каждом F5). Теперь последний известный уровень
  // сохраняется на устройстве и восстанавливается до первого опроса источников: без сети
  // цены заморожены на честном последнем значении, а не сброшены к дефолтам.
  const PRICE_SNAP_MAX = 200;
  function priceSnapKey() { return dataKey() + "__prices"; }
  function savePriceSnapshot() {
    try {
      const out = {};
      for (const sym of WATCH_SYMS) {
        const p = state.prices[sym];
        if (p && p.ts > 0 && Number.isFinite(p.price) && p.price > 0) {
          out[sym] = [p.price, p.chg24h || 0, p.high24 || p.price, p.low24 || p.price, p.vol24 || 0, p.open24 || p.price];
        }
      }
      if (Object.keys(out).length) writeRawSafe(priceSnapKey(), JSON.stringify({ ts: Date.now(), p: out }));
    } catch (e) { /* снапшот цен не критичен */ }
  }
  function restorePriceSnapshot() {
    try {
      const res = readRawSafe(priceSnapKey());
      if (!res.raw) return false;
      const d = JSON.parse(res.raw);
      if (!d || !d.p || typeof d.p !== "object") return false;
      const syms = Object.keys(d.p).slice(0, PRICE_SNAP_MAX);
      let n = 0;
      syms.forEach((sym, i) => {
        const row = d.p[sym];
        if (!Array.isArray(row) || !(Number(row[0]) > 0) || !state.prices[sym]) return;
        const price = Number(row[0]);
        state.prices[sym] = {
          sym, price, prev: price,
          chg24h: Number(row[1]) || 0,
          high24: Number(row[2]) || price, low24: Number(row[3]) || price,
          vol24: Number(row[4]) || 0, open24: Number(row[5]) || price,
          spark: seedSpark(price, i),
          ts: 0, // ts=0: данные «протухшие» — fillMissingTickers сразу докачает свежие
        };
        n++;
      });
      return n > 0;
    } catch (e) { return false; }
  }

  // ---------- действия ----------
  function setActiveSym(sym) {
    state.activeSym = sym;
    ensureBars(sym, "15м");
    loadWhales(sym);
    emit();
  }

  function getBars(sym, tf) { return state.bars[`${sym}:${tf}`] || []; }

  // R45: параллельные докачки одной и той же пары складываем в один запрос
  const barsInflight = {};

  // R45: ensureBars теперь ВОЗВРАЩАЕТ ПРОМИС: true — живые свечи лежат в кэше,
  // false — биржа не ответила (в кэше честно помеченная синтетика). Клик по идее
  // дожидается промиса сам и продолжает вход — больше не нужно «нажмите ещё раз».
  // Свечи из синтетики триггерят повторную докачку (раньше закэшированная синтетика
  // оставалась навсегда и ломала свежий пересчёт идеи).
  function ensureBars(sym, tf) {
    const key = `${sym}:${tf}`;
    const have = state.bars[key];
    if (have && have.length && !(have[have.length - 1] && have[have.length - 1].sim)) return Promise.resolve(true);
    if (barsInflight[key]) return barsInflight[key];
    const inst = BY_SYM[sym];
    if (!inst) return Promise.resolve(false);
    const interval = (TF_MAP[tf] && TF_MAP[tf].binance) || "15m";
    barsInflight[key] = Binance.fetchKlines(inst.pair, interval, 120)
      .then((rows) => {
        state.bars[key] = klineToBars(rows);
        state.degraded = false;
        state.lastSync = Date.now();
        emit();
        return true;
      })
      .catch(() => {
        // R30: биржа не ответила — для ГРАФИКА рисуем честно помеченные синтетические
        // свечи (sim: true), но торговый движок по ним не работает (см. engineStep)
        const p = (state.prices[sym] && state.prices[sym].price) || DEFAULT_PRICES[sym] || 1;
        state.bars[key] = genSimBars(sym, p);
        emit();
        return false;
      })
      .then((res) => { delete barsInflight[key]; return res; });
    return barsInflight[key];
  }

  // R45: прогрев 15м-свечей для идей/сигналов — к моменту клика «Открыть в демо»
  // данные уже в кэше, вход происходит мгновенно и без ошибок
  function prewarmSignalBars() {
    for (const i of (state.aiIdeas || []).slice(0, 6)) ensureBars(i.sym, "15м");
    for (const g of (state.signals || []).slice(0, 8)) ensureBars(g.sym, "15м");
  }

  // R32: в серверном режиме каждое действие исполняется СЕРВЕРОМ (локально та же
  // логика — для мгновенного UI; сервер повторит авторитарно и вернёт свой архив)
  function placeDemo(p) {
    if (serverMode()) {
      return serverAction("open", {
        sym: p.sym, side: p.side, size: p.size, lev: p.lev || 1,
        stop: p.stop, target: p.target, strategy: p.strategy || "manual", ai: p.ai || null,
        id: p.id || null,
      }, () => placeDemoLocal(p));
    }
    return placeDemoLocal(p);
  }
  function placeDemoLocal(p) {
    if (!canTrade()) return { ok: false, error: "Сделки может открывать только аккаунт David или Yura" };
    const p0 = state.prices[p.sym];
    if (!p0 || !p0.price) return { ok: false, error: "Цена ещё не загружена — попробуйте через секунду" };
    if (!p0.ts || Date.now() - p0.ts > 120000) return { ok: false, error: "Цена по этой монете не обновляется — подождите или выберите другую" };
    const price = p0.price;
    const margin = Math.round(Number(p.size) || 0);
    if (!(margin > 0)) return { ok: false, error: "Некорректный размер сделки" };
    // ============ R53: ШОРТОВ НЕТ НИГДЕ — ДЕМО ПОВТОРЯЕТ РЕАЛЬНЫЙ РЫНОК 1:1 (зеркало сервера) ============
    // ИИ учится только на кейсах, осуществимых на споте OKX; старые открытые шорты
    // обслуживаются движком до закрытия
    if (p.side !== "лонг") return { ok: false, error: "Шортов больше нет — демо-торговля повторяет реальный рынок 1:1: спот OKX умеет только купить токен за USDT и продать его обратно. Дождитесь лонг-сигнала." };
    // ============ R52: РЕАЛЬНЫЙ РЫНОК — ТОЛЬКО ЛОНГИ В USDT ============
    if (state.mode === "live") {
      if (p.side !== "лонг") return { ok: false, error: "На реальном рынке шортов нет: спот OKX умеет только купить токен за USDT и продать его обратно" };
      if (!(state.okx && state.okx.on && state.okx.auto !== false)) return { ok: false, error: "Реальные сделки исполняются только при подключённом OKX и включённых авто-ордерах" };
      const avail = state.okx && Number.isFinite(state.okx.balanceUSDT) ? state.okx.balanceUSDT : null;
      if (avail == null) return { ok: false, error: "Баланс OKX ещё не синхронизирован — подождите минуту" };
      if (margin > avail) return { ok: false, error: `Недостаточно свободных USDT на бирже: доступно ${Fmt.fmtNum(avail, 2)} USDT` };
      const risk = price * 0.02;
      const posLive = {
        id: p.id || `u${Date.now()}`, owner: "user", strategy: p.strategy || "manual", sym: p.sym, side: "лонг",
        size: margin, lev: 1, entry: price,
        stop: p.stop || (price - risk),
        target: p.target || (price + risk * 2),
        r0: Math.abs(price - (p.stop || (price - risk))),
        openedAt: Date.now(),
        ai: p.ai || null,
        usdt: true, // R52: позиция реального рынка — в USDT
      };
      // баланс ХРЮ НЕ трогаем: на реальном рынке деньги — реальные USDT на бирже
      state.userPositions = [posLive, ...state.userPositions];
      pushEvent({
        tone: "bull",
        title: p.strategy === "ai" ? `ИИ открыл реальную сделку: ${p.sym} лонг${p.ai ? ` · уверенность ${p.ai.confidence}%` : ""}` : `Реальная сделка открыта: ${p.sym} лонг`,
        detail: `${Fmt.fmtNum(margin)} USDT · покупка ${p.sym} на OKX-споте идёт автоматически · цена ≈ ${Fmt.fmtPrice(price)}`,
        sym: p.sym,
        notify: (p.strategy === "ai" && p.ai && p.ai.auto) ? null : { kind: p.strategy === "ai" ? "ai_open" : "user_open" },
      });
      persist(); emit();
      return { ok: true, pos: posLive };
    }
    // ЛИМИТ 1: максимальная сумма одной сделки
    const dealCap = aiDealCap();
    if (margin > dealCap) return { ok: false, error: `Лимит одной сделки — ${Fmt.fmtNum(dealCap)} ХРЮ (≈ $${Fmt.fmtNum(dealCap)}). Уменьшите размер или поднимите лимит в настройках ИИ` };
    // ЛИМИТ 2: суммарная максимальная сумма всех сделок в рынке
    const totalCap = aiTotalCap();
    const inMarket = openPositionsSum();
    if (inMarket + margin > totalCap) return { ok: false, error: `Суммарный лимит сделок — ${Fmt.fmtNum(totalCap)} ХРЮ: в рынке уже ${Fmt.fmtNum(Math.round(inMarket))} ХРЮ, свободно ${Fmt.fmtNum(Math.round(Math.max(0, totalCap - inMarket)))} ХРЮ` };
    if (margin > state.balance) return { ok: false, error: `Недостаточно хрювен: свободно ${Fmt.fmtNum(state.balance)} ХРЮ` };
    const risk = price * 0.02; // стоп −2% по умолчанию (ИИ передаёт свои уровни)
    const pos = {
      id: `u${Date.now()}`, owner: "user", strategy: p.strategy || "manual", sym: p.sym, side: "лонг",
      size: margin, lev: 1, entry: price,
      stop: p.stop || (price - risk),
      target: p.target || (price + risk * 2),
      r0: Math.abs(price - (p.stop || (price - risk))), // исходный риск на единицу цены — база трейлинга
      openedAt: Date.now(),
      ai: p.ai || null,
    };
    // ХРЮ реально списываются со счёта в момент открытия
    state.balance -= margin;
    state.userPositions = [pos, ...state.userPositions];
    pushEvent({
      tone: "bull",
      title: p.strategy === "ai" ? `ИИ-сделка открыта: ${p.sym} лонг ×${pos.lev}` : `Демо-сделка открыта: ${p.sym} лонг ×${pos.lev}`,
      detail: `${Fmt.fmtNum(margin)} ХРЮ (≈ ${Fmt.fmtUsd(margin)}) по реальной цене ${price.toPrecision(6)}${p.ai ? ` · уверенность ИИ ${p.ai.confidence}%` : ""}`,
      sym: p.sym,
      // авто-вход оповещается отдельным событием «ИИ-автопилот вошёл» (см. aiOpenInternal)
      notify: (p.strategy === "ai" && p.ai && p.ai.auto) ? null : { kind: p.strategy === "ai" ? "ai_open" : "user_open" },
    });
    persist();
    emit();
    return { ok: true, pos };
  }

  function closeDemo(id) {
    if (serverMode()) {
      const pos = state.userPositions.find((p) => p.id === id);
      const price = pos ? ((state.prices[pos.sym] && state.prices[pos.sym].price) || pos.entry) : undefined;
      return serverAction("close", { id, exitPrice: price, reason: "Вручную" }, () => closeDemoLocal(id));
    }
    return closeDemoLocal(id);
  }
  function closeDemoLocal(id) {
    if (!canTrade()) return { ok: false, error: "Закрывать сделки может только аккаунт David или Yura" };
    const pos = state.userPositions.find((p) => p.id === id);
    if (!pos) return { ok: false, error: "Позиция не найдена" };
    const price = (state.prices[pos.sym] && state.prices[pos.sym].price) || pos.entry;
    const closed = Engine.closeTrade(pos, price, "Вручную");
    state.userPositions = state.userPositions.filter((p) => p.id !== id);
    state.userClosed = [closed, ...state.userClosed].slice(0, 300);
    if (state.mode !== "live") state.balance += pos.size + closed.pnl; // R52: live — USDT вернутся с биржи, ХРЮ не трогаем
    learnFromClosed(closed); // ИИ учится на результате
    pushEvent({
      tone: closed.pnl >= 0 ? "bull" : "bear",
      title: state.mode === "live"
        ? `Сделка закрыта: ${pos.sym} ${closed.pnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(closed.pnl)))} USDT`
        : `Демо-сделка закрыта: ${pos.sym} ${closed.pnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(closed.pnl)))} ХРЮ (≈ ${closed.pnl >= 0 ? "+" : "−"}$${Fmt.fmtNum(Math.abs(Math.round(closed.pnl)))})`,
      detail: state.mode === "live" ? `${closed.exitReason} · токен продаётся на OKX, USDT вернутся на баланс биржи` : closed.exitReason,
      sym: pos.sym,
      notify: { kind: "user_close", data: { pnl: closed.pnl } },
    });
    persist();
    emit();
    return { ok: true, closed };
  }

  function setBalance(v) {
    if (serverMode()) return serverAction("setBalance", { value: v }, () => setBalanceLocal(v));
    return setBalanceLocal(v);
  }
  function setBalanceLocal(v) {
    state.balance = v; state.startBalance = v;
    // ввод/вывод не должен считаться результатом сессии ИИ — перебазируем
    if (state.aiAuto && state.aiSession) state.aiSession.startEquity = totalEquity();
    // R54: честно объясняем, как лимиты подстраиваются под новый баланс
    const inMkt = Math.round(openPositionsSum());
    pushEvent({
      tone: "neutral",
      title: `Баланс установлен: ${Fmt.fmtNum(v)} ХРЮ`,
      detail: inMkt > 0
        ? `в рынке уже ${Fmt.fmtNum(inMkt)} ХРЮ, открыты при прежнем балансе — закроются по стопу/цели как обычно · новые входы встанут только на свободные ${Fmt.fmtNum(v)} ХРЮ и больше свободных денег не займут`
        : "все входы — ручные, сигнальные и автопилот — считаются от этого баланса: разовые сделки и суммарная нагрузка не превысят его",
    });
    persist(); emit();
  }

  function resetDemo() {
    if (serverMode()) return serverAction("resetDemo", {}, () => resetDemoLocal());
    return resetDemoLocal();
  }
  function resetDemoLocal() {
    state.balance = state.startBalance;
    state.userPositions = []; state.userClosed = [];
    state.labAccounts = Engine.mkLabAccounts();
    state.labPositions = []; state.labClosed = []; state.equityHist = [];
    state._ai = null;
    state.aiSession = { startEquity: totalEquity(), openedAt: Date.now() };
    state.aiStop = null;
    pushEvent({ tone: "neutral", title: "Демо-счёт сброшен", detail: "Все сделки и статистики обнулены · память ИИ сохранена" });
    persist(); emit();
  }

  function toggleAuto() {
    if (serverMode()) return serverAction("toggleAuto", {}, () => toggleAutoLocal());
    return toggleAutoLocal();
  }
  function toggleAutoLocal() { state.autoTrade = !state.autoTrade; persist(); emit(); }

  // ---------- режимы: демо / реальный рынок ----------
  function setMode(mode) {
    if (serverMode()) return serverAction("setMode", { mode, liveConnected: Boolean(window.Live && Live.isConnected()) }, () => setModeLocal(mode));
    return setModeLocal(mode);
  }
  function setModeLocal(mode) {
    if (mode === "live" && !(window.Live && Live.isConnected())) return { ok: false, error: "Сначала подключите кошелёк или ключи биржи" };
    if (state.mode === mode) return { ok: true };
    state.mode = mode;
    if (mode === "live") {
      // требование безопасности: в реальном режиме автопилот по умолчанию ВЫКЛ —
      // включить его можно только явным тумблером с подтверждением риска
      if (!state.aiAutoLive && state.aiAuto) {
        pushEvent({ tone: "neutral", title: "Автопилот отключён в реальном режиме", detail: "правило безопасности: на реальном рынке ИИ не торгует сам, пока вы явно не включите автопилот в блоке ИИ (и не подтвердите риск). Он продолжает подсказывать входы" });
      }
    }
    pushEvent({ tone: "neutral", title: mode === "live" ? "Включён реальный рынок" : "Включена демо-торговля", detail: mode === "live" ? "Ордера идут на биржу от вашего имени · средства на бирже" : "Виртуальные ХРЮ · реальные цены" });
    persist(); emit();
    return { ok: true };
  }

  function recordLiveOrder(order, note) {
    // R47: реальный ордер теперь и на СЕРВЕРЕ (история живёт в аккаунте, а не в
    // localStorage одного браузера; событие live_order уходит и пушем на устройства).
    // Аудит реального режима: раньше запись была только локальной — при смене
    // устройства/чистке браузера история реальных ордеров терялась безвозвратно.
    if (serverMode()) {
      return serverAction("liveOrder", { order, note: note || "" }, () => recordLiveOrderLocal(order, note));
    }
    return recordLiveOrderLocal(order, note);
  }
  function recordLiveOrderLocal(order, note) {
    state.liveOrders = [{ ...order, note: note || "", ts: Date.now() }, ...state.liveOrders].slice(0, 50);
    pushEvent({ tone: order.side === "лонг" ? "bull" : "bear", title: `Реальный ордер отправлен: ${order.sym} ${order.side === "лонг" ? "BUY" : "SELL"}`, detail: `${Fmt.fmtNum(Math.round(order.amountUSDT))} USDT · ${order.exchange}`, notify: { kind: "live_order" } });
    persist(); emit();
  }

  // ---------- ИИ-автопилот (спот-only) ----------
  // Спот без фьючерсов: ИИ заходит в любые монеты с потенциалом, мощная защита
  // от скама, флипает когда сам посчитает нужным, ультра-быстрые выходы.
  // Авто-стоп сессии: +лимит% профита или −лимит% просадки → автопилот закрывает ВСЕ ИИ-сделки
  // и выключается, ждёт возобновления. Лимит настраивается (по умолчанию 50%).
  const AI_MAX_POS = 5;      // максимум одновременных ИИ-позиций — дефолт (режим "вручную")
  const AI_MIN_SIZE = 10;    // минимальный разумный размер ИИ-сделки, ХРЮ
  function aiLimitPct() {    // текущий лимит сессии, % (кламп 5..500)
    const v = Number(state.aiThreshold);
    return Number.isFinite(v) ? Math.max(5, Math.min(500, v)) : 50;
  }
  // лимит одновременных ИИ-позиций (кламп 1..8)
  function aiMaxPos() {
    const v = Number(state.aiMaxPos);
    return Number.isFinite(v) ? Math.max(1, Math.min(8, Math.round(v))) : AI_MAX_POS;
  }

  // ================== ЛИМИТЫ СДЕЛОК (умная система) ==================
  // Два вводимых лимита: максимум на ОДНУ сделку и максимум на СУММУ всех сделок.
  // Число допустимых одновременных позиций из них выводится АВТОМАТИЧЕСКИ:
  // floor(суммарный лимит / лимит одной сделки). Лимит 25–50 при сделке до 25 → 1–2
  // одновременные сделки; чем больше суммарный лимит — тем больше параллельных входов.
  function aiDealCap() {     // максимум одной сделки (кламп 5..100000)
    const v = Number(state.maxDeal);
    return Number.isFinite(v) ? Math.max(5, Math.min(100000, Math.round(v))) : 1000;
  }
  function aiTotalCap() {    // максимум суммы всех сделок: настройка, но не больше реальных денег счёта
    // R54: суммарный лимит не бывает больше ВСЕХ денег счёта (свободные + вложенные в
    // позиции). Выставил баланс 100 ХРЮ — суммарный вход не превысит 100 ХРЮ: сделки
    // адаптируются под текущий баланс автоматически, что бы ни было в настройках.
    const v = Number(state.maxTotal);
    const d = aiDealCap();
    const setting = Number.isFinite(v) ? Math.max(d, Math.min(1000000, Math.round(v))) : Math.max(d, 5000);
    return Math.max(0, Math.min(setting, Math.ceil(totalMoney())));
  }
  function totalMoney() {    // R54: все деньги счёта — свободные + вложенные в позиции (маржа уже списана)
    if (state.mode === "live") {
      let v = state.okx && Number.isFinite(state.okx.balanceUSDT) ? state.okx.balanceUSDT : 0;
      for (const p of state.userPositions) if (p.live && p.live.qty) v += p.size || 0;
      for (const j of (Array.isArray(state.realQueue) ? state.realQueue : [])) if (j.kind === "buy") v += j.usdt || 0; // заявка в очереди — деньги уже вложены
      return v;
    }
    return state.balance + openPositionsSum();
  }
  function openPositionsSum() { // суммарная маржа всех открытых сделок счёта
    return state.userPositions.reduce((a, p) => a + (p.size || 0), 0);
  }
  function aiTotalRemain() { // свободный остаток суммарного лимита
    return Math.max(0, aiTotalCap() - openPositionsSum());
  }
  function autoMaxPos() {    // АВТОрасчёт числа одновременных позиций из лимитов
    return Math.max(1, Math.min(8, Math.floor(aiTotalCap() / aiDealCap())));
  }
  function effMaxPos() {     // действующий лимит: авто из лимитов или ручной 1..8
    if (state.aiPosMode !== "number" && state.aiPosMode !== 1 && state.aiPosMode !== 2 && state.aiPosMode !== 3 && state.aiPosMode !== 4 && state.aiPosMode !== 5 && state.aiPosMode !== 6 && state.aiPosMode !== 7 && state.aiPosMode !== 8) return autoMaxPos();
    return Math.max(1, Math.min(8, Math.round(Number(state.aiPosMode))));
  }
  function setMaxDeal(v) {
    if (serverMode()) return serverAction("set", { key: "maxDeal", value: v }, () => setMaxDealLocal(v));
    return setMaxDealLocal(v);
  }
  function setMaxDealLocal(v) {
    const n = Math.round(Number(String(v).replace(/\s/g, "").replace(",", ".")));
    if (!Number.isFinite(n) || n < 5 || n > 100000) return { ok: false, error: "Максимум одной сделки — от 5 до 100 000 ХРЮ" };
    state.maxDeal = n;
    if (Number(state.maxTotal) < n) state.maxTotal = n; // суммарный не бывает меньше лимита одной
    pushEvent({ tone: "neutral", title: `Лимит одной сделки: до ${Fmt.fmtNum(n)} ХРЮ (≈ $${Fmt.fmtNum(n)})`, detail: `суммарный лимит ${Fmt.fmtNum(aiTotalCap())} ХРЮ → до ${autoMaxPos()} одновременных сделок · действует на ручные, ИИ- и сигнальные входы` });
    persist(); emit();
    return { ok: true };
  }
  function setMaxTotal(v) {
    if (serverMode()) return serverAction("set", { key: "maxTotal", value: v }, () => setMaxTotalLocal(v));
    return setMaxTotalLocal(v);
  }
  function setMaxTotalLocal(v) {
    const n = Math.round(Number(String(v).replace(/\s/g, "").replace(",", ".")));
    const d = aiDealCap();
    if (!Number.isFinite(n) || n < d) return { ok: false, error: `Суммарный лимит не может быть меньше лимита одной сделки (${Fmt.fmtNum(d)} ХРЮ)` };
    if (n > 1000000) return { ok: false, error: "Суммарный лимит — не больше 1 000 000 ХРЮ" };
    state.maxTotal = n;
    pushEvent({ tone: "neutral", title: `Суммарный лимит всех сделок: ${Fmt.fmtNum(n)} ХРЮ (≈ $${Fmt.fmtNum(n)})`, detail: `при лимите одной сделки ${Fmt.fmtNum(d)} ХРЮ это до ${autoMaxPos()} одновременных позиций · автопилот не войдёт в новые сделки, когда сумма в рынке достигнет лимита` });
    persist(); emit();
    return { ok: true };
  }
  function setAiPosMode(v) {
    if (serverMode()) return serverAction("set", { key: "aiPosMode", value: v }, () => setAiPosModeLocal(v));
    return setAiPosModeLocal(v);
  }
  function setAiPosModeLocal(v) {
    if (v === "auto") {
      state.aiPosMode = "auto";
      pushEvent({ tone: "neutral", title: "Число ИИ-позиций: АВТО из лимитов", detail: `автопилот держит до ${autoMaxPos()} одновременных сделок (суммарный лимит ${Fmt.fmtNum(aiTotalCap())} ÷ лимит одной ${Fmt.fmtNum(aiDealCap())})` });
      persist(); emit();
      return { ok: true };
    }
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 1 || n > 8) return { ok: false, error: "Максимум одновременных ИИ-позиций — от 1 до 8" };
    state.aiPosMode = n;
    pushEvent({ tone: "neutral", title: `Ручной лимит ИИ-позиций: ${n}`, detail: `автопилот будет держать в рынке не больше ${n} ИИ-сделок одновременно · суммарный лимит ${Fmt.fmtNum(aiTotalCap())} ХРЮ всё равно ограничивает объём` });
    persist(); emit();
    return { ok: true };
  }
  function setAiMaxPos(v) { return setAiPosMode(v); } // совместимость со старыми вызовами

  // --- размер ИИ-сделки: четверть-Келли по обученному винрейту + все лимиты ---
  // R52: longOnly (реальный рынок) — применяем ЛОНГ-опыт ИИ (longTrades/longWins)
  function aiKellyFrac(longOnly) {
    const b = state.aiBrain || {};
    // сглаженный винрейт (Лаплас, априор 50%): пока сделок мало — размер консервативен
    const tr = longOnly ? (b.longTrades || 0) : (b.trades || 0);
    const wn = longOnly ? (b.longWins || 0) : (b.wins || 0);
    const p = (wn + 3) / (tr + 6);
    // Kelly для RR 1:2: f* = p − (1−p)/b, b=2 → f* = 1.5p − 0.5; берём четверть и кламп 2..10%
    const f = 1.5 * p - 0.5;
    return Math.max(0.02, Math.min(0.1, 0.25 * Math.max(0, f)));
  }
  function aiSizeCalc() {
    const cap = aiDealCap();
    const remain = aiTotalRemain();
    // R52: в live считаем размер от СВОБОДНЫХ USDT биржи (серверная синхронизация)
    // R53: келли от ЛОНГ-опыта во ВСЕХ режимах — демо повторяет реальный рынок 1:1
    const live = state.mode === "live";
    const okxBal = live && state.okx && Number.isFinite(state.okx.balanceUSDT) ? state.okx.balanceUSDT : null;
    const bal = live ? (okxBal != null ? okxBal : 0) : state.balance;
    let size = Math.round(bal * aiKellyFrac(true));
    size = Math.min(size, cap, Math.round(remain), Math.round(bal));
    const floor = Math.min(AI_MIN_SIZE, cap);
    if (!Number.isFinite(size) || size < floor) {
      if (bal >= floor && remain >= floor) size = floor;
      else return { size: 0, why: live ? "не хватает свободных USDT на OKX или суммарного лимита" : "не хватает свободных хрювен или суммарного лимита" };
    }
    if (size <= 0) return { size: 0, why: live && okxBal == null ? "баланс OKX ещё не синхронизирован" : "нулевой размер" };
    return { size, why: "ок" };
  }
  function setAiThreshold(v) {
    if (serverMode()) return serverAction("set", { key: "aiThreshold", value: v }, () => setAiThresholdLocal(v));
    return setAiThresholdLocal(v);
  }
  function setAiThresholdLocal(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 5 || n > 500) return { ok: false, error: "Лимит сессии — от 5% до 500%" };
    state.aiThreshold = n;
    pushEvent({ tone: "neutral", title: `Лимит сессии ИИ изменён: ±${n}%`, detail: "Автопилот закроет все ИИ-сделки и выключится при +" + n + "% профита или −" + n + "% просадки от базы сессии" });
    persist(); emit();
    return { ok: true };
  }

  // R29 «провальный порог»: авто-закрытие в минусе ТОЛЬКО когда ход против сделки
  // превысил тело (плановый риск) ещё на N%. 50% по умолчанию: временный откат и
  // фитиль за стоп-линией сделку не закрывают — она ждёт цели; закрывается только
  // очевидно провальный ход. 0% возвращает классический стоп, 100%+ — очень терпеливый ИИ.
  function setFailPct(v) {
    if (serverMode()) return serverAction("set", { key: "failPct", value: v }, () => setFailPctLocal(v));
    return setFailPctLocal(v);
  }
  function setFailPctLocal(v) {
    const n = Math.round(Number(String(v).replace(/\s/g, "").replace(",", ".")));
    if (!Number.isFinite(n) || n < 0 || n > 200) return { ok: false, error: "Провальный порог — от 0 до 200% от тела сделки" };
    state.failPct = n;
    pushEvent({
      tone: "neutral",
      title: `Провальный порог изменён: тело +${n}%`,
      detail: n === 0
        ? "классический режим: сделка закрывается сразу за стоп-линией (старое поведение)"
        : `сделка в минусе живёт и ждёт цель; авто-закрытие только когда ход против неё глубже стопа ещё на ${n}% от тела · трейлинг в плюсе и цели работают как раньше · правило действует и в Страже (синхронизируется в облако)`,
    });
    persist(); emit();
    return { ok: true };
  }
  function scamFilter(sym) {
    const p = state.prices[sym];
    if (!p || !p.price) return { ok: false, why: "нет цены" };
    if (!p.ts || Date.now() - p.ts > 120000) return { ok: false, why: "цена не обновляется" };
    if (p.vol24 && p.vol24 < 3e6) return { ok: false, why: `низкий объём $${(p.vol24 / 1e6).toFixed(1)}M` };
    if (Math.abs(p.chg24h) > 35) return { ok: false, why: `аномалия 24ч ${p.chg24h > 0 ? "+" : "−"}${Math.abs(p.chg24h).toFixed(0)}%` };
    return { ok: true };
  }

  // новостная защита: сильный медвежий фон по монете или рынку — вход запрещён
  function newsGuard(sym) {
    if (!state.news.items || !state.news.items.length) return { ok: true, why: "" };
    const ns = Engine.newsSentiment(state.news.items, sym);
    if (ns.coinItems && ns.coin <= -0.55) return { ok: false, why: `новостной риск: медвежий фон по ${sym}` };
    if (ns.fresh && ns.global <= -0.7) return { ok: false, why: "новостной риск: медвежий фон всего рынка" };
    return { ok: true, why: "" };
  }

  function combineGuard(sym) {
    const g = scamFilter(sym);
    if (!g.ok) return g;
    const ng = newsGuard(sym);
    if (!ng.ok) return ng;
    return { ok: true, why: "ок" };
  }

  // риск-гвард по самому расчёту ИИ: волатильность, вспышки и ОКУПАЕМОСТЬ комиссии
  function riskGuard(res) {
    if (!res) return { ok: false, why: "нет расчёта" };
    // взрывная волатильность: риск на сделку шире 6% цены — соотношение не удержать
    if (res.riskPct > 6) return { ok: false, why: `волатильность взрывная: риск ${res.riskPct.toFixed(1)}% на 15м-бар` };
    // мёртвый рынок: ход меньше ~полпроцента не окупает круговую комиссию 0.1% и состоит
    // из шума — ИИ входит только туда, где стоп и цель БОЛЬШЕ издержек (кейс JUP:
    // риск 0.47%, ход +0.05% → «профитная» по направлению сделка закрылась в минус после комиссии)
    if (res.riskPct < 0.45) return { ok: false, why: `ход слишком мал (${res.riskPct.toFixed(2)}%): круговая комиссия 0.1% съест результат` };
    // чистое соотношение после комиссии обязано оставаться ≥ 1.5: (2R − 0.1%) / (R + 0.1%)
    const netRR = ((res.targetPct || 0) - 0.1) / ((res.riskPct || 0) + 0.1);
    if (!(netRR >= 1.5)) return { ok: false, why: `с учётом комиссии 0.1% соотношение цель/риск всего ${netRR.toFixed(2)} — вход не окупается` };
    // вспышка/памп-дамп: последняя свеча аномально шире ATR — ждём успокоения
    if (res.flashRatio > 3.5) return { ok: false, why: `аномальная свеча ×${res.flashRatio.toFixed(1)} к ATR — вспышка или манипуляция` };
    return { ok: true, why: "ок" };
  }

  // перегрев портфеля: больше 60% ВСЕХ денег счёта в позициях — новых входов нет
  function heatGuard() {
    // R54: база — все деньги (свободные + вложенные), единообразно демо и live:
    // перегрев = доля денег, сидящая в позициях, а не доля свободного остатка
    const bal = totalMoney();
    const inMarket = openPositionsSum();
    if (bal > 0 && inMarket / bal > 0.6) return { ok: false, why: `портфель перегрет: ${Math.round((inMarket / bal) * 100)}% денег в позициях` };
    return { ok: true, why: "ок" };
  }

  // серия минусов ИИ-сделок подряд (по последним закрытиям)
  function aiLossStreak() {
    let n = 0;
    for (const c of state.userClosed) {
      if (c.strategy !== "ai") continue;
      if (c.pnl < 0) n++; else break;
    }
    return n;
  }

  // китовый перевес по монете за последний час (для фактора «Киты»)
  function aiWhaleBias(sym) {
    const list = state.whales[sym];
    if (!list || !list.length) return null;
    const now = Date.now();
    let buy = 0, sell = 0;
    for (const w of list) {
      if (!w.time || now - w.time > 60 * 60000) continue;
      if (w.side === "buy") buy += w.notional; else sell += w.notional;
    }
    const total = buy + sell;
    if (total < 50000) return null; // мало данных — фактор не учитываем
    const net = buy - sell;
    const dir = Math.max(-1, Math.min(1, net / 200000));
    if (Math.abs(dir) < 0.08) return null; // перевес слишком мал
    return {
      dir,
      detail: `за час перевес ${net > 0 ? "покупок" : "продаж"} китов $${Fmt.fmtNum(Math.round(Math.abs(net) / 1000))}K из $${Fmt.fmtNum(Math.round(total / 1000))}K оборота`,
    };
  }

  // ------- сессия автопилота: сколько ИИ наторговал с её старта -------
  function aiSessionInfo() {
    const sess = state.aiSession;
    if (!sess) return null;
    let pnl = 0, trades = 0;
    for (const c of state.userClosed) {
      if (c.strategy === "ai" && c.closedAt >= sess.openedAt) { pnl += c.pnl; trades++; }
    }
    let open = 0;
    for (const p of state.userPositions) {
      if (p.strategy !== "ai") continue;
      open++;
      pnl += Engine.positionPnl(p, (state.prices[p.sym] && state.prices[p.sym].price) || p.entry).pnl;
    }
    const pct = sess.startEquity > 0 ? (pnl / sess.startEquity) * 100 : 0;
    return { pnl, pct, trades, open, startBase: sess.startEquity };
  }

  // закрыть ВСЕ ИИ-позиции по рынку (при авто-стопе сессии — и удачные, и неудачные)
  function closeAllAiPositions(reason) {
    const positions = state.userPositions.filter((p) => p.strategy === "ai");
    const out = [];
    for (const pos of positions) {
      const price = (state.prices[pos.sym] && state.prices[pos.sym].price) || pos.entry;
      const closed = Engine.closeTrade(pos, price, reason);
      state.userPositions = state.userPositions.filter((p) => p.id !== pos.id);
      state.userClosed = [closed, ...state.userClosed].slice(0, 300);
      if (state.mode !== "live") state.balance += closed.size + closed.pnl; // R52: live — без ХРЮ
      learnFromClosed(closed); // ИИ учится и на принудительных закрытиях
      out.push(closed);
    }
    return out;
  }

  // авто-стоп: результат сессии достиг ±лимита → закрыть все ИИ-сделки, выключить автопилот, ждать возобновления
  function aiSessionCheck() {
    if (!effAuto() || !state.aiSession) return;
    const info = aiSessionInfo();
    if (!info) return;
    const th = aiLimitPct();
    if (Math.abs(info.pct) < th) return;
    const isProfit = info.pct > 0;
    const closedList = closeAllAiPositions(isProfit ? "Авто-стоп сессии: фиксация результата" : "Авто-стоп сессии: защита капитала");
    const sumPnl = closedList.reduce((a, c) => a + c.pnl, 0);
    state.aiAuto = false;
    state.aiStop = { reason: isProfit ? "profit" : "loss", pct: info.pct, ts: Date.now(), threshold: th, closed: closedList.length };
    pushEvent({
      tone: isProfit ? "bull" : "bear",
      title: isProfit
        ? `Авто-стоп сессии ИИ: +${info.pct.toFixed(1)}% ≥ +${th}%`
        : `Авто-стоп сессии ИИ: ${info.pct.toFixed(1)}% ≤ −${th}%`,
      detail: (isProfit
        ? `ИИ наторговал ${Fmt.fmtNum(Math.round(info.pnl))} ХРЮ (≈ $${Fmt.fmtNum(Math.abs(Math.round(info.pnl)))}) профита`
        : `просадка ${Fmt.fmtNum(Math.round(Math.abs(info.pnl)))} ХРЮ (≈ $${Fmt.fmtNum(Math.abs(Math.round(info.pnl)))})`)
        + ` — автопилот закрыл все ИИ-сделки по рынку (${closedList.length} шт., итог ${sumPnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(sumPnl)))} ХРЮ) и ждёт возобновления работы`,
      notify: { kind: "threshold", data: { pnl: info.pnl } },
    });
    persist();
    emit();
  }

  // ------- обучение: ГЛОБАЛЬНАЯ память растёт на КАЖДОЙ закрытой сделке -------
  // всех пользователей (David, Yura, будущие) во всех режимах: ИИ-сделки дают полную
  // картину (факторы + опыт по монете + калибровка порога), лабораторные — снапшот
  // факторов и опыт по монете (учат мозг вдвое медленнее), остальные — опыт по монете.
  function pushLesson(brain, text) {
    brain.lessons = [{ ts: Date.now(), text }, ...brain.lessons].slice(0, 24);
  }

  function learnFromClosed(c, isLab) {
    if (!c) return;
    const brain = state.aiBrain;
    const isAi = c.strategy === "ai"; // у не-ИИ сделок нет снапшота факторов (кроме лаборатории)
    const labTrade = Boolean(isLab || (c.ai && c.ai.lab));
    const hasFactors = Boolean(c.ai && Array.isArray(c.ai.factors) && c.ai.factors.length);
    const won = c.pnl >= 0;
    if (isAi) {
      brain.trades++; if (won) brain.wins++; else brain.losses++;
      // R52: ЛОНГ-ОПЫТ отдельно — валюта решений реального рынка (спот OKX, только лонги)
      if (!labTrade && c.side === "лонг") {
        brain.longTrades = (brain.longTrades || 0) + 1;
        if (won) brain.longWins = (brain.longWins || 0) + 1;
      }
    }

    // 1) надёжность факторов — по сделкам со снапшотом факторов (ИИ-сделки и лаборатория).
    //    Лаборатория учит вдвое медленнее: её вход решает стратегия, а не ансамбль.
    if (hasFactors) {
      // итоговое направление рынка с точки зрения сделки: лонг×профит или шорт×убыток = вверх
      const sideSign = c.side === "лонг" ? 1 : -1;
      const outcomeSign = sideSign * (won ? 1 : -1);
      const stepUp = labTrade ? 0.022 : 0.045;
      const stepDn = labTrade ? 0.037 : 0.075;
      for (const f of c.ai.factors) {
        if (!f || !f.key || !f.dir) continue; // нейтральный вклад не оцениваем
        const agree = (f.dir > 0 ? 1 : -1) === outcomeSign;
        const cur = brain.rel[f.key] == null ? 1 : brain.rel[f.key];
        const next = Math.max(0.55, Math.min(1.5, cur + (agree ? stepUp : -stepDn) * Math.min(1, Math.abs(f.dir))));
        brain.rel[f.key] = next;
      }
      // пересчёт адаптивных весов (нормировка к 1)
      const base = Engine.AI_BASE_WEIGHTS;
      let sum = 0;
      const weights = {};
      for (const k in base) { weights[k] = base[k] * (brain.rel[k] == null ? 1 : brain.rel[k]); sum += weights[k]; }
      if (sum > 0) for (const k in weights) weights[k] = weights[k] / sum;
      brain.weights = weights;
      // уроки: заметные сдвиги весов (не чаще одного на направление по фактору)
      const labels = { trend: "Тренд", rsi: "RSI", macd: "MACD", bb: "Боллинджер", ichi: "Ишимоку", vol: "Объём", roc: "Импульс", news: "Новости", adx: "ADX", stoch: "Стохастик", htf: "Старший ТФ", whale: "Киты", glm: "GLM" };
      for (const k in base) {
        const d = weights[k] / base[k] - 1;
        if (Math.abs(d) < 0.1) continue;
        const flag = k + (d < 0 ? "dn" : "up");
        if (brain.wFlags[flag]) continue;
        brain.wFlags[flag] = 1;
        pushLesson(brain, d < 0
          ? `ослабил «${labels[k] || k}» (${base[k].toFixed(2)} → ${weights[k].toFixed(2)}): фактор ошибался в похожих сделках`
          : `усилил «${labels[k] || k}» (${base[k].toFixed(2)} → ${weights[k].toFixed(2)}): фактор чаще других был прав`);
      }
    }

    // 1b) уроки лаборатории: связка «стратегия × монета» принесла минус — мозг это запоминает
    if (labTrade && !won) {
      const strat = Engine.STRATEGIES.find((x) => x.id === c.strategy);
      const flag = `lab-${c.strategy}-${c.sym}-loss`;
      if (strat && !brain.wFlags[flag] && Math.abs(c.pnlPct || 0) >= 1) {
        brain.wFlags[flag] = 1;
        pushLesson(brain, `лаборатория: стратегия «${strat.short}» получила минус на ${c.sym} (${(c.pnlPct || 0).toFixed(1)}%) — связка под наблюдением`);
      }
    }

    // 2) опыт по монете — на ВСЕХ сделках (ИИ, лаборатория, сигнал, ручная) всех
    //    пользователей: любая закрытая сделка что-то говорит о поведении монеты
    //    R52: + под-статистики по направлениям (long/short) — лонг-опыт применяется
    //    на реальном рынке в первую очередь
    const st = brain.symStats[c.sym] || { n: 0, wins: 0, streak: 0, avgPct: 0 };
    st.n++;
    if (won) { st.wins++; st.streak = st.streak < 0 ? 1 : st.streak + 1; }
    else { st.streak = st.streak > 0 ? -1 : st.streak - 1; }
    st.avgPct = (st.avgPct * (st.n - 1) + (c.pnlPct || 0)) / st.n;
    const sk = c.side === "шорт" ? "short" : "long";
    const d = st[sk] = st[sk] || { n: 0, wins: 0, streak: 0, avgPct: 0 };
    d.n++;
    if (won) { d.wins++; d.streak = d.streak < 0 ? 1 : d.streak + 1; }
    else { d.streak = d.streak > 0 ? -1 : d.streak - 1; }
    d.avgPct = (d.avgPct * (d.n - 1) + (c.pnlPct || 0)) / d.n;
    brain.symStats[c.sym] = st;
    const sFlag = c.sym + "-streak" + st.streak;
    if (st.streak <= -3 && st.n >= 4 && !brain.wFlags[sFlag]) {
      brain.wFlags[sFlag] = 1;
      pushLesson(brain, `осторожнее с ${c.sym}: ${Math.abs(st.streak)} минуса подряд — уверенность на этой монете снижена`);
    }

    // 3) калибровка порога входа — по ОКНУ последних 12 ИИ-сделок, а НЕ по всей истории.
    //    РАНЬШЕ (баг R28): винрейт считался за ВСЁ время — эпидемия минусов R26–R27
    //    испортила статистику навсегда, порог полз вверх на каждом минусе (до 88) и
    //    уже не мог вернуться: при 88 уверенность ансамбля почти недостижима, автопилот
    //    замерал («не открывает сам сделки, только лабораторные» — кейс пользователя),
    //    а лаборатория, которой порог не нужен, торговала. Окно само исцеляется: старые
    //    минусы выходят из окна, и порог честно возвращается вниз.
    if (isAi) {
      const win = [];
      for (const c of state.userClosed) {
        if (c.strategy !== "ai") continue;
        win.push(c.pnl >= 0 ? 1 : 0);
        if (win.length >= 12) break;
      }
      if (win.length >= 6) {
        const wrW = win.reduce((a, b) => a + b, 0) / win.length;
        if (wrW < 0.4 && brain.confThreshold < 80) {
          brain.confThreshold++;
          pushLesson(brain, `поднял порог входа до ${brain.confThreshold}%: в последнем окне сделок профитов меньше 40%`);
        } else if (wrW >= 0.6 && brain.confThreshold > 74) {
          brain.confThreshold--;
          pushLesson(brain, `снизил порог входа до ${brain.confThreshold}%: качество последних сделок хорошее`);
        }
      }
    }
    brain.updatedAt = Date.now();
    saveGlobalBrainLocal(); // глобальная память: сразу на устройство (общая для всех аккаунтов)
    scheduleBrainPush();    // и в облако (debounce 4с) — чтобы все пользователи и устройства имели один мозг
    persist();
  }

  // сдвиг уверенности по опыту монеты: серия минусов — осторожнее, серия плюсов — чуть смелее
  // R52: опыт по НАПРАВЛЕНИЯМ — на реальном рынке (только лонги) применяем лонг-стрик
  function symBias(sym, side) {
    const st = state.aiBrain.symStats[sym];
    if (!st || st.n < 3) return 0;
    const d = side === "лонг" ? st.long : side === "шорт" ? st.short : null;
    const use = d && Number(d.n) >= 3 ? d : st;
    if (use.streak >= 3) return 3;
    if (use.streak <= -3) return -Math.min(10, 2 * Math.abs(use.streak));
    return 0;
  }

  function updateIdeas(sym, res, guard) {
    // R53: шорт-идей не существует НИГДЕ (демо повторяет реальный рынок 1:1, спот OKX)
    const rest = state.aiIdeas.filter((i) => i.sym !== sym);
    if (res.verdict !== "wait" && res.verdict !== "шорт") rest.push({ sym, res, guard, ts: Date.now() });
    rest.sort((a, b) => b.res.confidence - a.res.confidence);
    state.aiIdeas = rest.slice(0, 8);
  }

  function aiOpenInternal(res, size, isAuto, guardWhy) {
    const out = placeDemo({
      sym: res.sym, side: res.verdict, size, lev: 1,
      stop: res.stop, target: res.target, strategy: "ai",
      ai: { confidence: res.confidence, note: res.note, auto: !!isAuto, factors: res.factors, score: res.score },
    });
    if (out.ok && isAuto) {
      pushEvent({
        tone: res.verdict === "лонг" ? "bull" : "bear",
        title: `ИИ-автопилот вошёл: ${res.sym} ${res.verdict} ${res.confidence}%`,
        detail: state.mode === "live"
          ? `${Fmt.fmtNum(size)} USDT · покупка на OKX идёт автоматически · защита: ${guardWhy} · стоп/цель по ATR`
          : `${Fmt.fmtNum(size)} ХРЮ (≈ ${Fmt.fmtUsd(size)}) · спот · защита: ${guardWhy} · стоп/цель по ATR`,
        sym: res.sym,
        notify: { kind: "ai_open" },
      });
    }
    return out;
  }

  // ---- гейт флипа: можно ли разворачивать позицию (требование 12 — защита от флипа убытка) ----
  // Возвращает { ok, floatPct, riskPct0 }: флип запрещён позиции младше 15 минут,
  // позиции в убытке глубже 60% пути к стопу, развороту слабее входа и разноголосым факторам.
  function flipAllowed(aiPos, res, effConf, thr, sym) {
    const ageMs = Date.now() - (aiPos.openedAt || 0);
    const price0 = (state.prices[sym] && state.prices[sym].price) || aiPos.entry;
    const floatPct = Engine.positionPnl(aiPos, price0).pct;
    const riskPct0 = aiPos.r0 && aiPos.entry ? ((aiPos.r0 / aiPos.entry) * 100) : (res.riskPct || 1);
    const flippedRecently = Boolean(state._flipAt && state._flipAt[sym] && Date.now() - state._flipAt[sym] < 45 * 60000);
    const ok = !flippedRecently
      && ageMs >= 15 * 60000
      && effConf >= Math.max(72, thr - 4)
      && res.confidence >= ((aiPos.ai && aiPos.ai.confidence) || thr) + 4
      && floatPct > -(riskPct0 * 0.6)
      && (res.agreeShare == null || res.agreeShare >= 0.6);
    return { ok, floatPct, riskPct0 };
  }

  // ================= АВТОПИЛОТ: раздельные флаги для демо и реального режима =================
  // В демо автопилот по умолчанию ВКЛ. В РЕАЛЬНОМ режиме (подключена биржа/кошелёк)
  // автопилот при первом входе ВСЕГДА ВЫКЛ (aiAutoLive=false): ИИ сканирует и подсказывает,
  // но сам не торгует — включить его можно только явным действием с подтверждением риска.
  function effAuto() { return state.mode === "live" ? !!state.aiAutoLive : !!state.aiAuto; }

  // R28: ТИХИЙ ЧАС ПО МОНЕТЕ после стопа ИИ — 4 часа без новых входов и флипов по этому
  // символу (выходы/трейлинг/цели продолжают обслуживаться). Повторно собирать стоп на
  // монете, где ИИ только что ошибся, — классика тильт-торговли; тайм-аут рвёт и эту
  // привычку, и каскады «один откат — несколько стопов по одной монете».
  const AI_STOP_BAN_MS = 4 * 3600e3;
  function noteAiStopBan(sym) {
    if (!sym) return;
    if (!state.aiBan || typeof state.aiBan !== "object") state.aiBan = {};
    const until = Date.now() + AI_STOP_BAN_MS;
    if (state.aiBan[sym] && state.aiBan[sym] >= until) return; // бан уже активен на тот же срок — без дублей в ленте
    state.aiBan[sym] = until;
    pushEvent({
      tone: "bear",
      title: `ИИ взял тайм-аут по ${sym} на 4 часа после стопа`,
      detail: "тихий час: новых входов и флипов по этой монете не будет, пока ИИ не перепроверит картину · открытые позиции и их защита (стоп/безубыток/цель) работают как обычно",
      sym,
    });
  }

  function aiAutoStep(sym, bars) {
    if (!effAuto() || !bars || bars.length < 60) return;

    // сессия автопилота: ленивое создание базы + авто-стоп при ±лимите
    if (!state.aiSession) state.aiSession = { startEquity: totalEquity(), openedAt: Date.now() };
    aiSessionCheck();
    if (!effAuto()) return; // сессия только что остановилась

    const brain = state.aiBrain;
    const extra = {
      whale: aiWhaleBias(sym),                                                  // киты: лента aggTrades биржи
      onchain: (window.WhalesDB && WhalesDB.bias) ? WhalesDB.bias(sym) : null,  // ончейн-киты (база кошельков)
      glm: (window.GLM && GLM.factor) ? GLM.factor(sym) : null,                 // GLM-аналитик (13-й фактор)
    };
    const res = Engine.aiAnalyze(sym, bars, brain, state.news.items, extra);
    if (!res) return;
    const guard = combineGuard(sym);
    const rg = riskGuard(res);
    updateIdeas(sym, res, !guard.ok ? guard : !rg.ok ? rg : heatGuard());

    // R28: ТИХИЙ ЧАС ПО МОНЕТЕ после стопа ИИ — ни новых входов, ни флипов по этому символу.
    // Один и тот же сценарий (LINK, SOL) больше не будет собирать стопы повторно: монета,
    // на которой ИИ только что ошибся, заслуживает паузу — картина факторов после стопа
    // часто ещё «за» вход, но рынок уже показал, что расчёт неверен.
    if (!state.aiBan || typeof state.aiBan !== "object") state.aiBan = {};
    if (state.aiBan[sym] && Date.now() >= state.aiBan[sym]) delete state.aiBan[sym]; // срок вышел — тихий час честно истёк
    if (state.aiBan[sym]) return;

    const aiPos = state.userPositions.find((p) => p.sym === sym && p.strategy === "ai");
    const aiCount = state.userPositions.filter((p) => p.strategy === "ai").length;
    const thr = brain.confThreshold || 74;
    const effConf = res.confidence + symBias(sym); // уверенность с поправкой на опыт монеты

    // флип: ИИ сам считает нужным развернуться (спот: продажа/выход в кэш).
    // Флип — реакция на РАЗВОРОТ картины факторов, а НЕ способ выйти из убытка:
    // гейт flipAllowed запрещает закрывать флипом убыточную позицию раньше стопа.
    if (aiPos && res.verdict !== "wait" && res.verdict !== aiPos.side) {
      // R53: шорт-вердикт в ЛЮБОМ режиме = выход из лонга (шорт не открываем)
      const shortExit = res.verdict === "шорт";
      const fg = flipAllowed(aiPos, res, effConf, thr, sym);
      if (fg.ok) {
        const price0 = (state.prices[sym] && state.prices[sym].price) || aiPos.entry;
        const closed = Engine.closeTrade(aiPos, price0, shortExit ? "ИИ-выход (разворот вниз)" : "ИИ-флип");
        state.userPositions = state.userPositions.filter((p) => p.id !== aiPos.id);
        state.userClosed = [closed, ...state.userClosed].slice(0, 300);
        if (state.mode !== "live") state.balance += closed.size + closed.pnl; // R52: live — без ХРЮ
        learnFromClosed(closed);
        state._flipAt = { ...(state._flipAt || {}), [sym]: Date.now() };
        pushEvent({
          tone: "bear",
          title: shortExit
            ? `ИИ вышел из лонга ${sym}: факторы развернулись вниз`
            : `ИИ флипнул ${sym}: ${aiPos.side} → ${res.verdict}`,
          detail: state.mode === "live"
            ? `закрыто по ${closed.pnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(closed.pnl)))} USDT · шорт на споте невозможен — выходим в кэш, токен продаётся на OKX`
            : `закрыто по ${closed.pnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(closed.pnl)))} ХРЮ (≈ ${closed.pnl >= 0 ? "+" : "−"}$${Fmt.fmtNum(Math.abs(Math.round(closed.pnl)))}) · ${shortExit ? "шортов больше нигде нет — выходим в кэш" : `разворот факторов (уверенность ${res.confidence}%)`}`, sym,
          notify: { kind: "ai_flip", data: { pnl: closed.pnl } },
        });
        if (!shortExit) {
          const sc = aiSizeCalc();
          if (guard.ok && rg.ok && sc.size > 0) {
            aiOpenInternal(res, sc.size, true, "скам-фильтр, новости и риск-гвард ок");
            state._aiLastEntryAt = Date.now();
            state.aiLastEntryTs = Date.now(); // R28: флип-вход тоже считается входом автопилота
          }
        }
        persist();
        return;
      }
    }

    // серия минусов: принудительная пауза автопилота на 30 минут (защита от тильт-режима).
    // Выходы и флипы продолжают обслуживаться — пауза только на НОВЫЕ входы.
    // ВАЖНО: пауза ставится ОДИН РАЗ на серию. Раньше условие смотрело в хвост истории:
    // три минуса оставались последними ИИ-сделками навсегда (новые входы заблокированы —
    // сбросить серию нечем), и каждые 30 минут пауза продлевала сама себя — бесконечный
    // цикл «ИИ больше никогда не торгует» (кейс пользователя: автопилот включён, а
    // сделки не открываются, в Событиях пауза повторяется). Теперь повторная пауза
    // ставится только если серия СТАЛА ДЛИННЕЕ зафиксированной: после паузы автопилот
    // снова торгует, а новый минус (уже открытая и закрытая сделка) удлиняет серию.
    const streakNow = aiLossStreak();
    if (streakNow < (state.aiCooldownSeen || 0)) state.aiCooldownSeen = streakNow; // серия сброшена плюсом — счётчик паузы обнулён
    if (streakNow >= 3 && streakNow > (state.aiCooldownSeen || 0)) {
      state.aiCooldownUntil = Date.now() + 30 * 60000;
      state.aiCooldownSeen = streakNow;
      pushEvent({
        tone: "bear",
        title: "ИИ взял паузу на 30 минут: " + streakNow + " минуса подряд",
        detail: "защита от серии убытков: новые входы приостановлены, открытые позиции обслуживаются (стопы, безубыток, цели) · после паузы автопилот вернётся к работе сам",
        notify: { kind: "autopilot", data: { on: true } },
      });
      persist();
      return;
    }
    if (Date.now() < (state.aiCooldownUntil || 0)) return;

    // R28: АНТИ-ЗАМОРОЗКА порога входа. Порог, задранный плохой историей, теперь снижается
    // сам при простое: если автопилот включён, но НЕ открывал сделок больше 8 часов, раз в
    // 2 часа порог аккуратно опускается на 2 пункта до базовых 74 (запрос пользователя:
    // уверенность выше 74% — вход открывается сам). Торговля возобновляется быстро,
    // а калибровка на окне сделок дальше ведёт порог честно.
    const thrNow = brain.confThreshold || 74;
    if (thrNow > 74 && (state.aiLastEntryTs || 0) > 0 && Date.now() - state.aiLastEntryTs > 8 * 3600e3 && Date.now() - (state.aiRelaxAt || 0) > 2 * 3600e3) {
      brain.confThreshold = Math.max(74, thrNow - 2);
      state.aiRelaxAt = Date.now();
      pushLesson(brain, `долго без новых входов (${Math.round((Date.now() - state.aiLastEntryTs) / 3600e3)} ч) — снизил порог входа до ${brain.confThreshold}%: строгий фильтр не должен замораживать торговлю`);
      persist();
    }

    // вход: уверенность ≥ обученного порога + факторы односторонни + все гварды + лимиты позиций и сумм.
    // РАЗГОНКА ВХОДОВ (ослаблена R29): не чаще одного нового входа автопилота в 4 минуты —
    // разнесённые во времени входы не дают одному общему импульсу рынка набить портфель
    // одинаковыми лонгами, но при этом автопилот успевает набрать позицию в рамках лимитов
    // (раньше окно было 8 минут — пользователь просил торговать активнее, «да побольше»)
    if (Date.now() - (state._aiLastEntryAt || 0) < 4 * 60000) return;
    // R53: шорт-вход невозможен нигде (демо = реальный рынок 1:1, спот OKX) —
    // идея не создаётся (фильтр в updateIdeas), вход не открывается
    if (res.verdict === "шорт") return;
    if (!aiPos && res.verdict !== "wait" && effConf >= thr && (res.agreeShare == null || res.agreeShare >= 0.55) && aiCount < effMaxPos()) {
      if (!guard.ok || !rg.ok) return;
      if (!heatGuard().ok) return;
      const sc = aiSizeCalc();
      if (sc.size <= 0) return;
      aiOpenInternal(res, sc.size, true, "скам-фильтр, новости и риск-гвард ок");
      state._aiLastEntryAt = Date.now();
      state.aiLastEntryTs = Date.now(); // R28: метка для анти-заморозки порога (персистентна)
      persist();
    }
  }

  function toggleAiAuto(forceOn) {
    if (serverMode()) return serverAction("toggleAiAuto", { forceOn: forceOn === true }, () => toggleAiAutoLocal(forceOn));
    return toggleAiAutoLocal(forceOn);
  }
  function toggleAiAutoLocal(forceOn) {
    // переключаем флаг ТЕКУЩЕГО режима: демо и реальный независимы
    if (state.mode === "live") {
      const turningOn = forceOn === true ? true : !state.aiAutoLive;
      state.aiAutoLive = turningOn;
      if (turningOn) {
        state.aiSession = { startEquity: totalEquity(), openedAt: Date.now() };
        state.aiStop = null;
        pushEvent({ tone: "neutral", title: "ИИ-автопилот ВКЛЮЧЁН в реальном режиме (вы явно разрешили)", detail: `симуляция на реальных ценах: входы списывают виртуальные ХРЮ, реальные ордера по-прежнему отправляются только вручную · авто-стоп ±${aiLimitPct()}%`, notify: { kind: "autopilot", data: { on: true } } });
      } else {
        pushEvent({ tone: "neutral", title: "ИИ-автопилот выключен в реальном режиме", detail: "ИИ продолжает сканировать и подсказывать входы — ордера отправляете вы", notify: { kind: "autopilot", data: { on: false } } });
      }
    } else {
      state.aiAuto = forceOn === true ? true : !state.aiAuto;
      if (state.aiAuto) {
        // возобновление работы: новая сессия с чистой базой и текущим лимитом
        state.aiSession = { startEquity: totalEquity(), openedAt: Date.now() };
        state.aiStop = null;
        pushEvent({ tone: "neutral", title: "ИИ-автопилот включён: новая сессия", detail: `авто-стоп при +${aiLimitPct()}% профита или −${aiLimitPct()}% просадки (≈ $${Fmt.fmtNum(Math.round(state.aiSession.startEquity * aiLimitPct() / 100))} к базе) · база ${Fmt.fmtNum(Math.round(state.aiSession.startEquity))} ХРЮ`, notify: { kind: "autopilot", data: { on: true } } });
      } else {
        pushEvent({ tone: "neutral", title: "ИИ-автопилот выключен", detail: "ИИ только сканирует и подсказывает", notify: { kind: "autopilot", data: { on: false } } });
      }
    }
    persist(); emit();
  }

  function totalEquity() {
    // R52: в live капитал — реальные USDT на бирже + плавающий PnL позиций
    if (state.mode === "live") {
      let v = state.okx && Number.isFinite(state.okx.balanceUSDT) ? state.okx.balanceUSDT : 0;
      for (const p of state.userPositions) {
        const price = (state.prices[p.sym] && state.prices[p.sym].price) || p.entry;
        v += Engine.positionPnl(p, price).pnl;
      }
      return v;
    }
    let v = state.balance;
    for (const p of state.userPositions) {
      const price = (state.prices[p.sym] && state.prices[p.sym].price) || p.entry;
      v += p.size + Engine.positionPnl(p, price).pnl;
    }
    return v;
  }

  function loadWhales(sym) {
    const inst = BY_SYM[sym];
    if (!inst) return;
    if (state.whaleScannedAt[sym] && Date.now() - state.whaleScannedAt[sym] < 20000) return;
    Binance.fetchAggTrades(inst.pair, 500)
      .then((trades) => {
        const whales = trades
          .map((t) => ({ id: t.id, sym, price: t.price, qty: t.qty, notional: t.price * t.qty, time: t.time, side: t.isBuyerMaker ? "sell" : "buy" }))
          .filter((t) => t.notional >= 15000)
          .slice(0, 40);
        state.whales = { ...state.whales, [sym]: whales };
        state.whaleScannedAt = { ...state.whaleScannedAt, [sym]: Date.now() };
        for (const w of whales.slice(0, 4)) {
          if (w.notional >= 150000) {
            pushEvent({
              tone: w.side === "buy" ? "bull" : "bear",
              title: `Кит ${w.side === "buy" ? "купил" : "продал"} ${sym} на $${Math.round(w.notional / 1000)}K`,
              detail: `по реальной рыночной цене $${w.price.toPrecision(6)} · лента aggTrades Binance`,
              sym,
            });
          }
        }
        emit();
      })
      .catch(() => {
        // нет API — синтетическая лента китов
        if (state.whales[sym] && state.whales[sym].length) return;
        const price = (state.prices[sym] && state.prices[sym].price) || DEFAULT_PRICES[sym] || 1;
        const rand = Candles.rng(sym.length * 977 + Math.floor(Date.now() / 60000));
        const whales = [];
        for (let i = 0; i < 14; i++) {
          const notional = 15000 + Math.pow(rand(), 2.6) * 320000;
          const px = price * (1 + (rand() - 0.5) * 0.01);
          whales.push({
            id: 1000000 + i, sym, price: px,
            qty: notional / px, notional, time: Date.now() - Math.floor(rand() * 3_600_000),
            side: rand() > 0.48 ? "buy" : "sell",
          });
        }
        whales.sort((a, b) => b.time - a.time);
        state.whales = { ...state.whales, [sym]: whales };
        state.whaleScannedAt = { ...state.whaleScannedAt, [sym]: Date.now() };
        emit();
      });
  }

  // ---------- шаг движка по одному инструменту ----------
  let lastSignalKey = "";
  function engineStep(sym, bars) {
    if (!bars || !bars.length) return;
    // R30: ТОРГОВЛЯ ТОЛЬКО НА РЕАЛЬНЫХ ДАННЫХ. Пока источники цен недоступны (degraded)
    // или перед нами помеченные синтетические свечи — движок НЕ торгует: ни входов ИИ и
    // лаборатории, ни сигналов, ни стопов/целей. На фейковых ценах нельзя ни открывать
    // сделки (мусор в портфеле — кейс R30), ни закрывать (фейковые стопы по реальным
    // сделкам). Страж при этом продолжает обслуживать счёт: он работает на сервере
    // GitHub с прямыми запросами к биржам и от браузера не зависит.
    if (state.degraded || (bars[bars.length - 1] && bars[bars.length - 1].sim)) return;
    state.lastScanAt = Date.now(); // хартбит: сканер жив (виден в «Сигналах» и «Кабинете»)
    const price = (state.prices[sym] && state.prices[sym].price) || bars[bars.length - 1].c;

    // 0) ИИ-автопилот: сканер всех монет, входы, флипы (спот-only, со скам-фильтром).
    //    R31: решения автопилота принимает ТОЛЬКО исполнитель (серверная аренда «host»):
    //    иначе два устройства открывали бы одни и те же сделки параллельно. Защитные
    //    выходы (стопы/цели/провал/безубыток) ниже работают на ВСЕХ устройствах —
    //    их дубли схлопываются слиянием (могилки по pid + одинаковые id событий).
    if (!serverMode() && isAutoHost()) { try { aiAutoStep(sym, bars); } catch (e) { console.error(e); } }

    // 1) сигналы стратегий
    for (const strat of Engine.STRATEGIES) {
      const sig = Engine.evalStrategy(strat.id, sym, bars);
      if (!sig) continue;
      const key = `${sig.strategy}-${sym}`;
      if (key === lastSignalKey) continue;
      if (state.labPositions.some((p) => p.sym === sym && p.strategy === strat.id)) continue;
      lastSignalKey = key;
      state.signals = [sig, ...state.signals.filter((x) => !(x.sym === sym && x.strategy === strat.id))].slice(0, 40);
      // R32: в серверном режиме событие сигнала шлёт СЕРВЕР (приедет с опросом) —
      // локальный дубль в ленту не пишем; сам расчёт оставлен для страницы «Сигналы»
      if (!serverMode()) pushEvent({ tone: "bull", title: `${strat.name}: сигнал по ${sym} · ${sig.confidence}%`, detail: sig.note, sym, notify: { kind: "signal" } });

      // 2) автоторговля лаборатории — сделка стратегии получает снапшот факторов,
      //    чтобы её закрытие обучило общий мозг ИИ (лаборатория — учебные данные).
      //    ЛАБА — ПОЛИГОН ДЕМО-РЕЖИМА: в реальном режиме новых лабораторных входов нет
      //    (требование пользователя: реальному рынку лаборатория не нужна — там она
      //    только мешала бы; существующие виртуальные позиции обслуживаются выходами),
      //    а на вспышках вход откладывается тем же анти-догоном, что и у ИИ
      if (!state.autoTrade) continue;
      if (state.mode === "live") continue;
      if (serverMode()) continue; // R32: входы лаборатории делает сервер — локально не дублируем
      if (!isAutoHost()) continue; // R31: вход лаборатории — только у исполнителя (иначе дубли позиций)
      const eq = Engine.entryQualityFromBars(bars, "лонг");
      if (!eq.ok) continue;
      const acc = state.labAccounts.find((a) => a.strategy === strat.id);
      if (!acc || acc.balance < 500) continue;
      const size = Math.max(200, Math.min(1000, acc.balance * 0.1));
      const snap = Engine.aiFactorSnapshot(sym, bars, state.aiBrain, (state.news && state.news.items) || [], { whale: aiWhaleBias(sym) });
      const pos = {
        id: `l${Date.now()}-${strat.id}`, owner: "lab", strategy: strat.id, account: acc.id,
        sym, side: "лонг", size, lev: 1, entry: price,
        stop: sig.stop, target: sig.target, openedAt: Date.now(),
        ladder: sig.entry - sig.atr * 0.5,
        ai: snap,
      };
      state.labPositions = [pos, ...state.labPositions];
      state.labAccounts = state.labAccounts.map((a) => (a.id === acc.id ? { ...a, balance: a.balance - size } : a));
    }

    // 3) проверка выходов
    const exits = [];
    for (const p of state.labPositions) {
      if (p.sym !== sym) continue;
      const ex = Engine.evalExit(p, bars, price, state.failPct);
      if (ex) exits.push({ pos: p, closed: Engine.closeTrade(p, ex.price, ex.reason) });
    }
    for (const p of state.userPositions) {
      if (p.sym !== sym) continue;
      // трейлинг-защита ИИ-позиций: стоп двигается ТОЛЬКО в пользу сделки
      // (+1R → безубыток, дальше — трейлинг); убыток он не ускоряет
      if (p.strategy === "ai" && p.ai) {
        const newStop = Engine.aiTrailStop(p, price);
        if (newStop != null) {
          p.stop = newStop;
          p.mt = Date.now(); // R30: метка правки позиции — слияние устройств берёт свежую версию стопа
          const dirIsLong = p.side === "лонг";
          const atBe = dirIsLong ? newStop >= p.entry : newStop <= p.entry;
          if (!p.beNotified && atBe) {
            p.beNotified = true;
            pushEvent({
              tone: "bull",
              title: `ИИ перевёл ${p.sym} в безубыток`,
              detail: `стоп подтянут к входу (+1R): сделка уже не уйдёт в минус · цена ${Fmt.fmtPrice(price)}`,
              sym: p.sym,
              notify: { kind: "ai_be" },
            });
          }
        }
      }
      const ex = Engine.evalExit(p, bars, price, state.failPct);
      if (ex) exits.push({ pos: p, closed: Engine.closeTrade(p, ex.price, ex.reason) });
      else if (p.owner === "user" && Engine.behindStopLine(p, price)) {
        // R29 предупреждение «ИИ держит позицию»: цена за стоп-линией, но до провального
        // уровня ещё далеко — честно показываем это вместо тихого ожидания стопа.
        // Один раз на «нырок»: флаг сбрасывается, когда цена возвращается за стоп-линию.
        if (!p.stopWarned) {
          p.stopWarned = true;
          const fl = Engine.failLineOf(p, state.failPct);
          pushEvent({
            tone: "bear",
            title: `${p.strategy === "ai" ? "ИИ держит позицию" : "Позиция за стоп-линией"}: ${p.sym} ${p.side}`,
            detail: `цена ${Fmt.fmtPrice(price)} против входа ${Fmt.fmtPrice(p.entry)} — временный минус поводом закрывать не является · провал закроется только на ${Fmt.fmtPrice(fl)} (тело +${state.failPct}%) · цель остаётся ${Fmt.fmtPrice(p.target)} — ждём возврата к прибыли`,
            sym: p.sym,
          });
        }
      } else if (p.stopWarned && !Engine.behindStopLine(p, price)) {
        p.stopWarned = false; // вернулись за стоп-линию — следующий нырок получит своё предупреждение
      }
    }
    if (exits.length) {
      const labIds = new Set(exits.filter((e) => e.pos.owner === "lab").map((e) => e.pos.id));
      const userIds = new Set(exits.filter((e) => e.pos.owner === "user").map((e) => e.pos.id));
      const labClosedAdd = exits.filter((e) => e.pos.owner === "lab").map((e) => e.closed);
      const userClosedAdd = exits.filter((e) => e.pos.owner === "user").map((e) => e.closed);
      state.labPositions = state.labPositions.filter((p) => !labIds.has(p.id));
      state.labClosed = [...labClosedAdd, ...state.labClosed].slice(0, 300);
      state.userPositions = state.userPositions.filter((p) => !userIds.has(p.id));
      state.userClosed = [...userClosedAdd, ...state.userClosed].slice(0, 300);
      if (state.mode !== "live") state.balance += userClosedAdd.reduce((sum, c) => sum + c.size + c.pnl, 0); // R52: live — без ХРЮ
      // R32: в серверном режиме выход реплеится НА СЕРВЕР (детерминированно, по pid):
      // сервер закроет той же логикой, могилки/union схлопнут двойные исполнения
      if (serverMode()) {
        for (const c of userClosedAdd) {
          try { Server.action("close", { id: c.pid, exitPrice: c.exit, reason: c.exitReason }); } catch (e) { /* сервер закроет сам на своём тике */ }
        }
      }
      for (const c of userClosedAdd) learnFromClosed(c); // ИИ учится на авто-выходах (стоп/цель/флип/безубыток)
      for (const c of userClosedAdd) if (c.strategy === "ai" && (c.exitReason === "Стоп" || c.exitReason === "Провал")) noteAiStopBan(c.sym); // R28: тихий час монете (провал — тот же доказанный провал расчёта)
      for (const c of labClosedAdd) learnFromClosed(c, true); // лаборатория тоже кормит общий мозг
      if (labClosedAdd.length) {
        state.labAccounts = state.labAccounts.map((a) => {
          const adds = labClosedAdd.filter((c) => c.account === a.id);
          if (!adds.length) return a;
          const bal = a.balance + adds.reduce((sum, c) => sum + c.size + c.pnl, 0);
          return { ...a, balance: bal, equityHist: [...a.equityHist.slice(-40), bal], days: a.days + 1 / 5760 };
        });
      }
      for (const e of exits) {
        const liveUsdt = e.pos.owner === "user" && state.mode === "live"; // R52: реальные позиции — в USDT
        pushEvent({
          id: "x" + pidOfClosed(e.closed), // R31: детерминированный id — двойное исполнение одного закрытия даёт ОДНО событие в ленте
          tone: e.closed.pnl >= 0 ? "bull" : "bear",
          title: liveUsdt
            ? `Реальный рынок: ${e.pos.sym} закрыта ${e.closed.exitReason.toLowerCase()} · ${e.closed.pnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(e.closed.pnl)))} USDT`
            : `${e.pos.owner === "lab" ? "Лаборатория" : "Демо"}: ${e.pos.sym} закрыта ${e.closed.exitReason.toLowerCase()} · ${e.closed.pnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(e.closed.pnl)))} ХРЮ (≈ ${e.closed.pnl >= 0 ? "+" : "−"}$${Fmt.fmtNum(Math.abs(Math.round(e.closed.pnl)))})`,
          detail: liveUsdt
            ? `правило выхода: ${e.closed.exitReason} · токен продаётся на OKX, USDT вернутся на биржу`
            : `стратегия: ${(Engine.STRATEGIES.find((x) => x.id === e.pos.strategy) || { name: "вручную" }).name}`,
          sym: e.pos.sym,
          notify: e.pos.owner === "lab"
            ? { kind: "lab", data: { pnl: e.closed.pnl } }
            : { kind: e.pos.strategy === "ai" ? "ai_close" : "user_close", data: { pnl: e.closed.pnl } },
        });
      }
      persist();
    }
    emit();
  }

  // ---------- R30: деградация БЕЗ симуляции торговли ----------
  // Раньше при недоступности бирж запускался симулятор цен (случайное блуждание от
  // дефолтов), и движок открывал/закрывал сделки на фейковых свечах — пользователь
  // получал «позиции» с выдуманными входами и одинаковым PnL после каждого обновления.
  // Теперь деградация честная: цены заморожены на последних известных уровнях,
  // синтетические свечи (с меткой sim) рисуются только для графиков, торговля стоит.
  function genSimBars(sym, p0) {
    const bars = Candles.genCandles({ seed: sym.length * 31 + sym.charCodeAt(0), n: 110, start: p0 * 0.985, end: p0, stepMin: 15, volBase: 0.008 });
    bars.forEach((b) => { b.sim = true; });
    return bars;
  }
  let degradedAnnounced = false;
  function announceDegraded() {
    if (degradedAnnounced) return;
    degradedAnnounced = true;
    state.degraded = true;
    pushEvent({
      tone: "bear",
      title: "Источники цен недоступны — торговля приостановлена",
      detail: "ни одна биржа и агрегаторы не ответили (сеть или блокировка). Цены заморожены на последних известных уровнях · новые сделки ИИ, лаборатории и сигналы не открываются · стопы и цели не исполняются по фейковым ценам · как только источник ответит, торговля продолжится сама · Страж (если настроен) продолжает обслуживать счёт с сервера GitHub",
    });
    emit();
  }
  function announceRestored() {
    degradedAnnounced = false;
    state.degraded = false;
    pushEvent({
      tone: "bull",
      title: "Источник данных восстановлен: " + (Binance.sourceName() || "биржа"),
      detail: "цены снова реальные — ИИ-автопилот, лаборатория и исполнение стопов/целей продолжены",
    });
    emit();
  }

  // ---------- новости: бесплатная реальная лента (rss2json, без ключей) ----------
  function stripHtml(s) {
    return String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }
  function pollNews() {
    const feeds = [
      "https://api.rss2json.com/v1/api.json?rss_url=https%3A%2F%2Fcointelegraph.com%2Frss",
      "https://api.rss2json.com/v1/api.json?rss_url=https%3A%2F%2Fwww.coindesk.com%2Farc%2Foutboundfeeds%2Frss%2F",
    ];
    const tryFetch = (i) => {
      if (i >= feeds.length) return; // обе ленты недоступны — ИИ работает по индикаторам
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      fetch(feeds[i], { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((j) => {
          clearTimeout(timer);
          if (!j || j.status !== "ok" || !Array.isArray(j.items)) return Promise.reject(new Error("bad feed"));
          const items = j.items.slice(0, 30).map((it) => ({
            title: stripHtml(it.title),
            body: stripHtml(it.description || it.content).slice(0, 420),
            ts: Date.parse(it.pubDate) || Date.now(),
            link: it.link || "",
            source: (j.feed && j.feed.title) || "",
          })).filter((it) => it.title);
          if (!items.length) return Promise.reject(new Error("empty"));
          state.news = { items, ts: Date.now(), source: i === 0 ? "cointelegraph" : "coindesk" };
          emit();
        })
        .catch(() => { clearTimeout(timer); tryFetch(i + 1); });
    };
    tryFetch(0);
  }

  // ---------- ДОГОНЯЮЩИЙ ДВИЖОК: платформа живёт даже когда пользователь оффлайн ----------
  // Пока вкладка закрыта/спит, автопилот и сделки не замирают: при возврате платформа
  // скачивает реальные 15-минутные свечи за период отсутствия и ПРОГОНЯЕТ ЧЕРЕЗ НИХ
  // движок: стопы/цели/безубыток исполняются по реальным ценам с реальными временами,
  // ИИ-автопилот продолжает сканировать, входить и флипать по тем же правилам и гвардам.
  // Баланс, история сделок и события пополняются задним числом — ничего не сбрасывается.
  const catchCtl = { busy: false, lastRun: 0, stats: null };
  const CATCH_MIN_GAP = 90 * 1000;   // меньше полутора минут — догонять нечем
  // 1000 свечей × 15м ≈ 10.4 суток: платформа должна честно отработать и ДЛИТЕЛЬНЫЙ офлайн
  // (ограничение самой биржи — 1000 свечей за запрос; на резервных источниках Bybit/OKX
  // покрытие меньше — 200/300 свечей, деградация мягкая). Исполнение задним числом.
  const CATCH_MAX_BARS = 1000;
  const CATCH_AI_EVERY = 4;          // ИИ решает на каждой 4-й свече (раз в час) — экономим CPU

  // консервативное внутрисвечное исполнение — единая логика с живым движком вынесена
  // в Engine.catchExitOnBar (провальная линия тело+N%, гистерезис, стоп в плюсе):
  // Страж и браузерный догон закрывают сделки по тем же правилам, что и живой тик.
  function catchExitOnBar(pos, bar) {
    return Engine.catchExitOnBar(pos, bar, state.failPct);
  }

  function catchClosePosition(pos, price, reason, ts) {
    const closed = Engine.closeTrade(pos, price, reason);
    closed.closedAt = ts; // честный архив: закрытие задним числом, по времени свечи
    // id детерминирован (позиция + время свечи): если пропущенный период параллельно
    // догоняют страж и браузер — слияние архивов дедуплицирует закрытие по id,
    // дубля в истории и двойного зачисления не будет
    closed.id = `${pos.id}-c${ts}`;
    state.userPositions = state.userPositions.filter((p) => p.id !== pos.id);
    state.userClosed = [closed, ...state.userClosed].slice(0, 400);
    if (state.mode !== "live") state.balance += closed.size + closed.pnl; // R52: live — без ХРЮ (догон работает только вне сервера)
    learnFromClosed(closed);
    if (closed.strategy === "ai" && (reason === "Стоп" || reason === "Провал")) noteAiStopBan(pos.sym); // R28: тихий час монете (догоняющий движок)
    pushEvent({
      tone: closed.pnl >= 0 ? "bull" : "bear",
      title: `Пока вас не было: ${pos.sym} закрыта (${reason.toLowerCase()}) · ${closed.pnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(closed.pnl)))} ХРЮ`,
      detail: `исполнено по реальной свече за период офлайна · ${closed.pnl >= 0 ? "+" : "−"}$${Fmt.fmtNum(Math.abs(Math.round(closed.pnl)))} · позиция открыта ${Fmt.fmtClock(pos.openedAt)}`,
      sym: pos.sym,
    }, ts);
    return closed;
  }

  function catchUp() {
    if (!state.started || catchCtl.busy) return Promise.resolve(false);
    // R32: сервер сам торгует каждые 2 минуты — браузерный догон не нужен
    if (serverMode()) return Promise.resolve(false);
    if (state.degraded) return Promise.resolve(false); // нет реальных источников — симуляция уже «живёт»
    // R31: догоняет рынок ТОЛЬКО исполнитель. Пока открыто другое устройство или
    // работает Страж, пропущенный период уже проигран серверным движком — его
    // результат лежит в облаке и приедет ближайшим циклом синхронизации.
    if (!claimHost("устройство · догон рынка")) return Promise.resolve(false);
    const now = Date.now();
    const since = state.lastCatchUp || (now - 10 * 60000);
    const gapMs = now - since;
    if (gapMs < CATCH_MIN_GAP) { state.lastCatchUp = now; return Promise.resolve(false); }
    catchCtl.busy = true;
    const t0 = Date.now();
    const jobs = WATCH_SYMS.map((sym) => {
      const inst = BY_SYM[sym];
      if (!inst) return Promise.resolve();
      const load = () => Binance.fetchKlines(inst.pair, "15m", CATCH_MAX_BARS);
      // одна мягкая повторная попытка: одиночный сетевой сбой (Failed to fetch —
      // биржа на секунду не ответила) не должен попадать в ленту самодиагностики;
      // только если не ответили ДВА раза подряд — сбой честно фиксируется
      return load()
        .catch(() => new Promise((r) => setTimeout(r, 700)).then(load))
        .then(async (rows) => {
          const bars = klineToBars(rows);
          if (!bars || bars.length < 10) return;
          // свечи сразу в состояние: сканер и графики работают с первой секунды,
          // не дожидаясь пока pollBars дойдёт до этой монеты (полный круг ~45с)
          const key = `${sym}:15м`;
          const cur = state.bars[key];
          if (!cur || !cur.length || bars[bars.length - 1].t >= cur[cur.length - 1].t) state.bars[key] = bars;
          const gapBars = bars.filter((b) => b.t * 60000 + 15 * 60000 > since - 15 * 60000);
          if (!gapBars.length) return;
          await walkGapBars(sym, bars, gapBars);
        })
        .catch((e) => { diagError("догоняющий движок · " + sym, e); /* символ догнать не вышло — повторит при следующем возврате, сбой виден в ленте */ });
    });
    return Promise.all(jobs)
      .then(() => {
        state.lastCatchUp = now;
        catchCtl.lastRun = now;
        const st = catchCtl.stats;
        if (st && (st.closed || st.opened)) {
          pushEvent({
            tone: st.sum >= 0 ? "bull" : "bear",
            title: `Пока вас не было (${Fmt.fmtTimeAgo(gapMs / 60000)}): ИИ не спал`,
            detail: `догнано по реальным свечам: ${st.closed} закрытых сделок (${st.sum >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(st.sum)))} ХРЮ), ${st.opened} новых входов автопилота · обработка ${((Date.now() - t0) / 1000).toFixed(1)} с`,
          });
        }
        persist();
        emit();
        return true;
      })
      .finally(() => { catchCtl.busy = false; catchCtl.stats = null; });
  }

  // прогон одной монеты через свечи пропущенного периода (async: раз в 40 свечей
  // отдаём управление браузеру — длинный догон не подвешивает интерфейс)
  async function walkGapBars(sym, fullBars, gapBars) {
    const st = catchCtl.stats || (catchCtl.stats = { closed: 0, opened: 0, sum: 0 });
    for (let gi = 0; gi < gapBars.length; gi++) {
      const bar = gapBars[gi];
      const ts = bar.t * 60000 + 15 * 60000; // время закрытия свечи
      const barsUpTo = fullBars.filter((b) => b.t <= bar.t); // контекст на момент свечи

      // 1) цена на момент свечи — «свежая» для гвардов и расчётов (ts = сейчас,
      //    чтобы скам-фильтр не отвергал входы из-за формальной протухшести цены)
      const p = state.prices[sym];
      if (p) { p.prev = p.price; p.price = bar.c; p.ts = Date.now(); }

      // 2) трейлинг-защита ИИ-позиций
      for (const pos of state.userPositions) {
        if (pos.sym !== sym || pos.strategy !== "ai" || !pos.ai) continue;
        const newStop = Engine.aiTrailStop(pos, bar.c);
        if (newStop != null) { pos.stop = newStop; pos.mt = ts; } // R30: метка правки для слияния устройств
      }

      // 3) выходы (стоп/цель — внутрисвечно, консервативно; тренд-сигнал — по закрытию,
      //    у новой политики он работает для лонга и шорта и только при плюсе)
      for (const pos of [...state.userPositions]) {
        if (pos.sym !== sym) continue;
        const hit = catchExitOnBar(pos, bar);
        const sig = !hit && barsUpTo.length >= 22 ? Engine.evalExit(pos, barsUpTo, bar.c, state.failPct) : null;
        const ex = hit || (sig && sig.reason !== "Цель" && sig.reason !== "Стоп" && sig.reason !== "Провал" ? sig : null);
        if (ex) {
          const closed = catchClosePosition(pos, ex.price, ex.reason, ts);
          st.closed++; st.sum += closed.pnl;
        }
      }
      // лаборатория: те же правила выходов
      for (const pos of [...state.labPositions]) {
        if (pos.sym !== sym) continue;
        const hit = catchExitOnBar(pos, bar);
        const sig = !hit && barsUpTo.length >= 22 && pos.side === "лонг" ? Engine.evalExit(pos, barsUpTo, bar.c, state.failPct) : null;
        const ex = hit || (sig && sig.reason !== "Цель" && sig.reason !== "Стоп" && sig.reason !== "Провал" ? sig : null);
        if (ex) {
          const closed = Engine.closeTrade(pos, ex.price, ex.reason);
          state.labPositions = state.labPositions.filter((q) => q.id !== pos.id);
          state.labClosed = [closed, ...state.labClosed].slice(0, 400);
          learnFromClosed(closed, true);
          state.labAccounts = state.labAccounts.map((a) => (a.id === closed.account ? { ...a, balance: a.balance + closed.size + closed.pnl } : a));
          st.labClosed = (st.labClosed || 0) + 1;
        }
      }

      // 4) автопилот: продолжает входить и флипать по историческим свечам
      //    (тот же aiAutoStep: гварды, лимиты, сессия, обучение — всё работает)
      if (gi % CATCH_AI_EVERY === CATCH_AI_EVERY - 1) {
        const openedBefore = state.userPositions.length;
        try { aiAutoStep(sym, barsUpTo); } catch (e) { diagError("догоняющий автопилот", e); }
        const openedAfter = state.userPositions.length;
        if (openedAfter > openedBefore) {
          st.opened += openedAfter - openedBefore;
          const np = state.userPositions[0];
          if (np && np.openedAt) {
            np.openedAt = ts; // вход задним числом — честный архив
            // детерминированный id (время свечи + монета): если тот же период параллельно
            // догоняет страж — слияние не создаст фантомный дубль позиции
            np.id = `u${ts}-${sym}`;
          }
        }
      }
      // кооперативная пауза: длинный догон не блокирует поток интерфейса
      if (gi % 40 === 39) await new Promise((r) => setTimeout(r, 0));
    }
  }

  // вызовы догоняющего движка: старт, возврат во вкладку, фокус, появление сети.
  // ВАЖНО: периодический догон работает и в СКРЫТОЙ вкладке — браузер троттлит таймеры
  // до ~1 раза в минуту, но редкие прогоны догоняют пропущенное (гейт busy + MIN_GAP
  // защищают от лишней работы). Пока вкладка жива — ИИ торгует, даже если пользователь не смотрит.
  function bindCatchUp() {
    if (typeof document === "undefined" || !document.addEventListener) return;
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) catchUp();
    });
    window.addEventListener("focus", () => catchUp());
    window.addEventListener("online", () => { catchUp(); if (state.sync.enabled) syncPull(); });
    if (typeof setInterval === "function") setInterval(() => catchUp(), 4 * 60000);
  }

  // ---------- старт платформы ----------
  function start() {
    if (state.started) return;
    state.started = true;
    hydrate();
    emit();
    // жизнь без пользователя: догоняющий движок на старте/фокусе/возврате/сети
    bindCatchUp();
    setTimeout(() => { catchUp(); }, 1500);
    initSyncRuntime();

    // 1) тикеры каждые 4с (все 25 монет — обычный биржевой путь)
    const CEX_PAIRS = WATCHLIST.filter((i) => i.pair).map((i) => i.pair);
    const pollTickers = async () => {
      try {
        const raw = await Binance.fetchTickers(CEX_PAIRS);
        const now = Date.now();
        for (const t of raw) {
          // TONUSDT → GRAM (у GRAM биржевая пара не совпадает с символом платформы)
          const sym = PAIR_TO_SYM[t.symbol] || t.symbol.replace(/USDT$/, "");
          const cur = state.prices[sym];
          if (!cur) continue;
          const price = Number(t.lastPrice);
          if (!Number.isFinite(price) || price <= 0) continue;
          state.prices[sym] = {
            sym, price, prev: cur.price,
            chg24h: Number(t.priceChangePercent),
            high24: Number(t.highPrice), low24: Number(t.lowPrice),
            vol24: Number(t.quoteVolume), open24: Number(t.openPrice),
            spark: [...cur.spark.slice(1), price],
            ts: now,
          };
        }
        if (state.degraded) announceRestored(); // R30: честное «сеть вернулась»
        state.lastSync = now;
        state.source = Binance.sourceName();
        emit();
      } catch (e) {
        announceDegraded(); // R30: без симуляции — торговля встаёт, цены заморожены
        emit();
      }
      // монеты, которых нет на текущем источнике (или цена протухла), докачиваем отдельно
      fillMissingTickers();
    };

    let fillBusy = false;
    function fillMissingTickers() {
      if (fillBusy) return;
      const missing = WATCH_SYMS.filter((sym) => !isPriceFresh(sym) && BY_SYM[sym]);
      if (!missing.length) return;
      fillBusy = true;
      const jobs = missing.map((sym) =>
        Binance.fetchTickerOne(BY_SYM[sym].pair)
          .then((t) => {
            if (!t || !(Number(t.lastPrice) > 0)) return;
            const cur = state.prices[sym];
            const price = Number(t.lastPrice);
            state.prices[sym] = {
              sym, price, prev: cur.price,
              chg24h: Number(t.priceChangePercent) || 0,
              high24: Number(t.highPrice) || price, low24: Number(t.lowPrice) || price,
              vol24: Number(t.quoteVolume) || 0, open24: Number(t.openPrice) || price,
              spark: [...cur.spark.slice(1), price],
              ts: Date.now(),
            };
          })
          .catch(() => { /* этой монеты нет у всех источников — повторим в следующий тик */ })
      );
      Promise.all(jobs).then(() => { fillBusy = false; emit(); });
    }

    pollTickers();
    setInterval(pollTickers, 4000);

    // 1b) реальный поток цен (WebSocket Binance): тики каждую секунду между REST-опросами.
    // Цены в состоянии обновляются мгновенно; слушатели fast-tick (живой PnL позиций,
    // сайдбар) срабатывают без полной перерисовки. REST-опрос остаётся как резерв + источник spark.
    if (Binance.openTickerStream && Binance.onFastTick) {
      Binance.openTickerStream(CEX_PAIRS);
      Binance.onFastTick((t) => {
        // TON (из потока) → GRAM: у GRAM биржевая пара TONUSDT, а не GRAMUSDT
        const sym = PAIR_TO_SYM[t.sym + "USDT"] || t.sym;
        const cur = state.prices[sym];
        if (!cur) return;
        state.prices[sym] = {
          ...cur,
          prev: cur.price,
          price: t.price,
          chg24h: t.chg24h,
          high24: t.high24, low24: t.low24,
          vol24: t.vol24 || cur.vol24,
          open24: t.open24 || cur.open24,
          ts: t.ts,
        };
        fastTickListeners.forEach((fn) => { try { fn(); } catch (e) { /* noop */ } });
      });
    }

    // 2) сбор свечей для движка: по одному инструменту каждые 1.8с
    let idx = 0;
    const pollBars = () => {
      const sym = WATCH_SYMS[idx % WATCH_SYMS.length];
      idx++;
      const inst = BY_SYM[sym];
      Binance.fetchKlines(inst.pair, ENGINE_TF, 120)
        .then((rows) => {
          const bars = klineToBars(rows);
          state.bars[`${sym}:15м`] = bars;
          engineStep(sym, bars);
        })
        .catch(() => {
          // R30: биржа не ответила — свечи для графика (помеченные сим), движок НЕ шагает
          if (!state.bars[`${sym}:15м`]) {
            const p = (state.prices[sym] && state.prices[sym].price) || DEFAULT_PRICES[sym] || 1;
            state.bars[`${sym}:15м`] = genSimBars(sym, p);
          }
          announceDegraded();
          emit();
        });
    };
    pollBars();
    setInterval(pollBars, 1800);

    // 3) киты BTC для ленты событий + портфельная история
    loadWhales("BTC");
    setInterval(() => loadWhales("BTC"), 60000);

    // 4) новостная лента: реальная крипто-новости (бесплатный rss2json → Cointelegraph)
    //    ИИ строит из неё 8-й фактор и новостную защиту от рисков
    pollNews();
    setInterval(pollNews, 300000);

    setInterval(() => {
      state.equityHist = [...state.equityHist, { ts: Date.now(), v: totalEquity() }].slice(-300);
      savePriceSnapshot(); // R30: последние известные цены переживают перезагрузку
      persist();
      emit();
    }, 30000);
  }

  return {
    state, subscribe, emit, onFastTick, onNotify, start, getBars, ensureBars, prewarmSignalBars,
    placeDemo, closeDemo, setBalance, resetDemo, toggleAuto,
    loadWhales, setActiveSym, totalEquity, switchUser, canTrade,
    setMode, toggleAiAuto, recordLiveOrder, aiSessionInfo,
    setAiThreshold, setFailPct, closeAllAiPositions, brainSyncInfo, setAiMaxPos, aiMaxPos,
    // лимиты сделок: макс. одной + суммарный + авторасчёт одновременных позиций
    setMaxDeal, setMaxTotal, setAiPosMode, aiDealCap, aiTotalCap, aiTotalRemain,
    openPositionsSum, autoMaxPos, effMaxPos, aiSizeCalc, aiKellyFrac,
    // жизнь без пользователя + синхронизация устройств
    catchUp, catchInfo: () => ({ lastCatchUp: state.lastCatchUp, lastRun: catchCtl.lastRun, busy: catchCtl.busy }),
    addPushSub, removePushSub, // R30: push-подписки устройств (Web Push)
    setNtfy, generateNtfyTopic, // R50: резервный канал ntfy
    setOkxAuto, // R51: аварийный выключатель авто-ордеров OKX
    applyServerArchive, // R49: применение серверного архива из колбэков app.js (glmCfg)
    enableSync, syncPush, syncPull, syncInfo, exportBackup, importBackup, archiveAccount,
    clearClosedHistory,
    effAuto,
    // R31: серверный аккаунт — аренда исполнителя автоторговли
    claimHost, releaseHost, isAutoHost, hostInfo: () => ({ host: hostActive(), me: deviceId || loadDeviceId(), isHost: isAutoHost() }),
    // внутренности для юнит-тестов
    _flipAllowed: flipAllowed, _riskGuard: riskGuard, _heatGuard: heatGuard, _aiLossStreak: aiLossStreak,
    _aiAutoStep: aiAutoStep, _engineStep: engineStep, _diagInfo: () => ({ count: diagCount, foreign: foreignCount }),
    _noteAiStopBan: noteAiStopBan, _htfVeto: Engine.htfVeto,
    _diagReset: () => { lastDiagAt = 0; diagSeen.clear(); diagCount = 0; foreignCount = 0; }, // только для юнит-тестов
    _mergeArchives: mergeArchives, _applyArchive: applyArchive, _fpOf: fpOf, _diagError: diagError,
    _trimForCloud: trimForCloud, _isVirginArchive: isVirginArchive,
    _persist: persist, _persistNow: persistNow,
    _priceSave: savePriceSnapshot, _priceRestore: restorePriceSnapshot, // R30: для тестов
    _genSimBars: genSimBars, _announceDegraded: announceDegraded, _announceRestored: announceRestored,
    _pairToSym: (p) => PAIR_TO_SYM[p] || null,
  };
})();

window.Store = Store;
