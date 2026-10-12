import { createHmac } from "node:crypto";

// TOTP exactly as an authenticator app computes it (RFC 6238 / 4226: SHA-1, 6 digits,
// 30-second steps), from the base32 setup key Flexibx shows at enrollment.

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of input.replace(/=+$/, "").toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error("bad base32");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
export function totp(key: string, offsetSteps = 0): string {
  const counter = Math.floor(Date.now() / 30_000) + offsetSteps;
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", base32Decode(key)).update(message).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0xf;
  const value = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return value.toString().padStart(6, "0");
}
/** A valid code that is certainly not the current one (and not accepted in the window). */
export const wrongCode = (key: string) => {
  const valid = new Set([totp(key, -1), totp(key), totp(key, 1)]);
  let code = 0;
  while (valid.has(code.toString().padStart(6, "0"))) code += 1;
  return code.toString().padStart(6, "0");
};
