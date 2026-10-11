-- CreateEnum
CREATE TYPE "GeneratedVideoStatus" AS ENUM ('AVAILABLE', 'DELETING', 'DELETED');

-- CreateEnum
CREATE TYPE "GeneratedVideoFileKind" AS ENUM ('VIDEO', 'THUMBNAIL', 'DERIVATIVE', 'TEMPORARY');

-- CreateTable
CREATE TABLE "generated_videos" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "user_id" UUID,
    "title" VARCHAR(200) NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "model" VARCHAR(100),
    "provider_job_id" VARCHAR(200),
    "duration_seconds" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "cost_micros" BIGINT,
    "status" "GeneratedVideoStatus" NOT NULL DEFAULT 'AVAILABLE',
    "succeeded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "expires_at" TIMESTAMPTZ(3) NOT NULL DEFAULT (now() + '168:00:00'::interval),
    "reminder_48h_at" TIMESTAMPTZ(3),
    "reminder_24h_at" TIMESTAMPTZ(3),
    "deletion_attempts" INTEGER NOT NULL DEFAULT 0,
    "next_deletion_attempt_at" TIMESTAMPTZ(3),
    "last_deletion_error" VARCHAR(60),
    "files_deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generated_videos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generated_video_files" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "video_id" UUID NOT NULL,
    "kind" "GeneratedVideoFileKind" NOT NULL,
    "storage_key" VARCHAR(300) NOT NULL,
    "content_type" VARCHAR(100) NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generated_video_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "generated_videos_workspace_id_succeeded_at_idx" ON "generated_videos"("workspace_id", "succeeded_at" DESC);

-- CreateIndex
CREATE INDEX "generated_videos_status_expires_at_idx" ON "generated_videos"("status", "expires_at");

-- CreateIndex
CREATE INDEX "generated_videos_user_id_idx" ON "generated_videos"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "generated_video_files_storage_key_key" ON "generated_video_files"("storage_key");

-- CreateIndex
CREATE INDEX "generated_video_files_workspace_id_video_id_idx" ON "generated_video_files"("workspace_id", "video_id");

-- CreateIndex
CREATE INDEX "generated_video_files_video_id_idx" ON "generated_video_files"("video_id");

-- AddForeignKey
ALTER TABLE "generated_videos" ADD CONSTRAINT "generated_videos_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_videos" ADD CONSTRAINT "generated_videos_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_video_files" ADD CONSTRAINT "generated_video_files_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_video_files" ADD CONSTRAINT "generated_video_files_video_id_fkey" FOREIGN KEY ("video_id") REFERENCES "generated_videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Generated video retention rules Prisma cannot express ──

-- Expiry is always exactly 168 hours (7 × 24 h, independent of any time zone or DST)
-- after the database-side success timestamp. The application never sets either value:
-- succeeded_at defaults to now(), may not lie in the future, and never changes;
-- expires_at is recomputed here on every write.
CREATE FUNCTION "generated_videos_retention_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.succeeded_at > now() THEN
      RAISE EXCEPTION 'succeeded_at cannot be in the future' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.succeeded_at IS DISTINCT FROM OLD.succeeded_at THEN
    RAISE EXCEPTION 'succeeded_at of generated_videos cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.expires_at := NEW.succeeded_at + interval '168 hours';
  RETURN NEW;
END
$$;

CREATE TRIGGER "generated_videos_retention" BEFORE INSERT OR UPDATE ON "generated_videos"
  FOR EACH ROW EXECUTE FUNCTION "generated_videos_retention_trigger"();

-- Records never move to another workspace; a file belongs to its video's workspace
-- (Phase 3 trigger functions).
CREATE TRIGGER "generated_videos_workspace_immutable" BEFORE UPDATE ON "generated_videos"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
CREATE TRIGGER "generated_video_files_workspace_immutable" BEFORE UPDATE ON "generated_video_files"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
CREATE TRIGGER "generated_video_files_same_workspace" BEFORE INSERT OR UPDATE ON "generated_video_files"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"('video_id', 'generated_videos');

-- A file's object key lives under its own workspace's storage prefix.
ALTER TABLE "generated_video_files" ADD CONSTRAINT "generated_video_files_key_prefix_check"
  CHECK (left("storage_key", 48) = 'workspaces/' || "workspace_id"::text || '/');

-- A file's identity never changes after it is recorded, and a deleted file stays deleted.
CREATE FUNCTION "generated_video_files_immutable_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.video_id IS DISTINCT FROM OLD.video_id
     OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at) THEN
    RAISE EXCEPTION 'generated_video_files rows are immutable except for deleted_at (set once)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "generated_video_files_immutable" BEFORE UPDATE ON "generated_video_files"
  FOR EACH ROW EXECUTE FUNCTION "generated_video_files_immutable_trigger"();

-- DELETED exactly when every file is gone; metrics are non-negative.
ALTER TABLE "generated_videos" ADD CONSTRAINT "generated_videos_deleted_check"
  CHECK (("status" = 'DELETED') = ("files_deleted_at" IS NOT NULL));
ALTER TABLE "generated_videos" ADD CONSTRAINT "generated_videos_metrics_check"
  CHECK (
    "duration_seconds" > 0 AND "width" > 0 AND "height" > 0
    AND "deletion_attempts" >= 0
    AND ("cost_micros" IS NULL OR "cost_micros" >= 0)
  );
ALTER TABLE "generated_video_files" ADD CONSTRAINT "generated_video_files_size_check"
  CHECK ("byte_size" >= 0);
