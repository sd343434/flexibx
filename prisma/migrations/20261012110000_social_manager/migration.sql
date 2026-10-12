-- CreateEnum
CREATE TYPE "social_platform" AS ENUM ('FACEBOOK', 'INSTAGRAM');
-- CreateEnum
CREATE TYPE "social_agent_mode" AS ENUM ('SUGGEST', 'AUTO');
-- CreateEnum
CREATE TYPE "social_interaction_kind" AS ENUM ('COMMENT', 'MESSAGE');
-- CreateEnum
CREATE TYPE "social_interaction_status" AS ENUM ('NEW', 'AWAITING_REVIEW', 'ESCALATED', 'SENDING', 'REPLIED', 'UNCERTAIN', 'FAILED', 'IGNORED');
-- CreateEnum
CREATE TYPE "social_reply_decision" AS ENUM ('PENDING', 'APPROVED', 'EDITED', 'REJECTED', 'AUTO');
-- CreateEnum
CREATE TYPE "social_lesson_kind" AS ENUM ('EXAMPLE', 'RULE', 'GUIDANCE');
-- CreateEnum
CREATE TYPE "social_lesson_status" AS ENUM ('ACTIVE', 'PROPOSED', 'APPLIED', 'DISMISSED');
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.
ALTER TYPE "ai_operation" ADD VALUE 'SOCIAL_REPLY';
ALTER TYPE "ai_operation" ADD VALUE 'SOCIAL_LEARNING';
-- CreateTable
CREATE TABLE "social_channels" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "platform" "social_platform" NOT NULL,
    "external_id" VARCHAR(64) NOT NULL,
    "page_id" VARCHAR(64) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "agent_id" UUID,
    "subscribed" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "social_channels_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "social_agents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "role" VARCHAR(40) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "mode" "social_agent_mode" NOT NULL DEFAULT 'SUGGEST',
    "language" VARCHAR(8) NOT NULL DEFAULT 'auto',
    "tone" VARCHAR(500) NOT NULL DEFAULT '',
    "business_info" VARCHAR(6000) NOT NULL DEFAULT '',
    "faq" JSONB NOT NULL DEFAULT '[]',
    "policies" VARCHAR(4000) NOT NULL DEFAULT '',
    "escalation" VARCHAR(2000) NOT NULL DEFAULT '',
    "forbidden" VARCHAR(2000) NOT NULL DEFAULT '',
    "guidance" VARCHAR(6000) NOT NULL DEFAULT '',
    "guidance_version" INTEGER NOT NULL DEFAULT 0,
    "auto_categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "min_confidence" INTEGER NOT NULL DEFAULT 85,
    "daily_auto_cap" INTEGER NOT NULL DEFAULT 50,
    "delegate_user_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "social_agents_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "social_interactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "agent_id" UUID,
    "kind" "social_interaction_kind" NOT NULL,
    "external_id" VARCHAR(128) NOT NULL,
    "thread_external_id" VARCHAR(128) NOT NULL,
    "author_external_id" VARCHAR(128),
    "author_name" VARCHAR(200),
    "text" VARCHAR(8000) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "social_interaction_status" NOT NULL DEFAULT 'NEW',
    "category" VARCHAR(20),
    "sentiment" VARCHAR(20),
    "last_error" VARCHAR(60),
    "draft_attempts" INTEGER NOT NULL DEFAULT 0,
    "drafting_until" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "social_interactions_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "social_replies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "interaction_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "generation_id" UUID,
    "draft_text" VARCHAR(2000),
    "confidence" INTEGER NOT NULL,
    "needs_human" BOOLEAN NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "guidance_version" INTEGER NOT NULL,
    "decision" "social_reply_decision" NOT NULL DEFAULT 'PENDING',
    "final_text" VARCHAR(2000),
    "decided_by_user_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "reject_reason" VARCHAR(500),
    "send_status" VARCHAR(20) NOT NULL DEFAULT 'NOT_SENT',
    "external_reply_id" VARCHAR(128),
    "sent_at" TIMESTAMPTZ(3),
    "send_error" VARCHAR(60),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "social_replies_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "social_lessons" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "kind" "social_lesson_kind" NOT NULL,
    "status" "social_lesson_status" NOT NULL,
    "source" VARCHAR(20) NOT NULL,
    "customer_text" VARCHAR(2000),
    "draft_text" VARCHAR(2000),
    "content" VARCHAR(6000) NOT NULL,
    "reply_id" UUID,
    "created_by_user_id" UUID,
    "decided_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "social_lessons_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "social_channels_platform_external_id_idx" ON "social_channels"("platform", "external_id");
