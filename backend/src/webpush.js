// XenoAI Trade — СЕРВЕР: Web Push отправитель (RFC 8291 aes128gcm + RFC 8292 VAPID ES256)
// на Web Crypto (работает и в Cloudflare Workers, и в Node 18+ — тесты прогоняют оба пути).
// Тот же VAPID-пара, что вшит в браузер (js/notify.js) и Страж (tools/webpush.js):
// подписки, созданные раньше, продолжают принимать пуши без пересоздания.
"use strict";

const VAPID_PUB = "BEwaHaeQPCSGfyskYFUA4rvij2rNV2NDBo8Gq54cHKVvwHNNsOb6fzUWjW_UdUBBMpY_NxsvZ5fwylHYPIq2PtE";
const VAPID_PRIV = "at9_zcSQPZNEEcEd-9DvIXwi0cyo8In-Xe1ZyKYgnDM";
const VAPID_SUB = "mailto:xenoai-trade@users.noreply.github.com";

// ---------- base64url ----------
const enc = new TextEncoder();
export function b64uEncode(bytes) {
  let bin = "";
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64uDecode(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- EC JWK из «сырых» байтов ----------
function jwkFromRaw(pubRaw, privRaw) {
  const pub = pubRaw ? b64uDecode(pubRaw) : null;
  const d = privRaw ? b64uDecode(privRaw) : null;
  if (pub && (pub.length !== 65 || pub[0] !== 0x04)) throw new Error("p256dh: ожидалось 65 байт (0x04||X||Y)");
  const jwk = { kty: "EC", crv: "P-256" };
  if (pub) { jwk.x = b64uEncode(pub.slice(1, 33)); jwk.y = b64uEncode(pub.slice(33, 65)); }
  if (d) { jwk.d = b64uEncode(d); }
  return jwk;
}

// ---------- RFC 8291: шифрование payload (aes128gcm) ----------
// Возвращает тело запроса: salt(16) || rs(4 BE) || idlen(1) || keyid(65) || ciphertext||tag
export async function encryptPayload(subP256dh, plaintext) {
  const pt = enc.encode(String(plaintext));
  if (pt.length + 1 > 4096) throw new Error("payload > 4095 байт");
  const subPub = await crypto.subtle.importKey(
    "jwk", jwkFromRaw(subP256dh, null),
    { name: "ECDH", namedCurve: "P-256" }, false, []
  );
  // эфемерный ключ отправителя на каждое сообщение
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: subPub }, eph.privateKey, 256
  ));
  // PRK_key = HKDF(0^32, ecdh_secret, "WebPush: info" || 0x00 || client_pub || as_pub, 32)
  const baseKey = await crypto.subtle.importKey("raw", ecdhSecret, "HKDF", false, ["deriveBits"]);
  const infoLabel = enc.encode("WebPush: info");
  const subPubRaw = b64uDecode(subP256dh);
  const infoBytes = new Uint8Array(infoLabel.length + 1 + subPubRaw.length + asPubRaw.length);
  infoBytes.set(infoLabel, 0);
  infoBytes.set([0x00], infoLabel.length);
  infoBytes.set(subPubRaw, infoLabel.length + 1);
  infoBytes.set(asPubRaw, infoLabel.length + 1 + subPubRaw.length);
  const prkKey = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: infoBytes }, baseKey, 256
  ));

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prkKeyObj = await crypto.subtle.importKey("raw", prkKey, "HKDF", false, ["deriveBits"]);
  const cek = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("Content-Encoding: aes128gcm\0") }, prkKeyObj, 128
  ));
  const nonce = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("Content-Encoding: nonce\0") }, prkKeyObj, 96
  ));

  // запись: payload || 0x02 (последняя запись)
  const record = new Uint8Array(pt.length + 1);
  record.set(pt, 0);
  record[pt.length] = 0x02;

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, record));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, record.length, false);
  const head = new Uint8Array(16 + 4 + 1 + asPubRaw.length);
  head.set(salt, 0);
  head.set(rs, 16);
  head[20] = asPubRaw.length;
  head.set(asPubRaw, 21);
  const body = new Uint8Array(head.length + cipher.length);
  body.set(head, 0);
  body.set(cipher, head.length);
  return body;
}

// ---------- RFC 8292: VAPID JWT (ES256) ----------
// DER-подпись → «сырая» r||s (64 байта), как требует JOSE
export function derToRawSig(der) {
  let off = 0;
  if (der[off++] !== 0x30) throw new Error("bad sig");
  off++; // длина последовательности
  if (der[off++] !== 0x02) throw new Error("bad sig r");
  const rl = der[off++];
  const r = der.slice(off, off + rl); off += rl;
  if (der[off++] !== 0x02) throw new Error("bad sig s");
  const sl = der[off++];
  let s = der.slice(off, off + sl);
  const pad = (b) => {
    const out = new Uint8Array(b);
    let start = 0;
    while (out.length - start > 32 && out[start] === 0) start++; // ASN.1 ведущий 0x00
    const core = out.slice(start);
    const res = new Uint8Array(32);
    res.set(core.length > 32 ? core.slice(core.length - 32) : core, 32 - Math.min(32, core.length));
    return res;
  };
  const rr = pad(r), ss = pad(s);
  const out = new Uint8Array(64);
  out.set(rr, 0);
  out.set(ss, 32);
  return out;
}

export async function vapidHeader(endpoint, subClaim) {
  const aud = new URL(endpoint).origin;
  const header = b64uEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64uEncode(enc.encode(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subClaim || VAPID_SUB,
  })));
  const input = header + "." + claims;
  const jwk = jwkFromRaw(VAPID_PUB, VAPID_PRIV);
  jwk.key_ops = ["sign"];
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const derSig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(input)));
  // Web Crypto отдаёт подпись ECDSA сразу в «сыром» виде r||s (64 байта);
  // на всякий случай поддержан и DER-вариант (старые реализации).
  const raw = (derSig.length === 64) ? derSig : derToRawSig(derSig);
  const jwt = input + "." + b64uEncode(raw);
  return `vapid t=${jwt}, k=${VAPID_PUB}`;
}

// ---------- отправка ----------
// sub: { endpoint, keys: { p256dh, auth } } — как лежит в аккаунте.
// { ok, status, dead }: dead → подписка умерла (404/410/400), её вычищаем.
export async function sendPush(sub, payload, opts) {
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return { ok: false, status: 0, dead: true, why: "неполная подписка" };
  }
  try {
    const body = await encryptPayload(sub.keys.p256dh, JSON.stringify(payload || {}));
    const auth = await vapidHeader(sub.endpoint);
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "aes128gcm",
        TTL: String((opts && opts.ttl) || 3600),
        Urgency: (opts && opts.urgency) || "normal",
      },
      body,
      signal: AbortSignal.timeout((opts && opts.timeoutMs) || 9000),
    });
    const dead = res.status === 404 || res.status === 410 || res.status === 400;
    return { ok: res.ok, status: res.status, dead };
  } catch (e) {
    return { ok: false, status: 0, dead: false, why: String((e && e.message) || e) };
  }
}

export const VAPID_PUBLIC = VAPID_PUB;
