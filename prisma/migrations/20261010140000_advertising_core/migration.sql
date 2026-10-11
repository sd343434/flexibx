-- Advertising platforms: OAuth states, encrypted connections, ad accounts with their
-- read-only snapshots, and campaign plans. Additive only. Prerequisites:
-- 20261010120000_orchestration_core and 20261010130000_orchestration_approvals.
-- Note: ALTER TYPE ... ADD VALUE adds AD_PLAN to ai_operation; the value is not used in
-- this migration (PostgreSQL forbids using a new enum value in the same transaction).

-- CreateEnum
CREATE TYPE "ad_platform" AS ENUM ('META', 'SNAPCHAT', 'TIKTOK', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "ad_connection_status" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED', 'ERROR');

-- CreateEnum
CREATE TYPE "ad_plan_status" AS ENUM ('DRAFT', 'SUBMITTED', 'LAUNCHED', 'FAILED', 'DISCARDED');

-- AlterEnum
ALTER TYPE "ai_operation" ADD VALUE 'AD_PLAN';

-- CreateTable
CREATE TABLE "ad_oauth_states" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "platform" "ad_platform" NOT NULL,
    "state_hash" VARCHAR(64) NOT NULL,
    "locale" VARCHAR(5) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_connections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "platform" "ad_platform" NOT NULL,
    "status" "ad_connection_status" NOT NULL DEFAULT 'ACTIVE',
    "external_user_id" VARCHAR(64) NOT NULL,
    "external_user_name" VARCHAR(200),
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "token_ciphertext" TEXT,
    "token_expires_at" TIMESTAMPTZ(3),
    "connected_by_user_id" UUID,
    "last_error_code" VARCHAR(60),
    "last_checked_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "platform" "ad_platform" NOT NULL,
    "external_id" VARCHAR(64) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "time_zone" VARCHAR(64),
    "external_status" VARCHAR(20) NOT NULL,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "snapshot" JSONB,
    "last_synced_at" TIMESTAMPTZ(3),
    "sync_error_code" VARCHAR(60),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_plans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "platform" "ad_platform" NOT NULL,
    "status" "ad_plan_status" NOT NULL DEFAULT 'DRAFT',
    "name" VARCHAR(200) NOT NULL,
    "proposal" JSONB NOT NULL,
    "budget_total_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "ai_generation_id" UUID,
    "run_id" UUID,
    "external_campaign_id" VARCHAR(64),
    "failure_code" VARCHAR(60),
    "created_by_user_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_plans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ad_oauth_states_state_hash_key" ON "ad_oauth_states"("state_hash");

-- CreateIndex
CREATE INDEX "ad_oauth_states_workspace_id_created_at_idx" ON "ad_oauth_states"("workspace_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ad_oauth_states_user_id_idx" ON "ad_oauth_states"("user_id");

-- CreateIndex
CREATE INDEX "ad_connections_connected_by_user_id_idx" ON "ad_connections"("connected_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "ad_connections_workspace_id_platform_key" ON "ad_connections"("workspace_id", "platform");

-- CreateIndex
CREATE INDEX "ad_accounts_workspace_id_platform_idx" ON "ad_accounts"("workspace_id", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "ad_accounts_connection_id_external_id_key" ON "ad_accounts"("connection_id", "external_id");

-- CreateIndex
CREATE INDEX "ad_plans_workspace_id_created_at_idx" ON "ad_plans"("workspace_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ad_plans_account_id_idx" ON "ad_plans"("account_id");

-- CreateIndex
CREATE INDEX "ad_plans_ai_generation_id_idx" ON "ad_plans"("ai_generation_id");

-- CreateIndex
CREATE INDEX "ad_plans_run_id_idx" ON "ad_plans"("run_id");

-- CreateIndex
CREATE INDEX "ad_plans_created_by_user_id_idx" ON "ad_plans"("created_by_user_id");

-- AddForeignKey
ALTER TABLE "ad_oauth_states" ADD CONSTRAINT "ad_oauth_states_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_oauth_states" ADD CONSTRAINT "ad_oauth_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_connections" ADD CONSTRAINT "ad_connections_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_connections" ADD CONSTRAINT "ad_connections_connected_by_user_id_fkey" FOREIGN KEY ("connected_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "ad_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_plans" ADD CONSTRAINT "ad_plans_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_plans" ADD CONSTRAINT "ad_plans_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ad_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_plans" ADD CONSTRAINT "ad_plans_ai_generation_id_fkey" FOREIGN KEY ("ai_generation_id") REFERENCES "ai_generations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_plans" ADD CONSTRAINT "ad_plans_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_plans" ADD CONSTRAINT "ad_plans_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;



-- ── Advertising rules Prisma cannot express ──

ALTER TABLE "ad_oauth_states" ADD CONSTRAINT "ad_oauth_states_check" CHECK (
  "state_hash" ~ '^[0-9a-f]{64}$'
  AND "locale" IN ('ar', 'en')
  AND "expires_at" > "created_at"
  AND "expires_at" <= "created_at" + interval '1 hour');

-- A usable connection always has its (encrypted) token; a disconnected one never does.
ALTER TABLE "ad_connections" ADD CONSTRAINT "ad_connections_check" CHECK (
  length("external_user_id") BETWEEN 1 AND 64
  AND ("token_ciphertext" IS NULL OR "token_ciphertext" ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')
  AND (("status" = 'ACTIVE') <= ("token_ciphertext" IS NOT NULL))
  AND (("status" = 'REVOKED') <= ("token_ciphertext" IS NULL))
  AND "version" >= 0);

ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_check" CHECK (
  "external_id" ~ '^[A-Za-z0-9_-]{1,64}$'
  AND "currency" ~ '^[A-Z]{3}$'
  AND "external_status" IN ('ACTIVE', 'DISABLED', 'UNSETTLED', 'PENDING', 'CLOSED', 'OTHER'));

-- Money and dates are deterministic: a positive budget in the account's currency, at
-- most 90 days.
ALTER TABLE "ad_plans" ADD CONSTRAINT "ad_plans_check" CHECK (
  "budget_total_minor" > 0
  AND "currency" ~ '^[A-Z]{3}$'
  AND "end_date" >= "start_date"
  AND "end_date" - "start_date" < 90
  AND "version" >= 0
  AND (("status" = 'SUBMITTED') <= ("run_id" IS NOT NULL)));

-- Accounts belong to a connection of their workspace; plans to an account (and AI
-- generation and run) of their workspace; nothing moves between workspaces.
CREATE TRIGGER "ad_accounts_same_workspace" BEFORE INSERT OR UPDATE ON "ad_accounts"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"('connection_id', 'ad_connections');
CREATE TRIGGER "ad_plans_same_workspace" BEFORE INSERT OR UPDATE ON "ad_plans"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"(
    'account_id', 'ad_accounts', 'ai_generation_id', 'ai_generations', 'run_id', 'agent_runs');
CREATE TRIGGER "ad_oauth_states_workspace_immutable" BEFORE UPDATE ON "ad_oauth_states"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
CREATE TRIGGER "ad_connections_workspace_immutable" BEFORE UPDATE ON "ad_connections"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
CREATE TRIGGER "ad_accounts_workspace_immutable" BEFORE UPDATE ON "ad_accounts"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
CREATE TRIGGER "ad_plans_workspace_immutable" BEFORE UPDATE ON "ad_plans"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();

-- A plan's account is on the plan's platform.
CREATE FUNCTION "ad_plans_platform_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "ad_accounts" a WHERE a."id" = NEW."account_id"
                   AND a."platform" = NEW."platform" AND a."currency" = NEW."currency") THEN
    RAISE EXCEPTION 'ad_plans must match its account platform and currency'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "ad_plans_platform" BEFORE INSERT OR UPDATE ON "ad_plans"
  FOR EACH ROW EXECUTE FUNCTION "ad_plans_platform_trigger"();
