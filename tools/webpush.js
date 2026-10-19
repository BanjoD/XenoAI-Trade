#!/usr/bin/env node
// XenoAI Trade — Web Push отправитель (RFC 8291 aes128gcm + RFC 8292 VAPID, ES256).
//
// ЗАЧЕМ: у статического сайта нет своего push-сервера, но отправка Web Push — это
// просто HTTP POST на endpoint подписки с шифрованным телом и VAPID-подписью. Страж
// (GitHub Actions) читает push-подписки устройств из архива аккаунта (они приезжают
// туда через синхронизацию) и шлёт пуши о сделках прямо в браузер/PWA — даже когда
// приложение полностью закрыто. Пользователю нужно только РАЗРЕШИТЬ уведомления.
//
// Реализация на чистом Node crypto (ноль npm-зависимостей, как и весь Страж):
//   • шифрование RFC 8291 (aes128gcm): эфемерный ECDH P-256, HKDF, AES-128-GCM;
//   • подпись RFC 8292 (VAPID): JWT ES256 с P-256 ключом, Authorization: vapid t=…, k=….
//
// Ключи: парта VAPID сгенерирована один раз и вшита ниже (публичный ключ в любом
// случае открыт — им подписан каждый браузерный push; приватный в публичном репо
// позволяет слать пуши ТОЛЬКО на известные подписки, а они лежат в облаке с личным
// кодом синхронизации). При желании ключи можно переопределить Secrets:
//   XENOAI_VAPID_PRIV / XENOAI_VAPID_PUB (base64url).
"use strict";

const crypto = require("crypto");

const VAPID_PUB = process.env.XENOAI_VAPID_PUB
  || "BEwaHaeQPCSGfyskYFUA4rvij2rNV2NDBo8Gq54cHKVvwHNNsOb6fzUWjW_UdUBBMpY_NxsvZ5fwylHYPIq2PtE";
const VAPID_PRIV = process.env.XENOAI_VAPID_PRIV
  || "at9_zcSQPZNEEcEd-9DvIXwi0cyo8In-Xe1ZyKYgnDM";
const VAPID_SUB = process.env.XENOAI_VAPID_SUB || "mailto:xenoai-trade@users.noreply.github.com";

// ---------- base64url ----------
const b64u = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function b64uDecode(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

// ---------- EC-ключи из «сырых» байтов ----------
// SEC1-обёртка приватного ключа P-256: 30 31 02 01 01 04 20 <d 32B> A0 0A 06 08 2A 86 48 CE 3D 03 01 07
const SEC1_PREFIX = Buffer.from("30310201010420", "hex");
const SEC1_SUFFIX = Buffer.from("a00a06082a8648ce3d030107", "hex");
// SPKI-обёртка публичного ключа P-256: 30 59 30 13 06 07 2A 86 48 CE 3D 02 01 06 08 2A 86 48 CE 3D 03 01 07 03 42 00 <65B>
const SPKI_PREFIX = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");

function privateKeyFromRaw(rawD) {
  const d = b64uDecode(rawD);
  if (d.length !== 32) throw new Error("VAPID приватный ключ: ожидалось 32 байта base64url, пришло " + d.length);
  return crypto.createPrivateKey({
    key: Buffer.concat([SEC1_PREFIX, d, SEC1_SUFFIX]),
    format: "der", type: "sec1",
  });
}
function publicKeyFromRaw(rawPub) {
  const pub = b64uDecode(rawPub);
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error("Подписка p256dh: ожидалось 65 байт (0x04||X||Y)");
  return crypto.createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, pub]),
    format: "der", type: "spki",
  });
}

// ---------- HKDF ----------
function hkdf(ikm, salt, info, len) {
  return Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, len));
}

