-- CreateTable
CREATE TABLE "social_posts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "content_item_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'SCHEDULED',
    "scheduled_at" TIMESTAMPTZ(3) NOT NULL,
    "message" VARCHAR(10000) NOT NULL,
    "link" VARCHAR(2000),
    "external_post_id" VARCHAR(128),
    "published_at" TIMESTAMPTZ(3),
    "error_code" VARCHAR(60),
    "requested_by_user_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "social_posts_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "social_posts_status_scheduled_at_idx" ON "social_posts"("status", "scheduled_at");
-- CreateIndex
CREATE INDEX "social_posts_workspace_id_created_at_idx" ON "social_posts"("workspace_id", "created_at" DESC);
-- CreateIndex
CREATE INDEX "social_posts_channel_id_idx" ON "social_posts"("channel_id");
-- CreateIndex
CREATE UNIQUE INDEX "social_posts_content_item_id_channel_id_key" ON "social_posts"("content_item_id", "channel_id");
-- AddForeignKey
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "social_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Integrity ────────────────────────────────────────────────────────────────
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_check" CHECK (
  "status" IN ('SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'UNCERTAIN', 'FAILED', 'CANCELLED')
  AND ("status" <> 'PUBLISHED' OR ("published_at" IS NOT NULL AND "external_post_id" IS NOT NULL))
  AND length("message") > 0
);
CREATE TRIGGER "social_posts_same_workspace" BEFORE INSERT OR UPDATE ON "social_posts"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"('content_item_id', 'content_items', 'channel_id', 'social_channels');
CREATE TRIGGER "social_posts_workspace_immutable" BEFORE UPDATE ON "social_posts"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
