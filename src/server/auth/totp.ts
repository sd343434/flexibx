import { createHmac, timingSafeEqual } from "node:crypto";

import { symmetricDecrypt } from "better-auth/crypto";

// RFC 6238 TOTP, matching Better Auth's two-factor plugin (6 digits, 30-second steps,
// HMAC-SHA-1 keyed with the UTF-8 bytes of the stored secret, ±1 step window). Used by
// the operator-side admin grant, which checks a code against the stored secret without
// a browser challenge. Pure; cross-checked against the plugin in the tests.

/** The stored (encrypted) two-factor secret in clear, as Better Auth decrypts it. */
export function decryptTotpSecret(authSecret: string, stored: string): Promise<string> {
  return symmetricDecrypt({ key: authSecret, data: stored });
}

const PERIOD_MS = 30_000;
const DIGITS = 6;

function hotp(secret: string, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", Buffer.from(secret, "utf8")).update(message).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const value = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return value.toString().padStart(DIGITS, "0");
}

/** True when `code` is the TOTP of `secret` for the current step or one step either side. */
export function verifyTotpCode(secret: string, code: string, now: Date): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const step = Math.floor(now.getTime() / PERIOD_MS);
  let matched = false;
  for (let offset = -1; offset <= 1; offset += 1) {
    const expected = Buffer.from(hotp(secret, step + offset));
    // Every step is compared (no early exit), each in constant time.
    matched = timingSafeEqual(expected, Buffer.from(code)) || matched;
  }
  return matched;
}
