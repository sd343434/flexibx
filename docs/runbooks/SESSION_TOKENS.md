# Session tokens at rest — deploy, rollback, roll-forward (Pass 40, updated Pass 41)

Code: `src/server/auth/session-token-hash.ts` (Pass 39). Migration:
`prisma/migrations/20261023120000_hash_session_tokens/migration.sql`. The browser cookie
still carries the raw token (signed with `AUTH_SECRET`); `sessions.token` holds
`h1$` + SHA-256 of it.

## 1. Deploy (forward)

The release's `migrate` job applies the migration (hashing every row not yet prefixed, in
one transaction) and then runs `scripts/ops/rehash-session-tokens.sh`. After
`up -d app worker scheduler`, run `docker compose run --rm rehash-sessions` once
(**mandatory**): the previous release keeps serving until the switch and writes raw tokens
meanwhile; without it, only those users would be signed out. No mass revocation is needed
or performed. Watch sign-in errors and `SELECT count(*) FROM sessions` for an hour.

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

## 3. Roll forward again after a rollback (mandatory step)

Sessions from before the rollback work again (their rows stayed). Sessions created
**during** the rollback were stored raw; Prisma will not re-run the applied migration, so
they are found only after the rehash. The same two steps as § 1 do it: `migrate` (ends with
the rehash) and, after `up -d`, `docker compose run --rm rehash-sessions`.

`scripts/ops/rehash-session-tokens.sh` (Pass 41): owner login from `REHASH_DATABASE_URL`
(never on a command line, `lib/pgenv.sh`); asserts nothing itself — the Compose job asserts
the staging marker first; changes only `sessions.token` of rows not yet prefixed; prints
`{"status":"OK","rehashed":N,"sessions":M}` and never a token or the URL. Tested in
`tests/integration/session-rehash-script.test.ts` (sessions from both releases; every
other column, users and accounts unchanged; second run rehashes 0; unreachable database
fails without printing the password; two mutants caught).

| Situation                                 | Users keep their session?                          |
| ----------------------------------------- | -------------------------------------------------- |
| Forward deploy with both steps            | Yes                                                |
| Forward deploy, `rehash-sessions` skipped | All but those who signed in during the switch      |
| Rollback to a pre-Pass-39 release         | **No** — everyone signs in again once              |
| Roll-forward after a rollback, both steps | Yes (sessions from before and during the rollback) |

## 4. Emergency: sign everyone out

Rotate `AUTH_SECRET` (cookies stop verifying) or `DELETE FROM sessions` as the owner login.
Either is a **mass revocation**: owner approval and a user notice first.
