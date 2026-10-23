-- Pass 39: session tokens at rest are SHA-256 hashes ('h1$' || hex), written and matched by
-- src/server/auth/session-token-hash.ts. This hashes the rows written before it, so every
-- signed-in user stays signed in with the same cookie. Idempotent (already hashed rows are
-- skipped). Rolling back the application past this change signs everyone out once (old
-- code compares the raw cookie with the hash): no data is lost.
BEGIN;
UPDATE "sessions"
SET "token" = 'h1$' || encode(sha256(convert_to("token", 'UTF8')), 'hex')
WHERE "token" NOT LIKE 'h1$%';
COMMIT;
