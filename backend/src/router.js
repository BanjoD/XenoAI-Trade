// XenoAI Trade — СЕРВЕР: главный Worker (роутер API + cron-триггер).
// Аутентификация: POST /api/login по логину/паролю (хэши ниже) → HMAC-токен (30 дней).
// Все /api/* — тонкий прокси в Durable Object «Room» конкретного аккаунта:
// единый писатель, серверное исполнение всех действий аккаунта.
"use strict";

import { json, BUILD } from "./room.js";

// ВАЖНО: Durable Object-классы Cloudflare обязан находить среди ЭКСПОРТОВ точки
// входа воркера. Если класс не экспортирован — runtime падает при инициализации,
// и КАЖДЫЙ запрос получает «Error 1101: Worker threw exception» (Node-импорт и
// локальные тесты этого не видят — там DO-биндингов не существует).
export { Room } from "./room.js";

// sha256("xenoai-backend-v1|<логин>:<пароль>") — пароли те же, что в js/auth.js
// (платформа-прототип с публичным репо; здесь только хэши)
const ADMIN_HASHES = {
  david: "17468b4b0218689d0fb05a4bc9b09b62125cda365b43e8c4877abdb6ee01257c",
  yura: "06a1b420882b610af3adb63e5945e7f7bf0de159cb91aec392aeb2f20db2e849",
};

const TOKEN_TTL = 30 * 24 * 3600; // 30 дней
const enc = new TextEncoder();
const b64u = (bytes) => {
  let bin = "";
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64uDecodeStr = (s) => {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return atob(s);
};

async function signToken(env, login) {
  const key = await crypto.subtle.importKey("raw", enc.encode(env.ADMIN_TOKEN_SECRET || ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const payload = b64u(enc.encode(JSON.stringify({ login, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL })));
  const sig = b64u(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
  return payload + "." + sig;
}
async function verifyToken(env, token) {
  try {
    if (!token || token.indexOf(".") < 0) return null;
    const [payload, sig] = token.split(".");
    const key = await crypto.subtle.importKey("raw", enc.encode(env.ADMIN_TOKEN_SECRET || ""), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const sigBytes = Uint8Array.from(b64uDecodeStr(sig), (c) => c.charCodeAt(0));
    const okSig = await crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(payload));
    if (!okSig) return null;
    const claims = JSON.parse(b64uDecodeStr(payload));
    if (!claims || !claims.login || (claims.exp || 0) < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch (e) { return null; }
}
async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return Array.from(new Uint8Array(buf)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};
function jsonCors(obj, status) {
  const res = json(obj, status);
  for (const k in CORS) res.headers.set(k, CORS[k]);
  return res;
}

function roomStub(env, login) {
  const id = env.ROOMS.idFromName(String(login).toLowerCase());
  return env.ROOMS.get(id);
}
async function roomFetch(env, login, path, init) {
  const stub = roomStub(env, login);
  const headers = Object.assign({}, (init && init.headers) || {}, { "x-login": String(login).toLowerCase() });
  return stub.fetch("https://room" + path, { ...init, headers });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    try {
      // ---------- публичные ----------
      if (path === "/api/meta" || path === "/") {
        const accounts = String(env.ACCOUNTS || "david,yura").split(",").map((s) => s.trim()).filter(Boolean);
        const rooms = {};
        await Promise.all(accounts.map(async (login) => {
          try {
            const r = await roomFetch(env, login, "/meta", { method: "POST" });
            rooms[login] = await r.json();
          } catch (e) { rooms[login] = { ok: false, error: String(e && e.message || e) }; }
        }));
        return jsonCors({ ok: true, build: BUILD, now: Date.now(), autonomous: true, rooms });
      }

      if (path === "/api/login" && req.method === "POST") {
        const { login, password } = await req.json().catch(() => ({}));
        const lv = String(login || "").trim().toLowerCase();
        const h = await sha256hex("xenoai-backend-v1|" + lv + ":" + String(password || ""));
        if (!ADMIN_HASHES[lv] || h !== ADMIN_HASHES[lv]) {
          return jsonCors({ ok: false, error: "Неверный логин или пароль" }, 401);
        }
        const token = await signToken(env, lv);
        return jsonCors({ ok: true, login: lv, token, build: BUILD });
      }

      // ---------- с токеном ----------
      const auth = req.headers.get("Authorization") || "";
      const token = auth.replace(/^Bearer\s+/i, "").trim();
      const claims = await verifyToken(env, token);
      if (!claims) return jsonCors({ ok: false, error: "нужен вход (токен отсутствует или истёк)" }, 401);
      const login = String(claims.login).toLowerCase();

      if (path === "/api/state") {
        const r = await roomFetch(env, login, "/state");
        return jsonCors(await r.json(), r.status);
      }
      if (path === "/api/action" && req.method === "POST") {
        const body = await req.text();
        const r = await roomFetch(env, login, "/action", { method: "POST", body, headers: { "Content-Type": "application/json" } });
        return jsonCors(await r.json(), r.status);
      }
      if (path === "/api/bootstrap" && req.method === "POST") {
        const body = await req.text();
        const r = await roomFetch(env, login, "/bootstrap", { method: "POST", body, headers: { "Content-Type": "application/json" } });
        return jsonCors(await r.json(), r.status);
      }

      return jsonCors({ ok: false, error: "неизвестный маршрут: " + path }, 404);
    } catch (e) {
      return jsonCors({ ok: false, error: String((e && e.message) || e) }, 500);
    }
  },

  // cron */2: тик автономной торговли по каждому аккаунту (дублирует alarm — страховка)
  async scheduled(event, env, ctx) {
    const accounts = String(env.ACCOUNTS || "david,yura").split(",").map((s) => s.trim()).filter(Boolean);
    ctx.waitUntil(Promise.all(accounts.map(async (login) => {
      try { await roomFetch(env, login, "/tick", { method: "POST" }); } catch (e) { /* alarm подстрахует */ }
    })));
  },
};