-- CreateIndex
CREATE INDEX "social_channels_agent_id_idx" ON "social_channels"("agent_id");
-- CreateIndex
CREATE UNIQUE INDEX "social_channels_workspace_id_platform_external_id_key" ON "social_channels"("workspace_id", "platform", "external_id");
-- CreateIndex
CREATE INDEX "social_agents_workspace_id_idx" ON "social_agents"("workspace_id");
-- CreateIndex
CREATE INDEX "social_interactions_workspace_id_status_received_at_idx" ON "social_interactions"("workspace_id", "status", "received_at" DESC);
-- CreateIndex
CREATE INDEX "social_interactions_channel_id_idx" ON "social_interactions"("channel_id");
-- CreateIndex
CREATE INDEX "social_interactions_agent_id_idx" ON "social_interactions"("agent_id");
-- CreateIndex
CREATE UNIQUE INDEX "social_interactions_workspace_id_channel_id_external_id_key" ON "social_interactions"("workspace_id", "channel_id", "external_id");
-- CreateIndex
CREATE INDEX "social_replies_workspace_id_created_at_idx" ON "social_replies"("workspace_id", "created_at" DESC);
-- CreateIndex
CREATE INDEX "social_replies_interaction_id_idx" ON "social_replies"("interaction_id");
-- CreateIndex
CREATE INDEX "social_replies_agent_id_created_at_idx" ON "social_replies"("agent_id", "created_at" DESC);
-- CreateIndex
CREATE INDEX "social_lessons_agent_id_kind_status_created_at_idx" ON "social_lessons"("agent_id", "kind", "status", "created_at" DESC);
-- CreateIndex
CREATE INDEX "social_lessons_workspace_id_idx" ON "social_lessons"("workspace_id");
-- AddForeignKey
ALTER TABLE "social_channels" ADD CONSTRAINT "social_channels_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "social_channels" ADD CONSTRAINT "social_channels_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "social_agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "social_agents" ADD CONSTRAINT "social_agents_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "social_interactions" ADD CONSTRAINT "social_interactions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "social_interactions" ADD CONSTRAINT "social_interactions_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "social_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "social_interactions" ADD CONSTRAINT "social_interactions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "social_agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "social_replies" ADD CONSTRAINT "social_replies_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "social_replies" ADD CONSTRAINT "social_replies_interaction_id_fkey" FOREIGN KEY ("interaction_id") REFERENCES "social_interactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "social_replies" ADD CONSTRAINT "social_replies_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "social_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "social_lessons" ADD CONSTRAINT "social_lessons_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "social_lessons" ADD CONSTRAINT "social_lessons_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "social_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Integrity (Prisma cannot express these) ──────────────────────────────────

