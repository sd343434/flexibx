-- CreateEnum
CREATE TYPE "marketing_channel" AS ENUM ('FACEBOOK_PAGE', 'INSTAGRAM', 'WHATSAPP', 'EMAIL', 'OTHER');

-- CreateEnum
CREATE TYPE "campaign_plan_status" AS ENUM ('DRAFT', 'APPROVED');

-- CreateTable
CREATE TABLE "campaign_plans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "status" "campaign_plan_status" NOT NULL DEFAULT 'DRAFT',
    "offer" VARCHAR(1000),
    "channels" "marketing_channel"[] DEFAULT ARRAY[]::"marketing_channel"[],
    "budget_notes" VARCHAR(1000),
    "generation_id" UUID,
    "approved_by_user_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_plan_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "brief" VARCHAR(2000) NOT NULL DEFAULT '',
    "content_type" "content_type" NOT NULL,
    "channel" "marketing_channel" NOT NULL,
    "planned_date" DATE,
    "included" BOOLEAN NOT NULL DEFAULT true,
    "ai_generated" BOOLEAN NOT NULL DEFAULT false,
    "content_item_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_plan_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "campaign_plans_campaign_id_key" ON "campaign_plans"("campaign_id");

-- CreateIndex
CREATE INDEX "campaign_plans_workspace_id_idx" ON "campaign_plans"("workspace_id");

-- CreateIndex
CREATE INDEX "campaign_plans_generation_id_idx" ON "campaign_plans"("generation_id");

-- CreateIndex
CREATE INDEX "campaign_plans_approved_by_user_id_idx" ON "campaign_plans"("approved_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_plan_items_content_item_id_key" ON "campaign_plan_items"("content_item_id");

-- CreateIndex
CREATE INDEX "campaign_plan_items_workspace_id_plan_id_position_idx" ON "campaign_plan_items"("workspace_id", "plan_id", "position");

-- CreateIndex
CREATE INDEX "campaign_plan_items_plan_id_idx" ON "campaign_plan_items"("plan_id");

-- AddForeignKey
ALTER TABLE "campaign_plans" ADD CONSTRAINT "campaign_plans_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_plans" ADD CONSTRAINT "campaign_plans_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_plans" ADD CONSTRAINT "campaign_plans_generation_id_fkey" FOREIGN KEY ("generation_id") REFERENCES "ai_generations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_plans" ADD CONSTRAINT "campaign_plans_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_plan_items" ADD CONSTRAINT "campaign_plan_items_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_plan_items" ADD CONSTRAINT "campaign_plan_items_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "campaign_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_plan_items" ADD CONSTRAINT "campaign_plan_items_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── Campaign plan rules Prisma cannot express ──

-- An approved plan records when; a draft has no approval. Channels are a real list of at
-- most every channel once; versions only count up from 0.
ALTER TABLE "campaign_plans" ADD CONSTRAINT "campaign_plans_approval_check"
  CHECK (("status" = 'APPROVED') = ("approved_at" IS NOT NULL));
ALTER TABLE "campaign_plans" ADD CONSTRAINT "campaign_plans_channels_check"
  CHECK ("channels" IS NOT NULL AND cardinality("channels") <= 5);
ALTER TABLE "campaign_plans" ADD CONSTRAINT "campaign_plans_version_check"
  CHECK ("version" >= 0);

-- Items have a title and a place; an item that became content is an included one.
ALTER TABLE "campaign_plan_items" ADD CONSTRAINT "campaign_plan_items_title_check"
  CHECK (length(btrim("title")) > 0);
ALTER TABLE "campaign_plan_items" ADD CONSTRAINT "campaign_plan_items_position_check"
  CHECK ("position" >= 0);
ALTER TABLE "campaign_plan_items" ADD CONSTRAINT "campaign_plan_items_converted_check"
  CHECK ("content_item_id" IS NULL OR "included");

-- The campaign, the generation, the plan and the drafted content all belong to the row's
-- own workspace, which never changes (Phase 3 trigger functions).
CREATE TRIGGER "campaign_plans_same_workspace" BEFORE INSERT OR UPDATE ON "campaign_plans"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"(
    'campaign_id', 'campaigns', 'generation_id', 'ai_generations');
CREATE TRIGGER "campaign_plans_workspace_immutable" BEFORE UPDATE ON "campaign_plans"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
CREATE TRIGGER "campaign_plan_items_same_workspace" BEFORE INSERT OR UPDATE ON "campaign_plan_items"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"(
    'plan_id', 'campaign_plans', 'content_item_id', 'content_items');
CREATE TRIGGER "campaign_plan_items_workspace_immutable" BEFORE UPDATE ON "campaign_plan_items"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();

-- A plan stays with its campaign and an item with its plan. An item's draft is linked
-- once: it may be set while empty, and cleared only when that content is deleted
-- (ON DELETE SET NULL) — never moved to another content item.
CREATE FUNCTION "campaign_plans_identity_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."campaign_id" IS DISTINCT FROM OLD."campaign_id" THEN
    RAISE EXCEPTION 'campaign_plans.campaign_id is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "campaign_plans_identity" BEFORE UPDATE ON "campaign_plans"
  FOR EACH ROW EXECUTE FUNCTION "campaign_plans_identity_trigger"();

CREATE FUNCTION "campaign_plan_items_identity_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."plan_id" IS DISTINCT FROM OLD."plan_id" THEN
    RAISE EXCEPTION 'campaign_plan_items.plan_id is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."content_item_id" IS NOT NULL AND NEW."content_item_id" IS NOT NULL
     AND NEW."content_item_id" <> OLD."content_item_id" THEN
    RAISE EXCEPTION 'campaign_plan_items.content_item_id is set once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "campaign_plan_items_identity" BEFORE UPDATE ON "campaign_plan_items"
  FOR EACH ROW EXECUTE FUNCTION "campaign_plan_items_identity_trigger"();
