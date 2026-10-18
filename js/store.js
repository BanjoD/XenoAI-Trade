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
    liveOrders: [],     // отправленные реальные ордера (заготовка реальной торговли)
    aiBrain: null,      // память ИИ: адаптивные веса, статистика монет, уроки (обучение на сделках)
    aiSession: null,    // сессия автопилота: { startEquity, openedAt } — база для авто-стопа ±лимит
    aiStop: null,       // причина авто-стопа сессии: { reason: profit|loss, pct, ts, threshold, closed }
    aiThreshold: 50,    // лимит сессии ИИ, % от базы: +50% профита или −50% просадки → стоп (настраивается)
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
    clearedU: [],       // «могилки» очищенной истории пользователя (id удалённых закрытых сделок) — чтобы облако не воскресило их
    clearedL: [],       // «могилки» очищенной истории лаборатории
    sync: { code: null, enabled: false, lastPush: 0, lastPull: 0, lastError: null, lastSeenRev: 0, sawRemote: false }, // синхронизация устройств
  };

  // ------- память ИИ (обучение на результатах сделок) -------
  function defaultBrain() {
    return {
      v: 1,
      weights: null,       // null → базовые Engine.AI_BASE_WEIGHTS; далее — адаптивные
      rel: {},             // надёжность фактора (множитель веса) 0.55..1.5, старт 1
      symStats: {},        // sym → { n, wins, streak, avgPct } — опыт по монетам
      confThreshold: 76,   // динамический порог входа автопилота (калибруется результатами)
      trades: 0, wins: 0, losses: 0,
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
    if (!Number.isFinite(br.confThreshold)) br.confThreshold = 76;
    br.confThreshold = Math.max(70, Math.min(88, Math.round(br.confThreshold)));
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
    }
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
    // POST вместо GET: мозг с большим symStats не влезает в URL, а POST /update держит 200 000 символов
    const body = "key=" + encodeURIComponent(BRAIN_CLOUD_KEY) + "&value=" + encodeURIComponent(JSON.stringify(state.aiBrain));
    fetchT(SYNC_UPDATE_URL, 9000, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body })
      .then((r) => { if (!r.ok) throw new Error("push " + r.status); return r.json().catch(() => ({})); })
      .then((j) => { if (j && j.status === 0) throw new Error("облако отклонило запись"); brainSync.lastOkAt = Date.now(); brainSync.lastPushAt = Date.now(); brainSync.mode = "облако"; })
      .catch(() => { brainSync.mode = brainSync.lastOkAt ? "облако" : "локально (нет сети)"; })
      .then(() => { brainSync.busy = false; if (brainSync.pending) { brainSync.pending = false; setTimeout(brainPush, 2000); } });
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
      aiSession: s.aiSession, aiStop: s.aiStop, aiThreshold: s.aiThreshold, aiMaxPos: s.aiMaxPos,
      maxDeal: s.maxDeal, maxTotal: s.maxTotal, aiPosMode: s.aiPosMode,
      lastCatchUp: s.lastCatchUp, lastScanAt: s.lastScanAt,
      aiCooldownUntil: s.aiCooldownUntil || 0, aiCooldownSeen: s.aiCooldownSeen || 0,
      clearedU: (s.clearedU || []).slice(-800), clearedL: (s.clearedL || []).slice(-800),
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
    };
  }

  function persist() {
    if (!Auth.sessionLogin()) return;
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      state.rev = (state.rev || 0) + 1; // каждая запись — новая ревизия (слияние синка)
      state.updatedAt = Date.now();     // настенные часы изменения — их сравнивают устройства
      const data = archiveAccount();
      data.rev = state.rev;
      writeRawSafe(dataKey(), JSON.stringify(data));
      scheduleSyncPush(); // облачная синхронизация устройств (если включена)
    }, 400);
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
    if (d.aiSession && typeof d.aiSession.startEquity === "number") state.aiSession = d.aiSession;
    if (d.aiStop && (d.aiStop.reason === "profit" || d.aiStop.reason === "loss")) state.aiStop = d.aiStop;
    if (typeof d.aiThreshold === "number" && d.aiThreshold >= 5 && d.aiThreshold <= 500) state.aiThreshold = d.aiThreshold;
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
    // могилки очищенной истории: удалённое не имеет права воскреснуть из старого архива
    if (Array.isArray(d.clearedU)) state.clearedU = d.clearedU.slice(-800);
    if (Array.isArray(d.clearedL)) state.clearedL = d.clearedL.slice(-800);
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
    state.aiBrain = defaultBrain(); state.aiSession = null; state.aiStop = null;
    state.aiThreshold = 50; // дефолт до загрузки персист-данных пользователя
    state.aiMaxPos = 5;
    state.aiPosMode = "auto"; state.maxDeal = 1000; state.maxTotal = 5000;
    state.aiAutoLive = false; // в реальном режиме автопилот всегда стартует выключенным
    state.lastCatchUp = 0; state.rev = 0; state.updatedAt = 0;
    state.aiCooldownUntil = 0; state.aiCooldownSeen = 0;
    state.clearedU = []; state.clearedL = [];
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
  function mergeArchives(a, b) {
    if (!a || typeof a !== "object") return b;
    if (!b || typeof b !== "object") return a;
    const main = ((b.updatedAt || 0) > (a.updatedAt || 0)) ? b : a;
    const other = main === b ? a : b;
    const out = JSON.parse(JSON.stringify(main));
    const seenC = new Set((out.userClosed || []).map((c) => c.id));
    (other.userClosed || []).forEach((c) => { if (c && c.id && !seenC.has(c.id)) out.userClosed.push(c); });
    out.userClosed = (out.userClosed || []).sort((x, y) => (y.closedAt || 0) - (x.closedAt || 0)).slice(0, 400);
    const seenL = new Set((out.labClosed || []).map((c) => c.id));
    (other.labClosed || []).forEach((c) => { if (c && c.id && !seenL.has(c.id)) out.labClosed.push(c); });
    out.labClosed = (out.labClosed || []).sort((x, y) => (y.closedAt || 0) - (x.closedAt || 0)).slice(0, 400);
    const seenE = new Set((out.events || []).map((e) => e.id));
    (other.events || []).forEach((e) => { if (e && e.id && !seenE.has(e.id)) out.events.push(e); });
    out.events = (out.events || []).sort((x, y) => (y.ts || 0) - (x.ts || 0)).slice(0, 80);
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
    pushEvent({
      tone: "neutral",
      title: `Синхронизация: архив аккаунта обновлён (${sourceLabel})`,
      detail: `баланс ${Fmt.fmtNum(Math.round(before.bal))} → ${Fmt.fmtNum(Math.round(after.bal))} ХРЮ · закрытых сделок ${before.closed} → ${after.closed} · в рынке ${before.open} → ${after.open} · история объединена без потерь`,
    });
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

  function syncPush(force) {
    if (!state.started || !state.sync.enabled || !state.sync.code) return Promise.resolve(false);
    if (syncCtl.busy) { syncCtl.pending = true; return Promise.resolve(false); }
    // троттлинг записи (лимит облака — 500 записей/сутки с IP): не чаще раза в 50 секунд;
    // force=true — для пулов-«посева» и повторов очереди, он всё равно проходит через бюджет
    const since = Date.now() - (state.sync.lastPush || 0);
    if (!force && since < 50000) {
      if (!syncCtl.pushTimer) syncCtl.pushTimer = setTimeout(() => { syncCtl.pushTimer = null; syncPush(true); }, Math.max(2000, 50000 - since));
      return Promise.resolve(false);
    }
    const local = archiveAccount();
    // пустой счёт не затирает облако, где уже есть данные другого устройства
    if (state.sync.sawRemote && isVirginArchive(local)) return Promise.resolve(false);
    const fp = fpOf(local);
    if (force !== "seed" && fp === syncCtl.lastPushedFp) return Promise.resolve(false); // содержимое не менялось — запись не тратим
    if (!budgetTake()) { state.sync.lastError = "дневной лимит записей облака исчерпан — данные уедут при следующем окне"; return Promise.resolve(false); }
    syncCtl.busy = true;
    const body = "key=" + encodeURIComponent(syncKey()) + "&value=" + encodeURIComponent(JSON.stringify(trimForCloud(local)));
    return fetchT(SYNC_UPDATE_URL, 20000, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body })
      .then((r) => { if (!r.ok) throw new Error("пуш " + r.status); return r.json().catch(() => ({})); })
      .then((j) => {
        if (j && j.status === 0) throw new Error("облако отклонило запись");
        state.sync.lastPush = Date.now(); state.sync.lastError = null;
        syncCtl.lastPushedFp = fp;
        return true;
      })
      .catch((e) => { state.sync.lastError = "пуш: " + String(e && e.message || e); return false; })
      .then((ok) => {
        syncCtl.busy = false; persistSyncMeta();
        if (syncCtl.pending) { syncCtl.pending = false; setTimeout(() => syncPush(true), 3000); }
        emit(); return ok;
      });
  }
  function scheduleSyncPush() {
    if (!state.sync.enabled || !state.sync.code || syncCtl.pushTimer) return;
    syncCtl.pushTimer = setTimeout(() => { syncCtl.pushTimer = null; syncPush(false); }, 8000);
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
      (a.userPositions || []).map((p) => p.id).sort().join(","),
      (a.userClosed || []).length + ":" + (c0.id || ""),
      (a.events || []).length + ":" + (e0.id || ""),
      cu.length + ":" + (cu.length ? cu[cu.length - 1] : ""),
      cl.length + ":" + (cl.length ? cl[cl.length - 1] : ""),
      a.maxDeal, a.maxTotal, a.aiThreshold, a.aiPosMode,
      a.mode, a.autoTrade ? 1 : 0, a.aiAuto ? 1 : 0, a.aiAutoLive ? 1 : 0,
    ].join("|");
  }

  function syncPull() {
    if (!state.sync.enabled || !state.sync.code) return Promise.resolve(false);
    if (syncCtl.busy) return Promise.resolve(false);
    syncCtl.busy = true;
    return fetchT(SYNC_BASE + syncKey(), 12000)
      .then((r) => { if (!r.ok) throw new Error("pull " + r.status); return r.text(); })
      .then((txt) => {
        txt = (txt || "").trim();
        if (!txt) {
          // облако пустое (новый код): сеем его своим архивом, если есть чем —
          // иначе (девственный счёт) запись не тратим
          const local0 = archiveAccount();
          if (!isVirginArchive(local0)) return syncPush("seed");
          return false;
        }
        const remote = JSON.parse(txt);
        if (!remote || typeof remote !== "object" || !Array.isArray(remote.userClosed)) throw new Error("чужой или битый архив");
        state.sync.lastPull = Date.now();
        state.sync.lastError = null;
        state.sync.sawRemote = true; // облако живо и с данными: пустой локальный счёт отныне не может его затереть
        const local = archiveAccount();
        // ВАЖНО: archiveAccount() у девственного аккаунта (updatedAt=0) подставляет свежий
        // Date.now() — и свежий ПК считал бы себя «новее» архива телефона в облаке,
        // отказываясь от слияния (точный кейс пользователя: телефон 7 сделок / ПК 0).
        // Для сравнения и слияния используем НАСТОЯЩИЕ настенные часы состояния.
        local.updatedAt = state.updatedAt || 0;
        // содержимое совпало — ограничиваемся принятием старшей ревизии, без цикла пушей
        if (fpOf(remote) === fpOf(local)) {
          state.rev = Math.max(state.rev || 0, remote.rev || 0);
          syncCtl.lastPushedFp = fpOf(local);
          return false;
        }
        // локальные изменения свежее облака — делимся собой (второе устройство подтянет при своём пуле)
        if ((local.updatedAt || 0) >= (remote.updatedAt || 0)) { syncPush(false); return false; }
        // облако свежее: сливаем (история объединяется) и применяем один раз
        const merged = mergeArchives(local, remote);
        if (fpOf(merged) === fpOf(local)) {
          // слияние не изменило локальное содержимое — принимаем ревизию без лишнего цикла пуша
          state.rev = Math.max(state.rev || 0, remote.rev || 0);
          return false;
        }
        applySyncArchive(merged, "облако");
        syncCtl.lastPushedFp = null; // содержимое изменилось — следующий пуш обязан уйти
        return true;
      })
      .catch((e) => {
        const msg = String(e && e.message || e);
        if (msg.indexOf("пустое") === -1) state.sync.lastError = msg; // пустое облако — норма для нового кода
        return false;
      })
      .then((changed) => { syncCtl.busy = false; persistSyncMeta(); emit(); return changed; });
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
    syncPull().then(() => { if (state.sync.enabled) syncPush(true); });
    if (typeof setInterval === "function" && !syncCtl.pollTimer) {
      syncCtl.pollTimer = setInterval(() => { if (state.started && state.sync.enabled) syncPull(); }, 120000);
    }
    persist(); emit();
    return { ok: true, code: state.sync.code };
  }
  function syncInfo() {
    return { code: state.sync.code, enabled: state.sync.enabled, lastPush: state.sync.lastPush, lastPull: state.sync.lastPull, lastError: state.sync.lastError, busy: syncCtl.busy };
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
      if (typeof setInterval === "function" && !syncCtl.pollTimer) {
        syncCtl.pollTimer = setInterval(() => { if (state.started && state.sync.enabled) syncPull(); }, 60000);
      }
      setTimeout(() => { if (state.started) syncPull(); }, 3000);
      // мгновенный пул при возврате во вкладку / восстановлении сети:
      // рассинхрон между устройствами живёт секунды, а не минуты
      if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
        const kick = () => { if (state.started && state.sync.enabled && !syncCtl.busy) setTimeout(() => { if (state.sync.enabled) syncPull(); }, 1500); };
        window.addEventListener("focus", kick);
        window.addEventListener("online", kick);
        document.addEventListener("visibilitychange", () => { if (!document.hidden) kick(); });
        // финальная досылка при закрытии страницы: последнее состояние уезжает
        // в облако через sendBeacon (не зависит от выгрузки документа)
        window.addEventListener("pagehide", () => {
          try {
            const local = archiveAccount();
            if (state.sync.sawRemote && isVirginArchive(local)) return;
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

  // шина системных уведомлений: модуль Notify подписывается и показывает
  // push-оповещения по событиям, помеченным notify: { kind } (см. js/notify.js)
  const notifyBus = new Set();
  function onNotify(fn) { notifyBus.add(fn); return () => notifyBus.delete(fn); }

  function pushEvent(e, tsOverride) {
    state.events = [{ ...e, id: `e${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, ts: tsOverride || Date.now() }, ...state.events].slice(0, 60);
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

  // ---------- действия ----------
  function setActiveSym(sym) {
    state.activeSym = sym;
    ensureBars(sym, "15м");
    loadWhales(sym);
    emit();
  }

  function getBars(sym, tf) { return state.bars[`${sym}:${tf}`] || []; }

  function ensureBars(sym, tf) {
    const key = `${sym}:${tf}`;
    if (state.bars[key]) return;
    const inst = BY_SYM[sym];
    if (!inst) return;
    const interval = (TF_MAP[tf] && TF_MAP[tf].binance) || "15m";
    Binance.fetchKlines(inst.pair, interval, 120)
      .then((rows) => {
        state.bars[key] = klineToBars(rows);
        state.degraded = false;
        state.lastSync = Date.now();
        emit();
      })
      .catch(() => {
        // деградация: синтетические свечи вокруг последней известной цены
        const p = (state.prices[sym] && state.prices[sym].price) || DEFAULT_PRICES[sym] || 1;
        const stepMin = (TF_MAP[tf] && TF_MAP[tf].stepMin) || 15;
        const sim = Candles.genCandles({ seed: sym.length * 31 + sym.charCodeAt(0), n: 110, start: p * 0.985, end: p, stepMin, volBase: 0.008 });
        state.bars[key] = sim;
        emit();
      });
  }

  function placeDemo(p) {
    if (!canTrade()) return { ok: false, error: "Сделки может открывать только аккаунт David или Yura" };
    const p0 = state.prices[p.sym];
    if (!p0 || !p0.price) return { ok: false, error: "Цена ещё не загружена — попробуйте через секунду" };
    if (!p0.ts || Date.now() - p0.ts > 120000) return { ok: false, error: "Цена по этой монете не обновляется — подождите или выберите другую" };
    const price = p0.price;
    const margin = Math.round(Number(p.size) || 0);
    if (!(margin > 0)) return { ok: false, error: "Некорректный размер сделки" };
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
      id: `u${Date.now()}`, owner: "user", strategy: p.strategy || "manual", sym: p.sym, side: p.side,
      size: margin, lev: p.lev || 1, entry: price,
      stop: p.stop || (p.side === "лонг" ? price - risk : price + risk),
      target: p.target || (p.side === "лонг" ? price + risk * 2 : price - risk * 2),
      r0: Math.abs(price - (p.stop || (p.side === "лонг" ? price - risk : price + risk))), // исходный риск на единицу цены — база трейлинга
      openedAt: Date.now(),
      ai: p.ai || null,
    };
    // ХРЮ реально списываются со счёта в момент открытия
    state.balance -= margin;
    state.userPositions = [pos, ...state.userPositions];
    pushEvent({
      tone: p.side === "лонг" ? "bull" : "bear",
      title: p.strategy === "ai" ? `ИИ-сделка открыта: ${p.sym} ${p.side} ×${pos.lev}` : `Демо-сделка открыта: ${p.sym} ${p.side} ×${pos.lev}`,
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
    if (!canTrade()) return { ok: false, error: "Закрывать сделки может только аккаунт David или Yura" };
    const pos = state.userPositions.find((p) => p.id === id);
    if (!pos) return { ok: false, error: "Позиция не найдена" };
    const price = (state.prices[pos.sym] && state.prices[pos.sym].price) || pos.entry;
    const closed = Engine.closeTrade(pos, price, "Вручную");
    state.userPositions = state.userPositions.filter((p) => p.id !== id);
    state.userClosed = [closed, ...state.userClosed].slice(0, 300);
    state.balance += pos.size + closed.pnl; // возврат маржи + результат (уже после комиссии 0.1%)
    learnFromClosed(closed); // ИИ учится на результате
    pushEvent({
      tone: closed.pnl >= 0 ? "bull" : "bear",
      title: `Демо-сделка закрыта: ${pos.sym} ${closed.pnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(closed.pnl)))} ХРЮ (≈ ${closed.pnl >= 0 ? "+" : "−"}$${Fmt.fmtNum(Math.abs(Math.round(closed.pnl)))})`,
      detail: closed.exitReason,
      sym: pos.sym,
      notify: { kind: "user_close", data: { pnl: closed.pnl } },
    });
    persist();
    emit();
    return { ok: true, closed };
  }

  function setBalance(v) {
    state.balance = v; state.startBalance = v;
    // ввод/вывод не должен считаться результатом сессии ИИ — перебазируем
    if (state.aiAuto && state.aiSession) state.aiSession.startEquity = totalEquity();
    pushEvent({ tone: "neutral", title: `Баланс демо-счёта установлен: ${Fmt.fmtNum(v)} ХРЮ`, detail: "Кабинет пользователя" });
    persist(); emit();
  }

  function resetDemo() {
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

  function toggleAuto() { state.autoTrade = !state.autoTrade; persist(); emit(); }

  // ---------- режимы: демо / реальный рынок ----------
  function setMode(mode) {
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
    state.liveOrders = [{ ...order, note: note || "", ts: Date.now() }, ...state.liveOrders].slice(0, 50);
    pushEvent({ tone: order.side === "лонг" ? "bull" : "bear", title: `Реальный ордер отправлен: ${order.sym} ${order.side === "лонг" ? "BUY" : "SELL"}`, detail: `${Fmt.fmtNum(Math.round(order.amountUSDT))} USDT · ${order.exchange}`, notify: { kind: "live_order" } });
    persist(); emit();
  }

  // ---------- ИИ-автопилот (спот-only) ----------
  // Тапович: спот без фьючерсов; ИИ заходит в любые монеты с потенциалом, мощная защита
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
  function aiTotalCap() {    // максимум суммы всех сделок (кламп: не меньше лимита одной)
    const v = Number(state.maxTotal);
    const d = aiDealCap();
    return Number.isFinite(v) ? Math.max(d, Math.min(1000000, Math.round(v))) : Math.max(d, 5000);
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
    const n = Math.round(Number(String(v).replace(/\s/g, "").replace(",", ".")));
    if (!Number.isFinite(n) || n < 5 || n > 100000) return { ok: false, error: "Максимум одной сделки — от 5 до 100 000 ХРЮ" };
    state.maxDeal = n;
    if (Number(state.maxTotal) < n) state.maxTotal = n; // суммарный не бывает меньше лимита одной
    pushEvent({ tone: "neutral", title: `Лимит одной сделки: до ${Fmt.fmtNum(n)} ХРЮ (≈ $${Fmt.fmtNum(n)})`, detail: `суммарный лимит ${Fmt.fmtNum(aiTotalCap())} ХРЮ → до ${autoMaxPos()} одновременных сделок · действует на ручные, ИИ- и сигнальные входы` });
    persist(); emit();
    return { ok: true };
  }
  function setMaxTotal(v) {
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
  function aiKellyFrac() {
    const b = state.aiBrain || {};
    // сглаженный винрейт (Лаплас, априор 50%): пока сделок мало — размер консервативен
    const p = ((b.wins || 0) + 3) / ((b.trades || 0) + 6);
    // Kelly для RR 1:2: f* = p − (1−p)/b, b=2 → f* = 1.5p − 0.5; берём четверть и кламп 2..10%
    const f = 1.5 * p - 0.5;
    return Math.max(0.02, Math.min(0.1, 0.25 * Math.max(0, f)));
  }
  function aiSizeCalc() {
    const cap = aiDealCap();
    const remain = aiTotalRemain();
    let size = Math.round(state.balance * aiKellyFrac());
    size = Math.min(size, cap, Math.round(remain), Math.round(state.balance));
    const floor = Math.min(AI_MIN_SIZE, cap);
    if (!Number.isFinite(size) || size < floor) {
      if (state.balance >= floor && remain >= floor) size = floor;
      else return { size: 0, why: "не хватает свободных хрювен или суммарного лимита" };
    }
    if (size <= 0) return { size: 0, why: "нулевой размер" };
    return { size, why: "ок" };
  }
  function setAiThreshold(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 5 || n > 500) return { ok: false, error: "Лимит сессии — от 5% до 500%" };
    state.aiThreshold = n;
    pushEvent({ tone: "neutral", title: `Лимит сессии ИИ изменён: ±${n}%`, detail: "Автопилот закроет все ИИ-сделки и выключится при +" + n + "% профита или −" + n + "% просадки от базы сессии" });
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

  // перегрев портфеля: больше 60% баланса в позициях — новых входов нет
  function heatGuard() {
    const bal = state.balance;
    const inMarket = openPositionsSum();
    if (bal > 0 && inMarket / bal > 0.6) return { ok: false, why: `портфель перегрет: ${Math.round((inMarket / bal) * 100)}% баланса в позициях` };
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
      state.balance += closed.size + closed.pnl; // возврат маржи + результат
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
    if (isAi) { brain.trades++; if (won) brain.wins++; else brain.losses++; }

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
    const st = brain.symStats[c.sym] || { n: 0, wins: 0, streak: 0, avgPct: 0 };
    st.n++;
    if (won) { st.wins++; st.streak = st.streak < 0 ? 1 : st.streak + 1; }
    else { st.streak = st.streak > 0 ? -1 : st.streak - 1; }
    st.avgPct = (st.avgPct * (st.n - 1) + (c.pnlPct || 0)) / st.n;
    brain.symStats[c.sym] = st;
    const sFlag = c.sym + "-streak" + st.streak;
    if (st.streak <= -3 && st.n >= 4 && !brain.wFlags[sFlag]) {
      brain.wFlags[sFlag] = 1;
      pushLesson(brain, `осторожнее с ${c.sym}: ${Math.abs(st.streak)} минуса подряд — уверенность на этой монете снижена`);
    }

    // 3) калибровка порога входа — по ИИ-сделкам: если сигналы чаще закрываются в минус — ИИ требует больше уверенности
    const winrate = brain.wins / brain.trades;
    if (isAi && brain.trades >= 6) {
      if (winrate < 0.45 && brain.confThreshold < 88) {
        brain.confThreshold++;
        pushLesson(brain, `поднял порог входа до ${brain.confThreshold}%: сигналы слишком часто закрывались в минус`);
      } else if (winrate >= 0.62 && brain.confThreshold > 70) {
        brain.confThreshold--;
        pushLesson(brain, `снизил порог входа до ${brain.confThreshold}%: качество сигналов высокое`);
      }
    }
    brain.updatedAt = Date.now();
    saveGlobalBrainLocal(); // глобальная память: сразу на устройство (общая для всех аккаунтов)
    scheduleBrainPush();    // и в облако (debounce 4с) — чтобы все пользователи и устройства имели один мозг
    persist();
  }

  // сдвиг уверенности по опыту монеты: серия минусов — осторожнее, серия плюсов — чуть смелее
  function symBias(sym) {
    const st = state.aiBrain.symStats[sym];
    if (!st || st.n < 3) return 0;
    if (st.streak >= 3) return 3;
    if (st.streak <= -3) return -Math.min(10, 2 * Math.abs(st.streak));
    return 0;
  }

  function updateIdeas(sym, res, guard) {
    const rest = state.aiIdeas.filter((i) => i.sym !== sym);
    if (res.verdict !== "wait") rest.push({ sym, res, guard, ts: Date.now() });
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
        detail: `${Fmt.fmtNum(size)} ХРЮ (≈ ${Fmt.fmtUsd(size)}) · спот · защита: ${guardWhy} · стоп/цель по ATR`,
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

    const aiPos = state.userPositions.find((p) => p.sym === sym && p.strategy === "ai");
    const aiCount = state.userPositions.filter((p) => p.strategy === "ai").length;
    const thr = brain.confThreshold || 76;
    const effConf = res.confidence + symBias(sym); // уверенность с поправкой на опыт монеты

    // флип: ИИ сам считает нужным развернуться (спот: продажа/выход в кэш).
    // Флип — реакция на РАЗВОРОТ картины факторов, а НЕ способ выйти из убытка:
    // гейт flipAllowed запрещает закрывать флипом убыточную позицию раньше стопа.
    if (aiPos && res.verdict !== "wait" && res.verdict !== aiPos.side) {
      const fg = flipAllowed(aiPos, res, effConf, thr, sym);
      if (fg.ok) {
        const price0 = (state.prices[sym] && state.prices[sym].price) || aiPos.entry;
        const closed = Engine.closeTrade(aiPos, price0, "ИИ-флип");
        state.userPositions = state.userPositions.filter((p) => p.id !== aiPos.id);
        state.userClosed = [closed, ...state.userClosed].slice(0, 300);
        state.balance += closed.size + closed.pnl;
        learnFromClosed(closed);
        state._flipAt = { ...(state._flipAt || {}), [sym]: Date.now() };
        pushEvent({
          tone: res.verdict === "лонг" ? "bull" : "bear",
          title: `ИИ флипнул ${sym}: ${aiPos.side} → ${res.verdict}`, detail: `закрыто по ${closed.pnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(closed.pnl)))} ХРЮ (≈ ${closed.pnl >= 0 ? "+" : "−"}$${Fmt.fmtNum(Math.abs(Math.round(closed.pnl)))}) · разворот факторов (уверенность ${res.confidence}%)`, sym,
          notify: { kind: "ai_flip", data: { pnl: closed.pnl } },
        });
        const sc = aiSizeCalc();
        if (guard.ok && rg.ok && sc.size > 0) aiOpenInternal(res, sc.size, true, "скам-фильтр, новости и риск-гвард ок");
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

    // вход: уверенность ≥ обученного порога + факторы односторонни + все гварды + лимиты позиций и сумм
    if (!aiPos && res.verdict !== "wait" && effConf >= thr && (res.agreeShare == null || res.agreeShare >= 0.55) && aiCount < effMaxPos()) {
      if (!guard.ok || !rg.ok) return;
      if (!heatGuard().ok) return;
      const sc = aiSizeCalc();
      if (sc.size <= 0) return;
      aiOpenInternal(res, sc.size, true, "скам-фильтр, новости и риск-гвард ок");
      persist();
    }
  }

  function toggleAiAuto(forceOn) {
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
    state.lastScanAt = Date.now(); // хартбит: сканер жив (виден в «Сигналах» и «Кабинете»)
    const price = (state.prices[sym] && state.prices[sym].price) || bars[bars.length - 1].c;

    // 0) ИИ-автопилот: сканер всех монет, входы, флипы (спот-only, со скам-фильтром)
    try { aiAutoStep(sym, bars); } catch (e) { console.error(e); }

    // 1) сигналы стратегий
    for (const strat of Engine.STRATEGIES) {
      const sig = Engine.evalStrategy(strat.id, sym, bars);
      if (!sig) continue;
      const key = `${sig.strategy}-${sym}`;
      if (key === lastSignalKey) continue;
      if (state.labPositions.some((p) => p.sym === sym && p.strategy === strat.id)) continue;
      lastSignalKey = key;
      state.signals = [sig, ...state.signals.filter((x) => !(x.sym === sym && x.strategy === strat.id))].slice(0, 40);
      pushEvent({ tone: "bull", title: `${strat.name}: сигнал по ${sym} · ${sig.confidence}%`, detail: sig.note, sym, notify: { kind: "signal" } });

      // 2) автоторговля лаборатории — сделка стратегии получает снапшот факторов,
      //    чтобы её закрытие обучило общий мозг ИИ (лаборатория — учебные данные)
      if (!state.autoTrade) continue;
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
      const ex = Engine.evalExit(p, bars, price);
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
      const ex = Engine.evalExit(p, bars, price);
      if (ex) exits.push({ pos: p, closed: Engine.closeTrade(p, ex.price, ex.reason) });
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
      state.balance += userClosedAdd.reduce((sum, c) => sum + c.size + c.pnl, 0);
      for (const c of userClosedAdd) learnFromClosed(c); // ИИ учится на авто-выходах (стоп/цель/флип/безубыток)
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
        pushEvent({
          tone: e.closed.pnl >= 0 ? "bull" : "bear",
          title: `${e.pos.owner === "lab" ? "Лаборатория" : "Демо"}: ${e.pos.sym} закрыта ${e.closed.exitReason.toLowerCase()} · ${e.closed.pnl >= 0 ? "+" : "−"}${Fmt.fmtNum(Math.abs(Math.round(e.closed.pnl)))} ХРЮ (≈ ${e.closed.pnl >= 0 ? "+" : "−"}$${Fmt.fmtNum(Math.abs(Math.round(e.closed.pnl)))})`,
          detail: `стратегия: ${(Engine.STRATEGIES.find((x) => x.id === e.pos.strategy) || { name: "вручную" }).name}`,
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

  // ---------- симуляция при недоступности Binance ----------
  let simTimer = null;
  function simTick() {
    const rand = Math.random;
    const now = Date.now();
    for (const sym of WATCH_SYMS) {
      const p = state.prices[sym];
      const chg = (rand() - 0.5) * 0.0018;
      const np = p.price * (1 + chg);
      p.prev = p.price;
      p.price = np;
      p.chg24h = p.chg24h * 0.999 + (np / p.open24 - 1) * 100 * 0.001;
      p.high24 = Math.max(p.high24, np);
      p.low24 = Math.min(p.low24, np);
      p.vol24 += Math.abs(chg) * np * 50000;
      p.spark = [...p.spark.slice(1), np];
      p.ts = now;
    }
    // двигаем последнюю свечу 15м каждого инструмента
    for (const sym of WATCH_SYMS) {
      const key = `${sym}:15м`;
      const bars = state.bars[key];
      const np = state.prices[sym].price;
      if (bars && bars.length) {
        const last = bars[bars.length - 1];
        last.c = np;
        last.h = Math.max(last.h, np);
        last.l = Math.min(last.l, np);
        last.v += Math.random() * 900;
      } else {
        const p0 = np;
        state.bars[key] = Candles.genCandles({ seed: sym.length * 31 + sym.charCodeAt(0), n: 110, start: p0 * 0.985, end: p0, stepMin: 15, volBase: 0.008 });
      }
    }
    // каждые ~25 тиков (~40с) прогоняем движок по одному инструменту
    simCount++;
    if (simCount % 25 === 0) {
      const sym = WATCH_SYMS[simCount / 25 % WATCH_SYMS | 0];
      engineStep(sym, state.bars[`${sym}:15м`]);
    }
    emit();
  }
  let simCount = 0;

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

  // консервативное внутрисвечное исполнение: если за бар цена задевала и стоп, и цель —
  // первым считаем стоп (худший случай, как в реальной торговле)
  function catchExitOnBar(pos, bar) {
    const dir = pos.side === "лонг" ? 1 : -1;
    const hitStop = dir === 1 ? bar.l <= pos.stop : bar.h >= pos.stop;
    const hitTarget = dir === 1 ? bar.h >= pos.target : bar.l <= pos.target;
    if (hitStop) return { reason: "Стоп", price: pos.stop };
    if (hitTarget) return { reason: "Цель", price: pos.target };
    return null;
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
    state.balance += closed.size + closed.pnl;
    learnFromClosed(closed);
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
    if (state.degraded) return Promise.resolve(false); // нет реальных источников — симуляция уже «живёт»
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
        if (newStop != null) pos.stop = newStop;
      }

      // 3) выходы (стоп/цель — внутрисвечно, консервативно; тренд-сигнал — по закрытию,
      //    у новой политики он работает для лонга и шорта и только при плюсе)
      for (const pos of [...state.userPositions]) {
        if (pos.sym !== sym) continue;
        const hit = catchExitOnBar(pos, bar);
        const sig = !hit && barsUpTo.length >= 22 ? Engine.evalExit(pos, barsUpTo, bar.c) : null;
        const ex = hit || (sig && sig.reason !== "Цель" && sig.reason !== "Стоп" ? sig : null);
        if (ex) {
          const closed = catchClosePosition(pos, ex.price, ex.reason, ts);
          st.closed++; st.sum += closed.pnl;
        }
      }
      // лаборатория: те же правила выходов
      for (const pos of [...state.labPositions]) {
        if (pos.sym !== sym) continue;
        const hit = catchExitOnBar(pos, bar);
        const sig = !hit && barsUpTo.length >= 22 && pos.side === "лонг" ? Engine.evalExit(pos, barsUpTo, bar.c) : null;
        const ex = hit || (sig && sig.reason !== "Цель" && sig.reason !== "Стоп" ? sig : null);
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
        state.degraded = false;
        state.lastSync = now;
        state.source = Binance.sourceName();
        if (simTimer) { clearInterval(simTimer); simTimer = null; }
        emit();
      } catch (e) {
        state.degraded = true;
        if (!simTimer) simTimer = setInterval(simTick, 1600);
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
          // деградация: сим-свечи + шаг движка
          const p = (state.prices[sym] && state.prices[sym].price) || DEFAULT_PRICES[sym] || 1;
          if (!state.bars[`${sym}:15м`]) {
            state.bars[`${sym}:15м`] = Candles.genCandles({ seed: sym.length * 31 + sym.charCodeAt(0), n: 110, start: p * 0.985, end: p, stepMin: 15, volBase: 0.008 });
          }
          state.degraded = true;
          if (!simTimer) simTimer = setInterval(simTick, 1600);
          engineStep(sym, state.bars[`${sym}:15м`]);
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
      persist();
      emit();
    }, 30000);
  }

  return {
    state, subscribe, emit, onFastTick, onNotify, start, getBars, ensureBars,
    placeDemo, closeDemo, setBalance, resetDemo, toggleAuto,
    loadWhales, setActiveSym, totalEquity, switchUser, canTrade,
    setMode, toggleAiAuto, recordLiveOrder, aiSessionInfo,
    setAiThreshold, closeAllAiPositions, brainSyncInfo, setAiMaxPos, aiMaxPos,
    // лимиты сделок: макс. одной + суммарный + авторасчёт одновременных позиций
    setMaxDeal, setMaxTotal, setAiPosMode, aiDealCap, aiTotalCap, aiTotalRemain,
    openPositionsSum, autoMaxPos, effMaxPos, aiSizeCalc, aiKellyFrac,
    // жизнь без пользователя + синхронизация устройств
    catchUp, catchInfo: () => ({ lastCatchUp: state.lastCatchUp, lastRun: catchCtl.lastRun, busy: catchCtl.busy }),
    enableSync, syncPush, syncPull, syncInfo, exportBackup, importBackup, archiveAccount,
    clearClosedHistory,
    effAuto,
    // внутренности для юнит-тестов
    _flipAllowed: flipAllowed, _riskGuard: riskGuard, _heatGuard: heatGuard, _aiLossStreak: aiLossStreak,
    _aiAutoStep: aiAutoStep, _diagInfo: () => ({ count: diagCount, foreign: foreignCount }),
    _diagReset: () => { lastDiagAt = 0; diagSeen.clear(); diagCount = 0; foreignCount = 0; }, // только для юнит-тестов
    _mergeArchives: mergeArchives, _applyArchive: applyArchive, _fpOf: fpOf, _diagError: diagError,
    _trimForCloud: trimForCloud, _isVirginArchive: isVirginArchive,
    _persist: persist,
    _pairToSym: (p) => PAIR_TO_SYM[p] || null,
  };
})();

window.Store = Store;
