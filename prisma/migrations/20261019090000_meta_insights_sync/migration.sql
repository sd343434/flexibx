-- CreateEnum
CREATE TYPE "insights_source_kind" AS ENUM ('FACEBOOK_PAGE', 'INSTAGRAM_ACCOUNT');

-- CreateEnum
CREATE TYPE "insights_run_status" AS ENUM ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "insights_run_trigger" AS ENUM ('MANUAL', 'SCHEDULED');

-- AlterEnum
ALTER TYPE "performance_metric" ADD VALUE 'VIEWS';

-- AlterTable
ALTER TABLE "metric_imports" ADD COLUMN     "insights_source_id" UUID,
ADD COLUMN     "rows_revised" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "metric_observations" ADD COLUMN     "insights_source_id" UUID,
ADD COLUMN     "observed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "campaign_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "insights_sources" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "social_channel_id" UUID NOT NULL,
    "provider" VARCHAR(40) NOT NULL DEFAULT 'meta',
    "kind" "insights_source_kind" NOT NULL,
    "external_id" VARCHAR(64) NOT NULL,
    "page_id" VARCHAR(64) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "disabled_reason" VARCHAR(40),
    "lease_run_id" UUID,
    "lease_until" TIMESTAMPTZ(3),
    "last_attempt_at" TIMESTAMPTZ(3),
    "last_success_at" TIMESTAMPTZ(3),
    "last_error_code" VARCHAR(60),
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "covered_from" DATE,
    "covered_to" DATE,
    "next_sync_at" TIMESTAMPTZ(3),
    "unsupported_metrics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_by_user_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insights_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insights_sync_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "trigger" "insights_run_trigger" NOT NULL,
    "status" "insights_run_status" NOT NULL DEFAULT 'RUNNING',
    "requested_by_user_id" UUID,
    "window_from" DATE,
    "window_to" DATE,
    "import_id" UUID,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "rows_stored" INTEGER NOT NULL DEFAULT 0,
    "error_code" VARCHAR(60),
    "issues" JSONB NOT NULL DEFAULT '[]',
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "insights_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "insights_sources_social_channel_id_key" ON "insights_sources"("social_channel_id");

-- CreateIndex
CREATE INDEX "insights_sources_enabled_next_sync_at_idx" ON "insights_sources"("enabled", "next_sync_at");

