import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// RFC 6238 TOTP over HMAC-SHA1, 6 digits, 30-second steps. No dependency —
// the algorithm is ~30 lines and widely understood.
const STEP_SECONDS = 30;
const DIGITS = 6;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** 160-bit random secret as base32 (the encoding authenticator apps expect). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(secret: string): Buffer {
  const clean = secret.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32 secret");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: bigint): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(counter);
  const digest = createHmac("sha1", secret).update(buf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(code % 10 ** DIGITS).padStart(DIGITS, "0");
}

/** The code valid right now; exported so tests and the UI share one clock. */
export function totpNow(secret: string, at: Date = new Date()): string {
  return hotp(base32Decode(secret), BigInt(Math.floor(at.getTime() / 1000 / STEP_SECONDS)));
}

/**
 * Constant-time comparison across the current step and one step on either
 * side — a small clock skew between server and authenticator is normal.
 */
export function verifyTotp(secret: string, code: string, at: Date = new Date()): boolean {
  const clean = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  const key = base32Decode(secret);
  const counter = Math.floor(at.getTime() / 1000 / STEP_SECONDS);
  const candidate = Buffer.from(clean);
  for (const step of [counter - 1, counter, counter + 1]) {
    const valid = Buffer.from(hotp(key, BigInt(step)));
    if (timingSafeEqual(valid, candidate)) return true;
  }
  return false;
}

/** otpauth:// URI for manual entry or QR rendering client-side. */
export function totpUri(secret: string, email: string, issuer = "NeuraDash"): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}
