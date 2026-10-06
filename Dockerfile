# syntax=docker/dockerfile:1.7
#
# Flexibx production image (Next.js standalone, non-root).
#   docker build -t flexibx .                      → app image
#   docker build --target migrate -t flexibx-migrate .  → one-off `prisma migrate deploy`
# Runtime configuration (DATABASE_URL, APP_URL, S3_*…) is injected as environment
# variables at run time; no secrets are baked into the image.

ARG NODE_IMAGE=node:22.22.3-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
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
