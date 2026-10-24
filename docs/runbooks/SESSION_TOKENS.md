# Session tokens at rest — deploy, rollback, roll-forward (Pass 40)

Code: `src/server/auth/session-token-hash.ts` (Pass 39). Migration:
`prisma/migrations/20261023120000_hash_session_tokens/migration.sql`. The browser cookie
still carries the raw token (signed with `AUTH_SECRET`); `sessions.token` holds
`h1$` + SHA-256 of it.

## 1. Deploy (forward)

The release's `migrate` job applies the migration with the rest. It hashes every row not
yet prefixed, in one transaction; users stay signed in. No mass revocation is needed or
performed. Watch sign-in errors and `SELECT count(*) FROM sessions` for an hour.

Production: this behaviour change needs **its own owner approval** (it is not implied by an
approval to deploy staging).

## 2. Rollback to a release before Pass 39 (e.g. `a463d1c`)

Redeploy the previous image tag (`up -d`); do not touch the database.

| What happens                                          | Tested in                                      |
| ----------------------------------------------------- | ---------------------------------------------- |
| Every user is signed out once (hashed rows not found) | `session-token-hash.test.ts` "rollback signs…" |
| No error; rows stay in the table                      | same                                           |
| Signing in again works (the old release stores raw)   | same                                           |

No data is lost. There is no reverse migration: hashes cannot be turned back into tokens.

## 3. Roll forward again after a rollback

Sessions from before the rollback work again (their rows stayed). Sessions created
**during** the rollback were stored raw and are not found until the hashing statement runs
again — Prisma will not re-run an applied migration. Run it once, as the owner login, from
the ops image of the release (idempotent; verified Pass 40 against a scratch database: a raw
row was hashed, a second run changed nothing):

```bash
docker compose -f deploy/staging/compose.yaml --profile jobs run --rm --entrypoint bash migrate -c \
  'psql "$OWNER_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 \
     -f prisma/migrations/20261023120000_hash_session_tokens/migration.sql'
```

Skipping it only signs out the users who signed in during the rollback window.

## 4. Emergency: sign everyone out

Rotate `AUTH_SECRET` (cookies stop verifying) or `DELETE FROM sessions` as the owner login.
Either is a **mass revocation**: owner approval and a user notice first.
