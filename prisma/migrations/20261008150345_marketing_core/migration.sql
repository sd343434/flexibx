-- CreateEnum
CREATE TYPE "brand_language" AS ENUM ('AR', 'EN', 'BILINGUAL');

-- CreateEnum
CREATE TYPE "buying_intent" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "marketing_goal_type" AS ENUM ('AWARENESS', 'ENGAGEMENT', 'LEADS', 'SALES', 'RETENTION', 'TRAFFIC', 'GROWTH', 'OTHER');

-- CreateEnum
CREATE TYPE "marketing_goal_status" AS ENUM ('ACTIVE', 'PAUSED', 'ACHIEVED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "content_pillar_status" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "campaign_status" AS ENUM ('DRAFT', 'PLANNED', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "content_type" AS ENUM ('POST', 'REEL', 'STORY', 'VIDEO', 'CAROUSEL', 'ARTICLE', 'EMAIL', 'OTHER');

-- CreateEnum
CREATE TYPE "content_status" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED', 'SCHEDULED', 'PUBLISHED');

-- CreateTable
CREATE TABLE "brands" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(2000),
    "website" VARCHAR(2048),
    "industry" VARCHAR(120),
    "market" VARCHAR(200),
    "language" "brand_language" NOT NULL DEFAULT 'AR',
    "mission" VARCHAR(2000),
    "positioning" VARCHAR(2000),
    "value_proposition" VARCHAR(2000),
    "tone_of_voice" VARCHAR(1000),
    "personality" VARCHAR(1000),
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "forbidden_words" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cta_style" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audiences" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(2000),
    "attributes" JSONB NOT NULL DEFAULT '[]',
    "pain_points" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "needs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "interests" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "buying_intent" "buying_intent",
    "objections" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "preferred_channels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" VARCHAR(4000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audiences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_goals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "type" "marketing_goal_type" NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "description" VARCHAR(2000),
    "kpi" VARCHAR(160),
    "target" DECIMAL(14,2),
    "start_date" DATE,
    "end_date" DATE,
    "status" "marketing_goal_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_pillars" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(2000),
    "objective" VARCHAR(1000),
    "audience_id" UUID,
    "status" "content_pillar_status" NOT NULL DEFAULT 'ACTIVE',
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_pillars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "description" VARCHAR(2000),
    "objective" VARCHAR(1000),
    "start_date" DATE,
    "end_date" DATE,
    "status" "campaign_status" NOT NULL DEFAULT 'DRAFT',
    "audience_id" UUID,
    "budget_amount_minor" BIGINT,
    "budget_currency" CHAR(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_goals" (
    "workspace_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "goal_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_goals_pkey" PRIMARY KEY ("campaign_id","goal_id")
);

-- CreateTable
CREATE TABLE "campaign_pillars" (
    "workspace_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "pillar_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_pillars_pkey" PRIMARY KEY ("campaign_id","pillar_id")
);

-- CreateTable
CREATE TABLE "content_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "body" VARCHAR(10000) NOT NULL DEFAULT '',
    "type" "content_type" NOT NULL DEFAULT 'POST',
    "status" "content_status" NOT NULL DEFAULT 'DRAFT',
    "campaign_id" UUID,
    "pillar_id" UUID,
    "audience_id" UUID,
    "goal_id" UUID,
    "scheduled_at" TIMESTAMPTZ(3),
    "published_at" TIMESTAMPTZ(3),
    "notes" VARCHAR(4000),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_assets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "filename" VARCHAR(255) NOT NULL,
    "content_type" VARCHAR(100) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_key" VARCHAR(512) NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "alt_text" VARCHAR(500),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "uploaded_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_item_assets" (
    "workspace_id" UUID NOT NULL,
    "content_item_id" UUID NOT NULL,
    "media_asset_id" UUID NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_item_assets_pkey" PRIMARY KEY ("content_item_id","media_asset_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "brands_workspace_id_key" ON "brands"("workspace_id");

-- CreateIndex
CREATE INDEX "audiences_workspace_id_name_idx" ON "audiences"("workspace_id", "name");

-- CreateIndex
CREATE INDEX "marketing_goals_workspace_id_status_idx" ON "marketing_goals"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "content_pillars_workspace_id_status_position_idx" ON "content_pillars"("workspace_id", "status", "position");

-- CreateIndex
CREATE INDEX "content_pillars_audience_id_idx" ON "content_pillars"("audience_id");

-- CreateIndex
CREATE INDEX "campaigns_workspace_id_status_start_date_idx" ON "campaigns"("workspace_id", "status", "start_date");

-- CreateIndex
CREATE INDEX "campaigns_audience_id_idx" ON "campaigns"("audience_id");

-- CreateIndex
CREATE INDEX "campaign_goals_workspace_id_idx" ON "campaign_goals"("workspace_id");

-- CreateIndex
CREATE INDEX "campaign_goals_goal_id_idx" ON "campaign_goals"("goal_id");

-- CreateIndex
CREATE INDEX "campaign_pillars_workspace_id_idx" ON "campaign_pillars"("workspace_id");

-- CreateIndex
CREATE INDEX "campaign_pillars_pillar_id_idx" ON "campaign_pillars"("pillar_id");

-- CreateIndex
CREATE INDEX "content_items_workspace_id_status_updated_at_idx" ON "content_items"("workspace_id", "status", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "content_items_workspace_id_scheduled_at_idx" ON "content_items"("workspace_id", "scheduled_at");

-- CreateIndex
CREATE INDEX "content_items_workspace_id_updated_at_idx" ON "content_items"("workspace_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "content_items_campaign_id_idx" ON "content_items"("campaign_id");

-- CreateIndex
CREATE INDEX "content_items_pillar_id_idx" ON "content_items"("pillar_id");

-- CreateIndex
CREATE INDEX "content_items_audience_id_idx" ON "content_items"("audience_id");

-- CreateIndex
CREATE INDEX "content_items_goal_id_idx" ON "content_items"("goal_id");

-- CreateIndex
CREATE INDEX "content_items_created_by_user_id_idx" ON "content_items"("created_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_storage_key_key" ON "media_assets"("storage_key");

-- CreateIndex
CREATE INDEX "media_assets_workspace_id_created_at_idx" ON "media_assets"("workspace_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "media_assets_uploaded_by_user_id_idx" ON "media_assets"("uploaded_by_user_id");

-- CreateIndex
CREATE INDEX "content_item_assets_workspace_id_idx" ON "content_item_assets"("workspace_id");

-- CreateIndex
CREATE INDEX "content_item_assets_media_asset_id_idx" ON "content_item_assets"("media_asset_id");

-- AddForeignKey
ALTER TABLE "brands" ADD CONSTRAINT "brands_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audiences" ADD CONSTRAINT "audiences_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_goals" ADD CONSTRAINT "marketing_goals_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_pillars" ADD CONSTRAINT "content_pillars_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_pillars" ADD CONSTRAINT "content_pillars_audience_id_fkey" FOREIGN KEY ("audience_id") REFERENCES "audiences"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_audience_id_fkey" FOREIGN KEY ("audience_id") REFERENCES "audiences"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_goals" ADD CONSTRAINT "campaign_goals_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_goals" ADD CONSTRAINT "campaign_goals_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_goals" ADD CONSTRAINT "campaign_goals_goal_id_fkey" FOREIGN KEY ("goal_id") REFERENCES "marketing_goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_pillars" ADD CONSTRAINT "campaign_pillars_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_pillars" ADD CONSTRAINT "campaign_pillars_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_pillars" ADD CONSTRAINT "campaign_pillars_pillar_id_fkey" FOREIGN KEY ("pillar_id") REFERENCES "content_pillars"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_pillar_id_fkey" FOREIGN KEY ("pillar_id") REFERENCES "content_pillars"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_audience_id_fkey" FOREIGN KEY ("audience_id") REFERENCES "audiences"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_goal_id_fkey" FOREIGN KEY ("goal_id") REFERENCES "marketing_goals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_uploaded_by_user_id_fkey" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_item_assets" ADD CONSTRAINT "content_item_assets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_item_assets" ADD CONSTRAINT "content_item_assets_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_item_assets" ADD CONSTRAINT "content_item_assets_media_asset_id_fkey" FOREIGN KEY ("media_asset_id") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Marketing Core rules Prisma cannot express ──

-- Every relation between two marketing records stays inside one workspace. The
-- services already resolve every client-supplied id through a workspace-scoped lookup;
-- these triggers make a cross-workspace link impossible even for a buggy caller.
CREATE FUNCTION "marketing_assert_same_workspace"(ref_table regclass, ref_id uuid, ws uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  matches boolean;
BEGIN
  IF ref_id IS NULL THEN
    RETURN;
  END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE id = $1 AND workspace_id = $2)', ref_table)
    INTO matches USING ref_id, ws;
  IF NOT matches THEN
    RAISE EXCEPTION 'cross-workspace reference to %', ref_table
      USING ERRCODE = 'foreign_key_violation';
  END IF;
END
$$;

-- Trigger arguments are (column, referenced table) pairs.
CREATE FUNCTION "marketing_same_workspace_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  i integer := 0;
  row_data jsonb := to_jsonb(NEW);
BEGIN
  WHILE i < TG_NARGS LOOP
    PERFORM "marketing_assert_same_workspace"(
      TG_ARGV[i + 1]::regclass, (row_data ->> TG_ARGV[i])::uuid, NEW.workspace_id);
    i := i + 2;
  END LOOP;
  RETURN NEW;
END
$$;

-- A marketing record never moves to another workspace.
CREATE FUNCTION "marketing_workspace_immutable_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    RAISE EXCEPTION 'workspace_id of % cannot change', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "content_pillars_same_workspace" BEFORE INSERT OR UPDATE ON "content_pillars"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"('audience_id', 'audiences');
CREATE TRIGGER "campaigns_same_workspace" BEFORE INSERT OR UPDATE ON "campaigns"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"('audience_id', 'audiences');
CREATE TRIGGER "campaign_goals_same_workspace" BEFORE INSERT OR UPDATE ON "campaign_goals"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"(
    'campaign_id', 'campaigns', 'goal_id', 'marketing_goals');
CREATE TRIGGER "campaign_pillars_same_workspace" BEFORE INSERT OR UPDATE ON "campaign_pillars"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"(
    'campaign_id', 'campaigns', 'pillar_id', 'content_pillars');
CREATE TRIGGER "content_items_same_workspace" BEFORE INSERT OR UPDATE ON "content_items"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"(
    'campaign_id', 'campaigns', 'pillar_id', 'content_pillars',
    'audience_id', 'audiences', 'goal_id', 'marketing_goals');
CREATE TRIGGER "content_item_assets_same_workspace" BEFORE INSERT OR UPDATE ON "content_item_assets"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"(
    'content_item_id', 'content_items', 'media_asset_id', 'media_assets');

CREATE TRIGGER "brands_workspace_immutable" BEFORE UPDATE ON "brands"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
CREATE TRIGGER "audiences_workspace_immutable" BEFORE UPDATE ON "audiences"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
CREATE TRIGGER "marketing_goals_workspace_immutable" BEFORE UPDATE ON "marketing_goals"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
CREATE TRIGGER "content_pillars_workspace_immutable" BEFORE UPDATE ON "content_pillars"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
CREATE TRIGGER "campaigns_workspace_immutable" BEFORE UPDATE ON "campaigns"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
CREATE TRIGGER "content_items_workspace_immutable" BEFORE UPDATE ON "content_items"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
CREATE TRIGGER "media_assets_workspace_immutable" BEFORE UPDATE ON "media_assets"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();

-- Date ranges run forwards.
ALTER TABLE "marketing_goals" ADD CONSTRAINT "marketing_goals_dates_check"
  CHECK ("start_date" IS NULL OR "end_date" IS NULL OR "end_date" >= "start_date");
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_dates_check"
  CHECK ("start_date" IS NULL OR "end_date" IS NULL OR "end_date" >= "start_date");

-- Budget metadata: a non-negative amount with an ISO 4217 currency, or neither.
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_budget_check"
  CHECK (
    ("budget_amount_minor" IS NULL AND "budget_currency" IS NULL)
    OR ("budget_amount_minor" >= 0 AND "budget_currency" ~ '^[A-Z]{3}$')
  );

ALTER TABLE "marketing_goals" ADD CONSTRAINT "marketing_goals_target_check"
  CHECK ("target" IS NULL OR "target" >= 0);
ALTER TABLE "content_pillars" ADD CONSTRAINT "content_pillars_position_check"
  CHECK ("position" >= 0);
ALTER TABLE "content_item_assets" ADD CONSTRAINT "content_item_assets_position_check"
  CHECK ("position" >= 0);

-- Workflow states carry their timestamps.
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_scheduled_check"
  CHECK ("status" <> 'SCHEDULED' OR "scheduled_at" IS NOT NULL);
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_published_check"
  CHECK (("status" = 'PUBLISHED') = ("published_at" IS NOT NULL));

-- Media: positive sizes, an allowed image type, and a storage key inside the owning
-- workspace's prefix (keys are generated by the server, never by the client).
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_size_check"
  CHECK ("size_bytes" > 0);
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_dimensions_check"
  CHECK (("width" IS NULL OR "width" > 0) AND ("height" IS NULL OR "height" > 0));
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_content_type_check"
  CHECK ("content_type" IN ('image/png', 'image/jpeg', 'image/webp'));
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_storage_key_check"
  CHECK (
    "storage_key" ~ ('^workspaces/' || "workspace_id"::text || '/content-media/[0-9a-f-]{36}\.(png|jpg|webp)$')
  );
