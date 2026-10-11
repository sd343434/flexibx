-- Human approval of EXTERNAL and SPEND automation tasks. Additive only: one enum, one
-- table, four nullable/defaulted columns on agent_tasks and their constraints.
-- Prerequisite: 20261010120000_orchestration_core.

-- CreateEnum
CREATE TYPE "agent_approval_decision" AS ENUM ('APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "agent_tasks" ADD COLUMN     "approval_hash" VARCHAR(64),
ADD COLUMN     "approval_request" JSONB,
ADD COLUMN     "approval_round" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "approved_decision_id" UUID;

-- CreateTable
CREATE TABLE "agent_task_approvals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "round" INTEGER NOT NULL,
    "decision" "agent_approval_decision" NOT NULL,
    "decided_by_user_id" UUID,
    "note" VARCHAR(500),
    "risk" VARCHAR(20) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "snapshot_hash" VARCHAR(64) NOT NULL,
    "amount_minor" BIGINT,
    "currency" CHAR(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_task_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_task_approvals_workspace_id_created_at_idx" ON "agent_task_approvals"("workspace_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "agent_task_approvals_run_id_idx" ON "agent_task_approvals"("run_id");

-- CreateIndex
CREATE INDEX "agent_task_approvals_decided_by_user_id_idx" ON "agent_task_approvals"("decided_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_task_approvals_task_id_round_key" ON "agent_task_approvals"("task_id", "round");

-- CreateIndex
CREATE UNIQUE INDEX "agent_tasks_approved_decision_id_key" ON "agent_tasks"("approved_decision_id");

-- AddForeignKey
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_approved_decision_id_fkey" FOREIGN KEY ("approved_decision_id") REFERENCES "agent_task_approvals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_task_approvals" ADD CONSTRAINT "agent_task_approvals_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_task_approvals" ADD CONSTRAINT "agent_task_approvals_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_task_approvals" ADD CONSTRAINT "agent_task_approvals_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_task_approvals" ADD CONSTRAINT "agent_task_approvals_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── Approval rules Prisma cannot express ──

-- A task's approval state is consistent: INTERNAL tasks are never asked; a task waiting
-- for approval carries the exact action; a grant exists only while the task is PENDING.
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_approval_check" CHECK (
  "approval_round" >= 0
  AND ("risk" <> 'INTERNAL' OR ("approval_round" = 0 AND "approval_request" IS NULL
       AND "approval_hash" IS NULL AND "approved_decision_id" IS NULL))
  AND ("state" <> 'NEEDS_APPROVAL' OR ("approval_round" >= 1
       AND "approval_request" IS NOT NULL AND "approval_hash" IS NOT NULL))
  AND ("approval_hash" IS NULL OR "approval_hash" ~ '^[0-9a-f]{64}$')
  AND (("approval_request" IS NULL) = ("approval_hash" IS NULL))
  AND ("approved_decision_id" IS NULL OR "state" = 'PENDING'));

ALTER TABLE "agent_task_approvals" ADD CONSTRAINT "agent_task_approvals_check" CHECK (
  "round" >= 1
  AND "risk" IN ('EXTERNAL', 'SPEND')
  AND "snapshot_hash" ~ '^[0-9a-f]{64}$'
  AND ("note" IS NULL OR length("note") BETWEEN 1 AND 500)
  -- Spending carries its amount; nothing else does.
  AND (("risk" = 'SPEND') = ("amount_minor" IS NOT NULL))
  AND (("amount_minor" IS NULL) = ("currency" IS NULL))
  AND ("amount_minor" IS NULL OR "amount_minor" > 0)
  AND ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$'));

-- A decision is made by a person, about a task of the same run and workspace.
CREATE FUNCTION "agent_task_approvals_insert_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  task_run uuid;
  task_ws uuid;
  task_risk varchar;
BEGIN
  IF NEW."decided_by_user_id" IS NULL THEN
    RAISE EXCEPTION 'agent_task_approvals needs the deciding user' USING ERRCODE = 'check_violation';
  END IF;
  SELECT "run_id", "workspace_id", "risk" INTO task_run, task_ws, task_risk
    FROM "agent_tasks" WHERE "id" = NEW."task_id";
  IF task_run IS DISTINCT FROM NEW."run_id" OR task_ws IS DISTINCT FROM NEW."workspace_id"
     OR task_risk IS DISTINCT FROM NEW."risk" THEN
    RAISE EXCEPTION 'agent_task_approvals must match its task' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "agent_task_approvals_insert" BEFORE INSERT ON "agent_task_approvals"
  FOR EACH ROW EXECUTE FUNCTION "agent_task_approvals_insert_trigger"();

-- Decisions are immutable. The one permitted change is the decider's account being
-- deleted (ON DELETE SET NULL); workspace deletion still cascades.
CREATE FUNCTION "agent_task_approvals_immutable_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  restored "agent_task_approvals";
BEGIN
  restored := NEW;
  restored."decided_by_user_id" := OLD."decided_by_user_id";
  IF NEW."decided_by_user_id" IS NULL AND restored IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'agent_task_approvals is immutable' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER "agent_task_approvals_immutable" BEFORE UPDATE ON "agent_task_approvals"
  FOR EACH ROW EXECUTE FUNCTION "agent_task_approvals_immutable_trigger"();

-- A grant points at an APPROVED decision of the same task's current round.
CREATE FUNCTION "agent_tasks_grant_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."approved_decision_id" IS NOT NULL
     AND NEW."approved_decision_id" IS DISTINCT FROM OLD."approved_decision_id"
     AND NOT EXISTS (
       SELECT 1 FROM "agent_task_approvals" a
        WHERE a."id" = NEW."approved_decision_id" AND a."task_id" = NEW."id"
          AND a."decision" = 'APPROVED' AND a."round" = NEW."approval_round"
          AND a."snapshot_hash" = NEW."approval_hash") THEN
    RAISE EXCEPTION 'agent_tasks grant must be an approval of its current request'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "agent_tasks_grant" BEFORE UPDATE ON "agent_tasks"
  FOR EACH ROW EXECUTE FUNCTION "agent_tasks_grant_trigger"();
