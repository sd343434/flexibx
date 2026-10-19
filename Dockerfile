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
# The media worker's base: same Node release on Debian trixie, whose FFmpeg is 7.x (bookworm
# ships 5.1; the worker is tested with FFmpeg 6+ and its preflight requires it).
ARG WORKER_IMAGE=node:22.22.3-trixie-slim

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

# ── Operations jobs: the migrate image plus the PostgreSQL 16 client ────────────
#   docker build --target ops -t flexibx-ops .
# For scripts/ops/sql/db-roles.sql (psql), db-backup.sh / db-restore.sh / db-verify.sh
# (pg_dump, pg_restore, psql) and the operator CLIs (pnpm admin:grant, admin:mfa-reset),
# run as one-off tasks next to a private database. Debian bookworm ships client 15, which
# cannot dump a 16 server, so client 16 comes from the PostgreSQL project's repository
# (PGDG), configured by Debian's postgresql-common helper with the signing key that
# package ships. Credentials arrive as environment variables at run time (never baked in,
# never on a command line: the ops scripts convert URLs to libpq variables and a private
# PGPASSFILE). No default command: every job names what it runs.
FROM build AS ops
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates postgresql-common \
 && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
 && apt-get install -y --no-install-recommends postgresql-client-16 \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
USER node
CMD ["sh", "-c", "echo 'flexibx-ops: name the command to run' >&2; exit 64"]

# ── Creator Studio media worker ─────────────────────────────────────────────────
#   docker build --target worker -t flexibx-worker .
# The only process that runs FFmpeg (`pnpm creator:worker`), one job at a time; scale by
# running more containers. Needs the app's DATABASE_URL and storage settings, no inbound
# port, and a writable scratch volume at /work (about 3x the largest source per job).
# Before a trial: `docker run … flexibx-worker pnpm creator:preflight`
# (docs/runbooks/STAGING_CREATOR_STUDIO.md). FFmpeg, ffprobe, libass and a subtitle font
# come from Debian; the application files are the build stage's.
FROM ${WORKER_IMAGE} AS worker
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_HOME=/corepack \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production \
    CREATOR_WORK_DIR=/work
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && mkdir -p /work && chown node:node /work
WORKDIR /app
COPY --from=build /corepack /corepack
COPY --from=build /app ./
USER node
# The build fails here unless FFmpeg >= 6 with libx264, aac, libopus and libass, ffprobe and
# the subtitle font are present and a real (synthetic) encode with burned-in subtitles
# works — run as the unprivileged user the worker runs as.
RUN sh scripts/creator/check-media-tools.sh
VOLUME ["/work"]
CMD ["pnpm", "creator:worker"]

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
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health?scope=liveness').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