ALTER TABLE "social_agents" ADD CONSTRAINT "social_agents_check" CHECK (
  "role" IN ('customer_service', 'sales', 'community')
  AND "language" IN ('auto', 'ar', 'en')
  AND "min_confidence" BETWEEN 50 AND 100
  AND "daily_auto_cap" BETWEEN 0 AND 1000
  AND jsonb_typeof("faq") = 'array'
  AND "auto_categories" <@ ARRAY['question', 'praise', 'lead', 'other']::text[]
);
ALTER TABLE "social_interactions" ADD CONSTRAINT "social_interactions_check" CHECK (
  ("category" IS NULL OR "category" IN ('question', 'complaint', 'praise', 'lead', 'spam', 'other'))
  AND ("sentiment" IS NULL OR "sentiment" IN ('positive', 'neutral', 'negative'))
  AND "draft_attempts" >= 0
);
ALTER TABLE "social_replies" ADD CONSTRAINT "social_replies_check" CHECK (
  "confidence" BETWEEN 0 AND 100
  AND "send_status" IN ('NOT_SENT', 'SENDING', 'SENT', 'UNCERTAIN', 'FAILED')
  -- Something is sent only after a decision to send it, and with its text.
  AND ("send_status" = 'NOT_SENT' OR ("decision" IN ('APPROVED', 'EDITED', 'AUTO') AND "final_text" IS NOT NULL))
  AND ("send_status" <> 'SENT' OR "sent_at" IS NOT NULL)
);
ALTER TABLE "social_lessons" ADD CONSTRAINT "social_lessons_check" CHECK (
  "source" IN ('edit', 'approval', 'rejection', 'self_review', 'manual')
  AND ("kind" <> 'GUIDANCE' OR "status" IN ('PROPOSED', 'APPLIED', 'DISMISSED'))
  AND ("kind" = 'GUIDANCE' OR "status" IN ('ACTIVE', 'DISMISSED'))
);

-- Linked rows stay in one workspace; a row never moves to another workspace.
CREATE TRIGGER "social_channels_same_workspace" BEFORE INSERT OR UPDATE ON "social_channels"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"('agent_id', 'social_agents');
CREATE TRIGGER "social_channels_workspace_immutable" BEFORE UPDATE ON "social_channels"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
CREATE TRIGGER "social_agents_workspace_immutable" BEFORE UPDATE ON "social_agents"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
CREATE TRIGGER "social_interactions_same_workspace" BEFORE INSERT OR UPDATE ON "social_interactions"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"('channel_id', 'social_channels', 'agent_id', 'social_agents');
CREATE TRIGGER "social_interactions_workspace_immutable" BEFORE UPDATE ON "social_interactions"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
CREATE TRIGGER "social_replies_same_workspace" BEFORE INSERT OR UPDATE ON "social_replies"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"('interaction_id', 'social_interactions', 'agent_id', 'social_agents', 'generation_id', 'ai_generations');
CREATE TRIGGER "social_replies_workspace_immutable" BEFORE UPDATE ON "social_replies"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
CREATE TRIGGER "social_lessons_same_workspace" BEFORE INSERT OR UPDATE ON "social_lessons"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"('agent_id', 'social_agents', 'reply_id', 'social_replies');
CREATE TRIGGER "social_lessons_workspace_immutable" BEFORE UPDATE ON "social_lessons"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();

-- ── One automatic reply per platform message, across workspaces ──────────────
-- Two workspaces may manage the same Page (each through its own Meta connection); the
-- claim is unique on the platform's ids, not per workspace, so only one AUTO agent answers.

-- CreateTable
CREATE TABLE "social_auto_reply_claims" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "interaction_id" UUID NOT NULL,
    "platform" "social_platform" NOT NULL,
    "channel_external_id" VARCHAR(64) NOT NULL,
    "external_id" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_auto_reply_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "social_auto_reply_claims_workspace_id_idx" ON "social_auto_reply_claims"("workspace_id");

-- CreateIndex
CREATE INDEX "social_auto_reply_claims_interaction_id_idx" ON "social_auto_reply_claims"("interaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "social_auto_reply_claims_platform_channel_external_id_exter_key" ON "social_auto_reply_claims"("platform", "channel_external_id", "external_id");

-- AddForeignKey
ALTER TABLE "social_auto_reply_claims" ADD CONSTRAINT "social_auto_reply_claims_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_auto_reply_claims" ADD CONSTRAINT "social_auto_reply_claims_interaction_id_fkey" FOREIGN KEY ("interaction_id") REFERENCES "social_interactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TRIGGER "social_auto_reply_claims_same_workspace" BEFORE INSERT OR UPDATE ON "social_auto_reply_claims"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"('interaction_id', 'social_interactions');
CREATE TRIGGER "social_auto_reply_claims_workspace_immutable" BEFORE UPDATE ON "social_auto_reply_claims"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
