import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Encryption of advertising platform access tokens at rest (pure; the key is passed in).
// AES-256-GCM with a random 96-bit IV per token. The additional authenticated data binds
// a ciphertext to its workspace and platform, so a token copied to another row or
// workspace does not decrypt. Envelope: `v1.<iv>.<tag>.<ciphertext>` (base64url).
// The key is ENCRYPTION_KEY (32 bytes); rotating it makes stored tokens unreadable, and
// the affected connections must be reconnected (no re-encryption job exists yet).

const VERSION = "v1";
const IV_BYTES = 12;

export interface TokenBinding {
  readonly workspaceId: string;
  readonly platform: string;
}

export class TokenVaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenVaultError";
  }
}

function keyFrom(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) throw new TokenVaultError("Encryption key must be 32 bytes");
  return key;
}

const aad = (binding: TokenBinding) =>
  Buffer.from(`flexibx:ad-token:v1:${binding.workspaceId}:${binding.platform}`, "utf8");

export function encryptToken(base64Key: string, token: string, binding: TokenBinding): string {
  if (token.length === 0) throw new TokenVaultError("Empty token");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(base64Key), iv);
  cipher.setAAD(aad(binding));
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, ciphertext]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".");
}

/** Throws TokenVaultError on any tampering, a wrong key or a different binding. */
export function decryptToken(base64Key: string, envelope: string, binding: TokenBinding): string {
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new TokenVaultError("Unknown envelope");
  const [, ivText, tagText, bodyText] = parts as [string, string, string, string];
  const iv = Buffer.from(ivText, "base64url");
  const tag = Buffer.from(tagText, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== 16) throw new TokenVaultError("Malformed envelope");
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFrom(base64Key), iv);
    decipher.setAAD(aad(binding));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(bodyText, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new TokenVaultError("Token cannot be decrypted");
  }
}
