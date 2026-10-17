-- CreateEnum
CREATE TYPE "performance_metric" AS ENUM ('IMPRESSIONS', 'REACH', 'ENGAGEMENTS', 'CLICKS', 'CONVERSIONS', 'REVENUE', 'SPEND');

-- CreateEnum
CREATE TYPE "metric_source" AS ENUM ('VERIFIED', 'MANUAL', 'SIMULATED');

-- CreateEnum
CREATE TYPE "metric_import_status" AS ENUM ('SUCCEEDED', 'FAILED', 'VOIDED');

-- CreateEnum
CREATE TYPE "recommendation_kind" AS ENUM ('BELOW_TARGET', 'SPEND_OVER_BUDGET', 'STALE_DATA', 'MISSING_DATA', 'WEAK_CONTENT', 'STRONG_FORMAT', 'MORE_DATA_NEEDED');

-- CreateEnum
CREATE TYPE "recommendation_status" AS ENUM ('OPEN', 'REVIEWED', 'DISMISSED', 'SNOOZED', 'ACTED');

-- AlterTable
ALTER TABLE "marketing_goals" ADD COLUMN     "target_metric" "performance_metric";

-- CreateTable
CREATE TABLE "metric_imports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "source" "metric_source" NOT NULL,
    "external_id" VARCHAR(120) NOT NULL,
    "status" "metric_import_status" NOT NULL,
    "rows_received" INTEGER NOT NULL,
    "rows_accepted" INTEGER NOT NULL,
    "rows_duplicate" INTEGER NOT NULL,
    "rows_rejected" INTEGER NOT NULL,
    "error_code" VARCHAR(60),
    "issues" JSONB NOT NULL DEFAULT '[]',
    "imported_by_user_id" UUID,
    "voided_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_observations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "import_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "content_item_id" UUID,
    "channel" "marketing_channel" NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "source" "metric_source" NOT NULL,
    "metric" "performance_metric" NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "value" BIGINT NOT NULL,
    "currency" CHAR(3),
    "source_ref" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_recommendations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "content_item_id" UUID,
    "kind" "recommendation_kind" NOT NULL,
    "fingerprint" VARCHAR(200) NOT NULL,
    "status" "recommendation_status" NOT NULL DEFAULT 'OPEN',
    "evidence" JSONB NOT NULL,
    "current" BOOLEAN NOT NULL DEFAULT true,
    "dismiss_reason" VARCHAR(500),
    "snoozed_until" TIMESTAMPTZ(3),
    "decided_by_user_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "draft_content_item_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "computed_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "metric_imports_workspace_id_created_at_idx" ON "metric_imports"("workspace_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "metric_imports_imported_by_user_id_idx" ON "metric_imports"("imported_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "metric_imports_workspace_id_provider_external_id_key" ON "metric_imports"("workspace_id", "provider", "external_id");

-- CreateIndex
CREATE INDEX "metric_observations_workspace_id_provider_source_ref_idx" ON "metric_observations"("workspace_id", "provider", "source_ref");

-- CreateIndex
CREATE INDEX "metric_observations_workspace_id_campaign_id_metric_period__idx" ON "metric_observations"("workspace_id", "campaign_id", "metric", "period_start");

-- CreateIndex
CREATE INDEX "metric_observations_workspace_id_content_item_id_idx" ON "metric_observations"("workspace_id", "content_item_id");

-- CreateIndex
CREATE INDEX "metric_observations_import_id_idx" ON "metric_observations"("import_id");

-- CreateIndex
CREATE INDEX "metric_observations_campaign_id_idx" ON "metric_observations"("campaign_id");

-- CreateIndex
CREATE INDEX "metric_observations_content_item_id_idx" ON "metric_observations"("content_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "metric_observations_import_id_source_ref_key" ON "metric_observations"("import_id", "source_ref");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_recommendations_draft_content_item_id_key" ON "marketing_recommendations"("draft_content_item_id");

-- CreateIndex
CREATE INDEX "marketing_recommendations_workspace_id_status_current_idx" ON "marketing_recommendations"("workspace_id", "status", "current");

-- CreateIndex
CREATE INDEX "marketing_recommendations_campaign_id_idx" ON "marketing_recommendations"("campaign_id");

-- CreateIndex
CREATE INDEX "marketing_recommendations_content_item_id_idx" ON "marketing_recommendations"("content_item_id");

-- CreateIndex
CREATE INDEX "marketing_recommendations_decided_by_user_id_idx" ON "marketing_recommendations"("decided_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_recommendations_workspace_id_fingerprint_key" ON "marketing_recommendations"("workspace_id", "fingerprint");

-- AddForeignKey
ALTER TABLE "metric_imports" ADD CONSTRAINT "metric_imports_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_imports" ADD CONSTRAINT "metric_imports_imported_by_user_id_fkey" FOREIGN KEY ("imported_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_observations" ADD CONSTRAINT "metric_observations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_observations" ADD CONSTRAINT "metric_observations_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "metric_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_observations" ADD CONSTRAINT "metric_observations_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_observations" ADD CONSTRAINT "metric_observations_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_recommendations" ADD CONSTRAINT "marketing_recommendations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_recommendations" ADD CONSTRAINT "marketing_recommendations_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_recommendations" ADD CONSTRAINT "marketing_recommendations_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_recommendations" ADD CONSTRAINT "marketing_recommendations_draft_content_item_id_fkey" FOREIGN KEY ("draft_content_item_id") REFERENCES "content_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_recommendations" ADD CONSTRAINT "marketing_recommendations_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── Marketing intelligence rules Prisma cannot express ──

-- A goal's target is compared automatically only for count metrics (money needs a
-- currency the goal does not have).
ALTER TABLE "marketing_goals" ADD CONSTRAINT "marketing_goals_target_metric_check"
  CHECK ("target_metric" IS NULL OR "target_metric" NOT IN ('REVENUE', 'SPEND'));

-- No verified provider integration exists yet: VERIFIED cannot be written until a
-- migration that ships one lifts this. Counts add up; a voided import says when; a
-- failed import stored nothing and says why.
ALTER TABLE "metric_imports" ADD CONSTRAINT "metric_imports_source_check"
  CHECK ("source" <> 'VERIFIED');
ALTER TABLE "metric_imports" ADD CONSTRAINT "metric_imports_counts_check"
  CHECK ("rows_received" >= 0 AND "rows_accepted" >= 0 AND "rows_duplicate" >= 0
     AND "rows_rejected" >= 0
     AND "rows_received" = "rows_accepted" + "rows_duplicate" + "rows_rejected");
ALTER TABLE "metric_imports" ADD CONSTRAINT "metric_imports_status_check"
  CHECK ((("status" = 'VOIDED') = ("voided_at" IS NOT NULL))
     AND ("status" <> 'FAILED' OR ("rows_accepted" = 0 AND "error_code" IS NOT NULL)));
ALTER TABLE "metric_imports" ADD CONSTRAINT "metric_imports_text_check"
  CHECK (length(btrim("provider")) > 0 AND length(btrim("external_id")) > 0);

-- Observations: non-negative whole values; money exactly when the metric is money, in
-- an ISO 4217 code; a period of at most 92 days that does not end before it starts.
ALTER TABLE "metric_observations" ADD CONSTRAINT "metric_observations_source_check"
  CHECK ("source" <> 'VERIFIED');
ALTER TABLE "metric_observations" ADD CONSTRAINT "metric_observations_value_check"
  CHECK ("value" >= 0);
ALTER TABLE "metric_observations" ADD CONSTRAINT "metric_observations_currency_check"
  CHECK ((("metric" IN ('REVENUE', 'SPEND')) = ("currency" IS NOT NULL))
     AND ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$'));
ALTER TABLE "metric_observations" ADD CONSTRAINT "metric_observations_period_check"
  CHECK ("period_end" >= "period_start" AND "period_end" - "period_start" <= 92);
ALTER TABLE "metric_observations" ADD CONSTRAINT "metric_observations_ref_check"
  CHECK (length(btrim("source_ref")) > 0);

-- Recommendation decisions are explained and dated.
ALTER TABLE "marketing_recommendations" ADD CONSTRAINT "marketing_recommendations_state_check"
  CHECK (("status" <> 'DISMISSED' OR ("dismiss_reason" IS NOT NULL AND length(btrim("dismiss_reason")) > 0))
     AND (("status" = 'SNOOZED') = ("snoozed_until" IS NOT NULL))
     AND ("status" = 'OPEN' OR "decided_at" IS NOT NULL)
     AND ("status" <> 'ACTED' OR "draft_content_item_id" IS NOT NULL)
     AND "version" >= 1);

-- Every reference stays inside the row's workspace, which never changes.
CREATE TRIGGER "metric_imports_workspace_immutable" BEFORE UPDATE ON "metric_imports"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
CREATE TRIGGER "metric_observations_same_workspace" BEFORE INSERT OR UPDATE ON "metric_observations"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"(
    'import_id', 'metric_imports', 'campaign_id', 'campaigns', 'content_item_id', 'content_items');
CREATE TRIGGER "marketing_recommendations_same_workspace" BEFORE INSERT OR UPDATE ON "marketing_recommendations"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"(
    'campaign_id', 'campaigns', 'content_item_id', 'content_items',
    'draft_content_item_id', 'content_items');
CREATE TRIGGER "marketing_recommendations_workspace_immutable" BEFORE UPDATE ON "marketing_recommendations"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();

-- Observations are history: never edited (a wrong import is voided as a whole).
CREATE FUNCTION "metric_observations_immutable_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'metric_observations is append-only' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER "metric_observations_immutable" BEFORE UPDATE ON "metric_observations"
  FOR EACH ROW EXECUTE FUNCTION "metric_observations_immutable_trigger"();

-- An import's identity, source and counts are fixed once written; only voiding changes it.
CREATE FUNCTION "metric_imports_identity_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."source" IS DISTINCT FROM OLD."source"
     OR NEW."external_id" IS DISTINCT FROM OLD."external_id"
     OR NEW."rows_received" IS DISTINCT FROM OLD."rows_received"
     OR NEW."rows_accepted" IS DISTINCT FROM OLD."rows_accepted"
     OR NEW."rows_duplicate" IS DISTINCT FROM OLD."rows_duplicate"
     OR NEW."rows_rejected" IS DISTINCT FROM OLD."rows_rejected"
     OR (OLD."status" = 'VOIDED' AND NEW."status" <> 'VOIDED')
     OR (NEW."status" <> OLD."status" AND NEW."status" <> 'VOIDED') THEN
    RAISE EXCEPTION 'metric_imports can only be voided' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "metric_imports_identity" BEFORE UPDATE ON "metric_imports"
  FOR EACH ROW EXECUTE FUNCTION "metric_imports_identity_trigger"();