-- CreateIndex
CREATE INDEX "insights_sources_created_by_user_id_idx" ON "insights_sources"("created_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "insights_sources_workspace_id_kind_external_id_key" ON "insights_sources"("workspace_id", "kind", "external_id");

-- CreateIndex
CREATE INDEX "insights_sync_runs_workspace_id_started_at_idx" ON "insights_sync_runs"("workspace_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "insights_sync_runs_source_id_started_at_idx" ON "insights_sync_runs"("source_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "insights_sync_runs_requested_by_user_id_idx" ON "insights_sync_runs"("requested_by_user_id");

-- CreateIndex
CREATE INDEX "insights_sync_runs_import_id_idx" ON "insights_sync_runs"("import_id");

-- CreateIndex
CREATE INDEX "metric_imports_insights_source_id_idx" ON "metric_imports"("insights_source_id");

-- CreateIndex
CREATE INDEX "metric_observations_insights_source_id_metric_period_start_idx" ON "metric_observations"("insights_source_id", "metric", "period_start");

-- AddForeignKey
ALTER TABLE "metric_imports" ADD CONSTRAINT "metric_imports_insights_source_id_fkey" FOREIGN KEY ("insights_source_id") REFERENCES "insights_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_observations" ADD CONSTRAINT "metric_observations_insights_source_id_fkey" FOREIGN KEY ("insights_source_id") REFERENCES "insights_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insights_sources" ADD CONSTRAINT "insights_sources_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insights_sources" ADD CONSTRAINT "insights_sources_social_channel_id_fkey" FOREIGN KEY ("social_channel_id") REFERENCES "social_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insights_sources" ADD CONSTRAINT "insights_sources_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insights_sync_runs" ADD CONSTRAINT "insights_sync_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insights_sync_runs" ADD CONSTRAINT "insights_sync_runs_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "insights_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insights_sync_runs" ADD CONSTRAINT "insights_sync_runs_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insights_sync_runs" ADD CONSTRAINT "insights_sync_runs_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "metric_imports"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── Custom SQL (Pass 6: Meta Insights) ─────────────────────────────────────────────

-- Existing observations were read when they were created.
ALTER TABLE "metric_observations" DISABLE TRIGGER "metric_observations_immutable";
UPDATE "metric_observations" SET "observed_at" = "created_at";
ALTER TABLE "metric_observations" ENABLE TRIGGER "metric_observations_immutable";

-- VERIFIED is now possible, but only for the Meta integration's own imports (a sync of a
-- connected source); people's imports stay MANUAL and test data SIMULATED.
ALTER TABLE "metric_imports" DROP CONSTRAINT "metric_imports_source_check";
ALTER TABLE "metric_imports" ADD CONSTRAINT "metric_imports_source_check"
  CHECK ((("source" = 'VERIFIED') = ("provider" = 'meta'))
     AND (("provider" = 'meta') = ("insights_source_id" IS NOT NULL)));
ALTER TABLE "metric_imports" DROP CONSTRAINT "metric_imports_counts_check";
ALTER TABLE "metric_imports" ADD CONSTRAINT "metric_imports_counts_check"
  CHECK ("rows_received" >= 0 AND "rows_accepted" >= 0 AND "rows_duplicate" >= 0
     AND "rows_rejected" >= 0 AND "rows_revised" >= 0 AND "rows_revised" <= "rows_accepted"
     AND "rows_received" = "rows_accepted" + "rows_duplicate" + "rows_rejected");

ALTER TABLE "metric_observations" DROP CONSTRAINT "metric_observations_source_check";
ALTER TABLE "metric_observations" ADD CONSTRAINT "metric_observations_source_check"
  CHECK ((("source" = 'VERIFIED') = ("provider" = 'meta'))
     AND (("provider" = 'meta') = ("insights_source_id" IS NOT NULL)));
-- An observation belongs to a campaign, or (account-level numbers only) to a source;
-- content is always inside a campaign.
ALTER TABLE "metric_observations" ADD CONSTRAINT "metric_observations_scope_check"
  CHECK (("campaign_id" IS NOT NULL OR "insights_source_id" IS NOT NULL)
     AND ("content_item_id" IS NULL OR "campaign_id" IS NOT NULL));

ALTER TABLE "insights_sources" ADD CONSTRAINT "insights_sources_state_check"
  CHECK ("provider" = 'meta'
     AND length(btrim("external_id")) > 0 AND length(btrim("page_id")) > 0
     AND length(btrim("name")) > 0
     AND "failure_count" >= 0 AND "version" >= 1
     AND (("lease_run_id" IS NULL) = ("lease_until" IS NULL))
     AND ("disabled_reason" IS NULL OR NOT "enabled")
     AND ("covered_from" IS NULL) = ("covered_to" IS NULL)
     AND ("covered_to" IS NULL OR "covered_to" >= "covered_from")
     AND ("kind" <> 'FACEBOOK_PAGE' OR "external_id" = "page_id"));

ALTER TABLE "insights_sync_runs" ADD CONSTRAINT "insights_sync_runs_state_check"
  CHECK ("calls" >= 0 AND "rows_stored" >= 0
     AND (("status" = 'RUNNING') = ("finished_at" IS NULL))
     AND ("finished_at" IS NULL OR "finished_at" >= "started_at")
     AND ("status" NOT IN ('FAILED', 'ABANDONED') OR "error_code" IS NOT NULL)
     AND ("window_to" IS NULL OR "window_from" IS NULL OR "window_to" >= "window_from"));
-- At most one sync of a source runs at a time (a dead one is marked ABANDONED first).
CREATE UNIQUE INDEX "insights_sync_runs_one_running" ON "insights_sync_runs"("source_id")
  WHERE "status" = 'RUNNING';

-- Every reference stays inside the row's workspace, which never changes.
DROP TRIGGER "metric_observations_same_workspace" ON "metric_observations";
CREATE TRIGGER "metric_observations_same_workspace" BEFORE INSERT OR UPDATE ON "metric_observations"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"(
    'import_id', 'metric_imports', 'campaign_id', 'campaigns', 'content_item_id', 'content_items',
    'insights_source_id', 'insights_sources');
