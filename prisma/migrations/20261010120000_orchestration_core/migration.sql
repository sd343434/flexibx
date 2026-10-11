-- CreateEnum
CREATE TYPE "automation_cadence" AS ENUM ('OFF', 'DAILY', 'WEEKLY');

-- CreateEnum
CREATE TYPE "agent_run_trigger" AS ENUM ('MANUAL', 'SCHEDULE');

-- CreateEnum
CREATE TYPE "agent_run_state" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_ATTENTION');

-- CreateEnum
CREATE TYPE "agent_task_state" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED', 'NEEDS_APPROVAL');

-- CreateTable
CREATE TABLE "automation_policies" (
    "workspace_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "paused_at" TIMESTAMPTZ(3),
    "delegate_user_id" UUID,
    "planning_cadence" "automation_cadence" NOT NULL DEFAULT 'OFF',
    "next_planning_at" TIMESTAMPTZ(3),
    "allow_drafts" BOOLEAN NOT NULL DEFAULT false,
    "max_drafts_per_run" INTEGER NOT NULL DEFAULT 3,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_policies_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "workflow" VARCHAR(40) NOT NULL,
    "trigger" "agent_run_trigger" NOT NULL,
    "state" "agent_run_state" NOT NULL DEFAULT 'PENDING',
    "requested_by_user_id" UUID,
    "idempotency_key" VARCHAR(120) NOT NULL,
    "summary" JSONB,
    "failure_code" VARCHAR(60),
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_tasks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "key" VARCHAR(40) NOT NULL,
    "handler" VARCHAR(60) NOT NULL,
    "risk" VARCHAR(20) NOT NULL,
    "depends_on" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "state" "agent_task_state" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL,
    "timeout_ms" INTEGER NOT NULL,
    "run_after" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token" UUID,
    "lease_expires_at" TIMESTAMPTZ(3),
    "output" JSONB,
    "failure_code" VARCHAR(60),
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "automation_policies_enabled_paused_next_planning_at_idx" ON "automation_policies"("enabled", "paused", "next_planning_at");

-- CreateIndex
CREATE INDEX "automation_policies_delegate_user_id_idx" ON "automation_policies"("delegate_user_id");

-- CreateIndex
CREATE INDEX "agent_runs_workspace_id_created_at_idx" ON "agent_runs"("workspace_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "agent_runs_state_updated_at_idx" ON "agent_runs"("state", "updated_at");

-- CreateIndex
CREATE INDEX "agent_runs_requested_by_user_id_idx" ON "agent_runs"("requested_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_runs_workspace_id_idempotency_key_key" ON "agent_runs"("workspace_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "agent_tasks_workspace_id_run_id_idx" ON "agent_tasks"("workspace_id", "run_id");

-- CreateIndex
CREATE INDEX "agent_tasks_state_run_after_idx" ON "agent_tasks"("state", "run_after");

-- CreateIndex
CREATE INDEX "agent_tasks_state_lease_expires_at_idx" ON "agent_tasks"("state", "lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_tasks_run_id_key_key" ON "agent_tasks"("run_id", "key");

-- AddForeignKey
ALTER TABLE "automation_policies" ADD CONSTRAINT "automation_policies_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_policies" ADD CONSTRAINT "automation_policies_delegate_user_id_fkey" FOREIGN KEY ("delegate_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Orchestration core rules Prisma cannot express ──

-- Tasks belong to a run of their own workspace; nothing moves between workspaces.
CREATE TRIGGER "agent_tasks_same_workspace" BEFORE INSERT OR UPDATE ON "agent_tasks"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"('run_id', 'agent_runs');
CREATE TRIGGER "agent_tasks_workspace_immutable" BEFORE UPDATE ON "agent_tasks"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
CREATE TRIGGER "agent_runs_workspace_immutable" BEFORE UPDATE ON "agent_runs"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();

ALTER TABLE "automation_policies" ADD CONSTRAINT "automation_policies_limits_check" CHECK (
  "max_drafts_per_run" BETWEEN 1 AND 10
  AND "version" >= 0
  -- A schedule needs a next slot; no cadence, no slot.
  AND (("planning_cadence" = 'OFF') = ("next_planning_at" IS NULL))
  -- (A missing delegate — e.g. the member's account was deleted — is handled by the
  -- engine: runs stop with NEEDS_ATTENTION. A CHECK here would block that deletion.)
  AND ("paused" = ("paused_at" IS NOT NULL)));

ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_check" CHECK (
  "workflow" ~ '^[a-z][a-z_]{1,39}$'
  AND (("state" IN ('FAILED', 'NEEDS_ATTENTION')) = ("failure_code" IS NOT NULL))
  AND (("state" IN ('SUCCEEDED', 'FAILED', 'CANCELLED')) = ("finished_at" IS NOT NULL)));

ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_check" CHECK (
  "key" ~ '^[a-z][a-z_]{1,39}$'
  AND "risk" IN ('INTERNAL', 'EXTERNAL', 'SPEND')
  AND "max_attempts" BETWEEN 1 AND 5
  AND "attempts" BETWEEN 0 AND "max_attempts"
  AND "timeout_ms" BETWEEN 1000 AND 600000
  AND NOT ("key" = ANY ("depends_on"))
  AND ("state" <> 'FAILED' OR "failure_code" IS NOT NULL)
  AND ("state" <> 'RUNNING' OR ("lease_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL)));