// ---------- RFC 8291: шифрование payload (aes128gcm) ----------
// Возвращает тело запроса: salt(16) || rs(4) || idlen(1) || keyid(65) || ciphertext
function encryptPayload(subP256dh, plaintext) {
  const pt = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), "utf8");
  if (pt.length + 1 > 4096) throw new Error("payload слишком велик для Web Push (>4095 байт)");
  const subPub = publicKeyFromRaw(subP256dh);

  // эфемерный ключ отправителя на КАЖДОЕ сообщение
  const { privateKey: asPriv, publicKey: asPubKeyObj } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const asPubRaw = Buffer.from(asPubKeyObj.export({ type: "spki", format: "der" })).slice(-65); // 0x04||X||Y

  // ecdh_secret = ECDH(ephemeral_priv, subscription_pub)
  const ecdhSecret = crypto.diffieHellman({ privateKey: asPriv, publicKey: subPub });

  // PRK_key = HKDF(0^32, ecdh_secret, "WebPush: info" || 0x00 || client_pub || server_pub, 32)
  const infoKey = Buffer.concat([
    Buffer.from("WebPush: info", "utf8"), Buffer.from([0x00]),
    b64uDecode(subP256dh), asPubRaw,
  ]);
  const prkKey = hkdf(ecdhSecret, Buffer.alloc(32), infoKey, 32);

  const salt = crypto.randomBytes(16);
  const cek = hkdf(prkKey, salt, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16);
  const nonce = hkdf(prkKey, salt, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12);

  // запись: payload || 0x02 (маркер последней записи)
  const record = Buffer.concat([pt, Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  // заголовок aes128gcm: salt(16) || rs(4, big-endian) || idlen(1) || keyid(as_pub, 65)
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(record.length, 0);
  return Buffer.concat([salt, rs, Buffer.from([asPubRaw.length]), asPubRaw, ciphertext]);
}

// ---------- RFC 8292: VAPID JWT (ES256) ----------
// DER-подпись Node → «сырая» r||s (64 байта), как требует JOSE
function derToRawSig(der) {
  let off = 0;
  if (der[off++] !== 0x30) throw new Error("bad sig");
  off++; // длина последовательности
  if (der[off++] !== 0x02) throw new Error("bad sig r");
  const rl = der[off++];
  let r = der.slice(off, off + rl); off += rl;
  if (der[off++] !== 0x02) throw new Error("bad sig s");
  const sl = der[off++];
  let s = der.slice(off, off + sl);
  const pad = (b) => {
    b = Buffer.from(b);
    while (b.length > 32 && b[0] === 0) b = b.slice(1); // ASN.1 любит ведущий 0x00 перед старшим битом
    if (b.length < 32) return Buffer.concat([Buffer.alloc(32 - b.length), b]);
    return b;
  };
  return Buffer.concat([pad(r), pad(s)]);
}

function vapidHeader(endpoint, privKeyObj, pubB64u, subClaim) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64u(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subClaim,
  }));
  const input = header + "." + claims;
  const derSig = crypto.createSign("SHA256").update(input).sign(privKeyObj);
  const jwt = input + "." + b64u(derToRawSig(derSig));
  return `vapid t=${jwt}, k=${pubB64u}`;
}

// ---------- отправка ----------
// sub: { endpoint, keys: { p256dh, auth } } — как лежит в архиве аккаунта.
// Возвращает { ok, status, dead }: dead=true → подписка умерла (404/410), её вычищаем.
async function sendPush(sub, payload, opts) {
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return { ok: false, status: 0, dead: true, why: "неполная подписка" };
  }
  let privKeyObj;
  try {
    privKeyObj = privateKeyFromRaw(VAPID_PRIV);
  } catch (e) {
    return { ok: false, status: 0, dead: false, why: "VAPID приватный ключ не читается: " + e.message };
  }
  let body;
  try {
    body = encryptPayload(sub.keys.p256dh, JSON.stringify(payload || {}));
  } catch (e) {
    return { ok: false, status: 0, dead: false, why: "шифрование: " + e.message };
  }
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), (opts && opts.timeoutMs) || 9000);
  try {
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: vapidHeader(sub.endpoint, privKeyObj, VAPID_PUB, VAPID_SUB),
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "aes128gcm",
        TTL: String((opts && opts.ttl) || 3600),
        Urgency: (opts && opts.urgency) || "normal",
      },
      body,
      signal: ctl.signal,
    });
    const dead = res.status === 404 || res.status === 410 || res.status === 400;
    return { ok: res.ok, status: res.status, dead };
  } catch (e) {
    return { ok: false, status: 0, dead: false, why: (e && e.message) || "сеть" };
  } finally {
    clearTimeout(to);
  }
}

module.exports = {
  sendPush, encryptPayload, vapidHeader,
  _b64u: b64u, _b64uDecode: b64uDecode,
  _privateKeyFromRaw: privateKeyFromRaw, _publicKeyFromRaw: publicKeyFromRaw,
  _VAPID_PUB: VAPID_PUB, _VAPID_PRIV: VAPID_PRIV, _VAPID_SUB: VAPID_SUB,
};
