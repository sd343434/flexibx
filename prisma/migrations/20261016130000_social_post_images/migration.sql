-- AlterTable
ALTER TABLE "social_posts" ADD COLUMN     "media_asset_id" UUID,
ADD COLUMN     "with_image" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "social_posts_media_asset_id_idx" ON "social_posts"("media_asset_id");

-- AddForeignKey
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_media_asset_id_fkey" FOREIGN KEY ("media_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- An image can only be named on a post queued with an image.
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_image_check" CHECK (
  "with_image" OR "media_asset_id" IS NULL
);

-- The image belongs to the post's workspace, like its content item and channel.
DROP TRIGGER "social_posts_same_workspace" ON "social_posts";
CREATE TRIGGER "social_posts_same_workspace" BEFORE INSERT OR UPDATE ON "social_posts"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"(
    'content_item_id', 'content_items', 'channel_id', 'social_channels',
    'media_asset_id', 'media_assets');
