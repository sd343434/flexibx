# Flexibx

**Flexibx** (فلكسيبكس) is an Arabic-first AI Marketing Manager SaaS: it understands a
business's brand, plans and generates content, schedules and publishes it, analyzes the
results, and recommends what to do next.

This repository currently contains **Phase 1 — the production foundation**: a
Next.js application with Arabic (RTL) / English (LTR) routing, PostgreSQL + Prisma with
workspace (tenant) isolation, a unified localized error system, structured logging,
object-storage abstraction, tests, Docker and CI. Product modules (auth, brand, AI,
publishing, billing…) arrive in later phases — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Tech stack

| Area       | Choice                                                                        |
| ---------- | ----------------------------------------------------------------------------- |
| Runtime    | Node.js 22 (≥ 22.12), pnpm 10.28                                              |
| Web        | Next.js 16 (App Router, standalone output), React 19, TypeScript 6 (strict)   |
| UI         | Tailwind CSS 4, shadcn/ui-style primitives (Radix), next-themes, lucide icons |
| i18n       | next-intl 4 — `/ar` (RTL, default) and `/en` (LTR)                            |
| Data       | PostgreSQL 16, Prisma 7 (`prisma-client` generator + `@prisma/adapter-pg`)    |
| Validation | Zod 4                                                                         |
| Storage    | S3-compatible (AWS S3, R2, SeaweedFS/MinIO locally) via `@aws-sdk/client-s3`  |
| Logging    | pino (JSON, secret redaction)                                                 |
| Quality    | ESLint 10 (flat config), Prettier, Vitest 5, Playwright                       |

## Local development

### Prerequisites

- Node.js **22.12+** (`nvm use` reads `.nvmrc`) and pnpm **10.28** (`corepack enable`)
- PostgreSQL 16 — via Docker (below) or a local install
- Docker (optional) for local services

### Setup

```bash
cp .env.example .env              # local defaults; never commit .env
docker compose up -d              # PostgreSQL on 127.0.0.1:5432 (+ flexibx_test database)
pnpm install                      # also runs `prisma generate`
pnpm db:deploy                    # apply migrations to the dev database
pnpm db:seed                      # optional: safe demo data (no secrets)
pnpm dev                          # http://localhost:3000 → redirects to /ar
```

Without Docker, create the role and databases yourself:

```sql
CREATE ROLE flexibx LOGIN PASSWORD 'flexibx' CREATEDB;
CREATE DATABASE flexibx OWNER flexibx;
CREATE DATABASE flexibx_test OWNER flexibx;
```

Optional S3-compatible storage (not required by Phase 1 runtime):

```bash
docker compose --profile storage up -d   # SeaweedFS S3 on 127.0.0.1:8333, bucket flexibx-dev
```

### Useful scripts

| Command                           | Purpose                                                        |
| --------------------------------- | -------------------------------------------------------------- |
| `pnpm dev` / `pnpm dev:pretty`    | Dev server (raw JSON logs / pretty logs)                       |
| `pnpm build` / `pnpm start`       | Production build (standalone) / run it                         |
| `pnpm typecheck`                  | `next typegen` + `tsc --noEmit`                                |
| `pnpm lint` / `pnpm format`       | ESLint (zero warnings) / Prettier                              |
| `pnpm test`                       | Unit tests (no database)                                       |
| `pnpm test:integration`           | Integration tests against `TEST_DATABASE_URL`                  |
| `pnpm e2e`                        | Playwright end-to-end tests (run `pnpm build` first)           |
| `pnpm db:migrate`                 | Create/apply a migration in development (`prisma migrate dev`) |
| `pnpm db:deploy`                  | Apply committed migrations (`prisma migrate deploy`)           |
| `pnpm db:seed` / `pnpm db:studio` | Seed demo data / open Prisma Studio                            |

## Environment variables

All variables are validated with Zod (`src/server/env-schema.ts`) on first use; invalid
configuration fails fast with the variable **names** (never values). Development uses a
single `.env` file (Prisma loads it via `dotenv`, Next.js natively).

| Variable                                                                                                                         | Required                  | Purpose                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------ |
| `NODE_ENV`                                                                                                                       | – (default `development`) | `development` / `test` / `production`                                          |
| `APP_URL`                                                                                                                        | yes                       | Canonical app origin (`http(s)://…`)                                           |
| `LOG_LEVEL`                                                                                                                      | – (default `info`)        | pino level (`silent` … `trace`)                                                |
| `DATABASE_URL`                                                                                                                   | yes                       | PostgreSQL connection string                                                   |
| `TEST_DATABASE_URL`                                                                                                              | tests only                | Integration-test database; name **must end in `_test`** (tables are truncated) |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `S3_PUBLIC_BASE_URL` | when storage is used      | Object storage (validated lazily by the storage service)                       |
| `AUTH_SECRET`, `AUTH_URL`                                                                                                        | reserved (Phase 2)        | Better Auth                                                                    |
| `ENCRYPTION_KEY`                                                                                                                 | reserved (Phase 8)        | AES-256-GCM key for social tokens (32 bytes, base64)                           |
| `REDIS_URL`                                                                                                                      | reserved (jobs phase)     | BullMQ                                                                         |

Only `NEXT_PUBLIC_*` variables reach the browser; Phase 1 defines none. The values in
`.env.example`, `docker-compose.yml` and CI are **local/throwaway defaults** — production
must use its own secrets from a secret manager.

## Database and migrations

- Schema: `prisma/schema.prisma`; config: `prisma.config.ts`; client generated to
  `src/generated/prisma` (gitignored).
- Migrations are committed SQL in `prisma/migrations/`. Constraints Prisma cannot express
  (the `citext` extension, `CHECK` constraints) are hand-written into the migration SQL.
- New migration: edit the schema, then `pnpm exec prisma migrate dev --create-only --name <name>`,
  review/extend the SQL, then `pnpm db:migrate`.
- Production: run `prisma migrate deploy` as a one-off job before rolling out the app
  (`docker build --target migrate`).
- Workspaces are **soft-deleted** (`deleted_at`). Audit logs block hard deletes
  (`ON DELETE RESTRICT`); a controlled purge job may be added later.

## Testing

```bash
pnpm test                 # unit: env, errors, validation, route wrapper, permissions,
                          #       tenant guard, storage, CSP, i18n key parity
pnpm test:integration     # PostgreSQL: constraints, tenant isolation, audit log, /api/health
pnpm build && pnpm e2e    # Chromium: /ar RTL, /en LTR, locale detection, 404s, theme, headers
```

Playwright uses `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` if set, otherwise the Chromium
preinstalled in the dev container (`/opt/pw-browsers/chromium`) when present; CI installs
its own browser.

## Docker

```bash
docker build -t flexibx .                                 # app (non-root, standalone)
docker build --target migrate -t flexibx-migrate .        # migrations job
docker run --rm -p 3000:3000 --env-file .env.production flexibx
```

`.dockerignore` excludes all `.env*` files: configuration is injected at run time.

## CI

`.github/workflows/ci.yml` runs on pushes and pull requests:
install → Prisma validate → format check → typecheck → lint → unit tests; PostgreSQL
service → migrate deploy/status → integration tests → build → Playwright; Docker image
build; gitleaks secret scan.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — architecture, multi-tenancy, i18n/RTL,
  security model, and what is deferred to later phases.