CREATE TRIGGER "metric_imports_same_workspace" BEFORE INSERT OR UPDATE ON "metric_imports"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"(
    'insights_source_id', 'insights_sources');
CREATE TRIGGER "insights_sources_same_workspace" BEFORE INSERT OR UPDATE ON "insights_sources"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"(
    'social_channel_id', 'social_channels');
CREATE TRIGGER "insights_sources_workspace_immutable" BEFORE UPDATE ON "insights_sources"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
CREATE TRIGGER "insights_sync_runs_same_workspace" BEFORE INSERT OR UPDATE ON "insights_sync_runs"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"(
    'source_id', 'insights_sources', 'import_id', 'metric_imports');
CREATE TRIGGER "insights_sync_runs_workspace_immutable" BEFORE UPDATE ON "insights_sync_runs"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();

-- A source keeps the account it reads: a different Page or account is a new source.
CREATE FUNCTION "insights_sources_identity_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."social_channel_id" IS DISTINCT FROM OLD."social_channel_id"
     OR NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."external_id" IS DISTINCT FROM OLD."external_id" THEN
    RAISE EXCEPTION 'insights_sources identity cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "insights_sources_identity" BEFORE UPDATE ON "insights_sources"
  FOR EACH ROW EXECUTE FUNCTION "insights_sources_identity_trigger"();

-- A run's record is history: once finished it never changes (except losing the link to
-- an import that was deleted with its source), and its identity never changes.
CREATE FUNCTION "insights_sync_runs_record_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."source_id" IS DISTINCT FROM OLD."source_id"
     OR NEW."trigger" IS DISTINCT FROM OLD."trigger"
     OR NEW."requested_by_user_id" IS DISTINCT FROM OLD."requested_by_user_id"
        AND NEW."requested_by_user_id" IS NOT NULL
     OR NEW."started_at" IS DISTINCT FROM OLD."started_at" THEN
    RAISE EXCEPTION 'insights_sync_runs identity cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" <> 'RUNNING'
     AND (NEW."status" IS DISTINCT FROM OLD."status"
       OR NEW."finished_at" IS DISTINCT FROM OLD."finished_at"
       OR NEW."calls" IS DISTINCT FROM OLD."calls"
       OR NEW."rows_stored" IS DISTINCT FROM OLD."rows_stored"
       OR NEW."error_code" IS DISTINCT FROM OLD."error_code"
       OR NEW."issues" IS DISTINCT FROM OLD."issues"
       OR NEW."window_from" IS DISTINCT FROM OLD."window_from"
       OR NEW."window_to" IS DISTINCT FROM OLD."window_to"
       OR (NEW."import_id" IS DISTINCT FROM OLD."import_id" AND NEW."import_id" IS NOT NULL)) THEN
    RAISE EXCEPTION 'a finished insights sync run cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "insights_sync_runs_record" BEFORE UPDATE ON "insights_sync_runs"
  FOR EACH ROW EXECUTE FUNCTION "insights_sync_runs_record_trigger"();

-- An import's identity, source, account and counts are fixed once written; only voiding
-- changes it.
CREATE OR REPLACE FUNCTION "metric_imports_identity_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."source" IS DISTINCT FROM OLD."source"
     OR NEW."external_id" IS DISTINCT FROM OLD."external_id"
     OR NEW."insights_source_id" IS DISTINCT FROM OLD."insights_source_id"
     OR NEW."rows_received" IS DISTINCT FROM OLD."rows_received"
     OR NEW."rows_accepted" IS DISTINCT FROM OLD."rows_accepted"
     OR NEW."rows_duplicate" IS DISTINCT FROM OLD."rows_duplicate"
     OR NEW."rows_rejected" IS DISTINCT FROM OLD."rows_rejected"
     OR NEW."rows_revised" IS DISTINCT FROM OLD."rows_revised"
     OR (OLD."status" = 'VOIDED' AND NEW."status" <> 'VOIDED')
     OR (NEW."status" <> OLD."status" AND NEW."status" <> 'VOIDED') THEN
    RAISE EXCEPTION 'metric_imports can only be voided' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
