-- CreateEnum
CREATE TYPE "content_review_decision" AS ENUM ('APPROVED', 'CHANGES_REQUESTED');

-- CreateTable
CREATE TABLE "content_reviews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "content_item_id" UUID NOT NULL,
    "decision" "content_review_decision" NOT NULL,
    "reason" VARCHAR(2000),
    "reviewer_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "content_reviews_workspace_id_content_item_id_created_at_idx" ON "content_reviews"("workspace_id", "content_item_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "content_reviews_content_item_id_idx" ON "content_reviews"("content_item_id");

-- CreateIndex
CREATE INDEX "content_reviews_reviewer_user_id_idx" ON "content_reviews"("reviewer_user_id");

-- AddForeignKey
ALTER TABLE "content_reviews" ADD CONSTRAINT "content_reviews_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_reviews" ADD CONSTRAINT "content_reviews_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_reviews" ADD CONSTRAINT "content_reviews_reviewer_user_id_fkey" FOREIGN KEY ("reviewer_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A change request always says why (1–2000 characters, not blank); an approval has no
-- reason.
ALTER TABLE "content_reviews" ADD CONSTRAINT "content_reviews_reason_check" CHECK (
  ("decision" = 'CHANGES_REQUESTED' AND "reason" IS NOT NULL AND length(btrim("reason")) > 0)
  OR ("decision" = 'APPROVED' AND "reason" IS NULL)
);

-- The reviewed item belongs to the review's workspace, which never changes.
CREATE TRIGGER "content_reviews_same_workspace" BEFORE INSERT OR UPDATE ON "content_reviews"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"('content_item_id', 'content_items');
CREATE TRIGGER "content_reviews_workspace_immutable" BEFORE UPDATE ON "content_reviews"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();

-- Decisions are immutable. The one permitted change is the reviewer's account being
-- deleted (ON DELETE SET NULL); deleting the content or the workspace still cascades.
CREATE FUNCTION "content_reviews_immutable_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  restored "content_reviews";
BEGIN
  restored := NEW;
  restored."reviewer_user_id" := OLD."reviewer_user_id";
  IF NEW."reviewer_user_id" IS NULL AND restored IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'content_reviews is immutable' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER "content_reviews_immutable" BEFORE UPDATE ON "content_reviews"
  FOR EACH ROW EXECUTE FUNCTION "content_reviews_immutable_trigger"();
