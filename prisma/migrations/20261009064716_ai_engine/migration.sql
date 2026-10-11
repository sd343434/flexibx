-- CreateEnum
CREATE TYPE "ai_operation" AS ENUM ('IDEAS', 'BRIEF', 'COPY', 'CONTENT_DRAFT', 'CONTENT_REWRITE', 'CONTENT_ALTERNATIVES', 'CONTENT_HOOK', 'CONTENT_CTA', 'CONTENT_BRIEF');

-- CreateEnum
CREATE TYPE "ai_generation_status" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "ai_generations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "user_id" UUID,
    "operation" "ai_operation" NOT NULL,
    "status" "ai_generation_status" NOT NULL DEFAULT 'PENDING',
    "provider" VARCHAR(40) NOT NULL,
    "model" VARCHAR(100),
    "language" "locale" NOT NULL,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "cost_micros" BIGINT,
    "latency_ms" INTEGER,
    "error_code" VARCHAR(40),
    "content_item_id" UUID,
    "output" JSONB,
    "references" JSONB NOT NULL DEFAULT '{}',
    "applied_at" TIMESTAMPTZ(3),
    "applied_content_item_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_generations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_generations_workspace_id_created_at_idx" ON "ai_generations"("workspace_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ai_generations_workspace_id_user_id_created_at_idx" ON "ai_generations"("workspace_id", "user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ai_generations_workspace_id_content_item_id_created_at_idx" ON "ai_generations"("workspace_id", "content_item_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ai_generations_user_id_idx" ON "ai_generations"("user_id");

-- CreateIndex
CREATE INDEX "ai_generations_content_item_id_idx" ON "ai_generations"("content_item_id");

-- CreateIndex
CREATE INDEX "ai_generations_applied_content_item_id_idx" ON "ai_generations"("applied_content_item_id");

-- AddForeignKey
ALTER TABLE "ai_generations" ADD CONSTRAINT "ai_generations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_generations" ADD CONSTRAINT "ai_generations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_generations" ADD CONSTRAINT "ai_generations_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "content_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_generations" ADD CONSTRAINT "ai_generations_applied_content_item_id_fkey" FOREIGN KEY ("applied_content_item_id") REFERENCES "content_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── AI Marketing Engine rules Prisma cannot express ──

-- The target and the applied content item belong to the generation's own workspace,
-- and a generation never moves to another workspace (Phase 3 trigger functions).
CREATE TRIGGER "ai_generations_same_workspace" BEFORE INSERT OR UPDATE ON "ai_generations"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"(
    'content_item_id', 'content_items', 'applied_content_item_id', 'content_items');
CREATE TRIGGER "ai_generations_workspace_immutable" BEFORE UPDATE ON "ai_generations"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();

-- Output exists exactly when the generation succeeded; failures carry an error code.
ALTER TABLE "ai_generations" ADD CONSTRAINT "ai_generations_output_check"
  CHECK (("status" = 'SUCCEEDED') = ("output" IS NOT NULL));
ALTER TABLE "ai_generations" ADD CONSTRAINT "ai_generations_error_check"
  CHECK (("status" = 'FAILED') = ("error_code" IS NOT NULL));

-- Only a successful generation can be used, and only once (applied_at is set once).
ALTER TABLE "ai_generations" ADD CONSTRAINT "ai_generations_applied_check"
  CHECK ("applied_at" IS NULL OR "status" = 'SUCCEEDED');
ALTER TABLE "ai_generations" ADD CONSTRAINT "ai_generations_applied_item_check"
  CHECK ("applied_content_item_id" IS NULL OR "applied_at" IS NOT NULL);

-- Usage metrics are never negative (null = not reported).
ALTER TABLE "ai_generations" ADD CONSTRAINT "ai_generations_metrics_check"
  CHECK (
    ("input_tokens" IS NULL OR "input_tokens" >= 0)
    AND ("output_tokens" IS NULL OR "output_tokens" >= 0)
    AND ("cost_micros" IS NULL OR "cost_micros" >= 0)
    AND ("latency_ms" IS NULL OR "latency_ms" >= 0)
  );
