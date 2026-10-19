# syntax=docker/dockerfile:1.7
#
# Flexibx production image (Next.js standalone, non-root).
#   docker build -t flexibx .                      → app image
#   docker build --target migrate -t flexibx-migrate .  → one-off `prisma migrate deploy`
#   docker build --target ops -t flexibx-ops .          → psql/pg_dump 16 + operator CLIs
#   docker build --target worker -t flexibx-worker .    → Creator Studio media worker (FFmpeg)
# Runtime configuration (DATABASE_URL, APP_URL, S3_*…) is injected as environment
# variables at run time; no secrets are baked into the image.

ARG NODE_IMAGE=node:22.22.3-bookworm-slim
# Base of the two job images (`ops`, `worker`): Ubuntu 24.04 LTS, whose own archive carries
# both tools they need — FFmpeg 6.1 (the version CI's integration tests and the worker's
# media check run against) and the PostgreSQL 16 client (same major as the server) — so no
# third-party package repository is configured. Node is the exact runtime of NODE_IMAGE,
# copied in (no second Node install).
ARG JOBS_IMAGE=ubuntu:24.04

FROM ${NODE_IMAGE} AS base
# COREPACK_HOME: pnpm is fetched once at build time (as root) into a shared, world-readable
# directory, so the `migrate` and `ops` jobs (USER node) run `pnpm` without network access
# (the default cache is root's home, which node cannot read).
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_HOME=/corepack \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

# ── Dependencies (cached on lockfile changes only) ──────────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY prisma.config.ts ./
COPY prisma ./prisma
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# ── Build ───────────────────────────────────────────────────────────────────────
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm exec prisma generate && pnpm build

# ── Migrations (run as a one-off job before rolling out the app) ────────────────
FROM build AS migrate
ENV NODE_ENV=production
USER node
CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]

# ── Files of the job images: the build without the Next.js output they never run ──
FROM build AS jobs-files
RUN rm -rf .next

# ── Job runtime: Ubuntu 24.04 + the Node of `base`, user `node` (uid 1000), and the
# PostgreSQL 16 client (ops scripts; the worker image runs the staging gate, whose
# database check is scripts/ops/db-verify.sh) ─────────────────────────────────────
FROM ${JOBS_IMAGE} AS jobs-base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_HOME=/corepack \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production
# /usr/local of the Node image: node, npm and corepack with its pnpm shims.
COPY --from=base /usr/local/ /usr/local/
# Ubuntu's image ships a user `ubuntu` with uid 1000; the jobs run as `node` with that uid,
# as in the Node image (volumes and the uid checks stay the same).
RUN if id ubuntu >/dev/null 2>&1; then userdel --remove ubuntu; fi \
 && groupadd --gid 1000 node \
 && useradd --uid 1000 --gid node --create-home --shell /bin/bash node \
 && node --version \
 && corepack enable \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates postgresql-client-16 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ── Operations jobs: the PostgreSQL 16 client + the app (migrate, operator CLIs) ─────
#   docker build --target ops -t flexibx-ops .
# For scripts/ops/sql/db-roles.sql (psql), db-backup.sh / db-restore.sh / db-verify.sh
# (pg_dump, pg_restore, psql) and the operator CLIs (pnpm admin:grant, admin:mfa-reset),
# run as one-off tasks next to a private database. postgresql-client-16 (jobs-base) comes
# from Ubuntu's archive (signed by Ubuntu; same major as the server). Credentials arrive as
# environment variables at run time (never baked in, never on a command line: the ops
# scripts convert URLs to libpq variables and a private PGPASSFILE). No default command:
# every job names what it runs.
FROM jobs-base AS ops
COPY --from=build /corepack /corepack
COPY --from=jobs-files /app ./
# Prisma's schema engine (migrate, db execute) is chosen by the platform's OpenSSL. The
# build stage has no `openssl` binary, so the engine fetched at install time is the
# fallback; this image has OpenSSL 3, so its engine is fetched here, as root, at build time
# (at run time `node` cannot write to node_modules and `migrate deploy` would fail).
RUN pnpm exec prisma version >/dev/null
USER node
CMD ["sh", "-c", "echo 'flexibx-ops: name the command to run' >&2; exit 64"]

# ── Creator Studio media worker ─────────────────────────────────────────────────
#   docker build --target worker -t flexibx-worker .
# The only process that runs FFmpeg, one job at a time; scale by running more
# containers. Needs the app's DATABASE_URL and storage settings, no inbound port, and a
# writable scratch volume at /work (about 3x the largest source per job).
# Before a trial: `docker run … flexibx-worker pnpm creator:preflight`
# (docs/runbooks/STAGING_CREATOR_STUDIO.md). FFmpeg, ffprobe, libass and a subtitle font
# come from Ubuntu's archive; the application files are the build stage's.
FROM jobs-base AS worker
ENV CREATOR_WORK_DIR=/work
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /work && chown node:node /work
COPY --from=build /corepack /corepack
COPY --from=jobs-files /app ./
USER node
# The build fails here unless FFmpeg >= 6 with libx264, aac, libopus and libass, ffprobe and
# the subtitle font are present and a real (synthetic) encode with burned-in subtitles
# works — run as the unprivileged user the worker runs as.
RUN sh scripts/creator/check-media-tools.sh
VOLUME ["/work"]
# Node itself is PID 1, not pnpm: `docker stop` sends SIGTERM to PID 1 only, and pnpm exits
# on it without passing it on, so the worker would be killed mid-job without handing the
# job back. Same command as `pnpm creator:worker` (no .env in the image).
STOPSIGNAL SIGTERM
CMD ["node", "--import", "tsx", "--import", "./scripts/video-retention/register.mjs", "scripts/creator/worker.ts"]

# ── Runtime ─────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
RUN groupadd --system --gid 1001 flexibx && useradd --system --uid 1001 --gid flexibx flexibx
COPY --from=build --chown=flexibx:flexibx /app/.next/standalone ./
USER flexibx
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health?scope=liveness').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
