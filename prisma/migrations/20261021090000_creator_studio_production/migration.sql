-- Pass 9: Creator Studio production capabilities — resumable multipart uploads with
-- per-part checksums, project deletion with a storage-deletion queue, and provider /
-- local processing cost accounting on job steps.

-- AlterEnum
ALTER TYPE "creator_project_status" ADD VALUE 'DELETING';

-- AlterTable
ALTER TABLE "creator_job_steps" ADD COLUMN     "local_processing_ms" INTEGER,
ADD COLUMN     "provider_audio_seconds" INTEGER,
ADD COLUMN     "provider_cost_micro_usd" INTEGER,
ADD COLUMN     "provider_input_tokens" INTEGER,
ADD COLUMN     "provider_output_tokens" INTEGER,
ADD COLUMN     "checkpoint" JSONB;

-- AlterTable
ALTER TABLE "creator_projects" ADD COLUMN     "deleted_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "creator_sources" ADD COLUMN     "declared_sha256" VARCHAR(64),
ADD COLUMN     "multipart_upload_id" VARCHAR(1024),
ADD COLUMN     "part_count" INTEGER,
ADD COLUMN     "part_size_bytes" INTEGER,
ADD COLUMN     "upload_mode" VARCHAR(20) NOT NULL DEFAULT 'single';

-- CreateTable
CREATE TABLE "creator_source_parts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "part_number" INTEGER NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "etag" VARCHAR(200),
    "uploaded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_source_parts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_storage_deletions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "reason" VARCHAR(40) NOT NULL,
    "storage_provider" "StorageProvider" NOT NULL,
    "storage_key" VARCHAR(300) NOT NULL,
    "multipart_upload_id" VARCHAR(1024),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" VARCHAR(60),
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_storage_deletions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "creator_source_parts_workspace_id_idx" ON "creator_source_parts"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "creator_source_parts_source_id_part_number_key" ON "creator_source_parts"("source_id", "part_number");

-- CreateIndex
CREATE UNIQUE INDEX "creator_storage_deletions_storage_key_key" ON "creator_storage_deletions"("storage_key");

-- CreateIndex
CREATE INDEX "creator_storage_deletions_completed_at_next_attempt_at_idx" ON "creator_storage_deletions"("completed_at", "next_attempt_at");

-- CreateIndex
CREATE INDEX "creator_storage_deletions_workspace_id_project_id_idx" ON "creator_storage_deletions"("workspace_id", "project_id");

-- AddForeignKey
ALTER TABLE "creator_source_parts" ADD CONSTRAINT "creator_source_parts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_source_parts" ADD CONSTRAINT "creator_source_parts_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "creator_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_storage_deletions" ADD CONSTRAINT "creator_storage_deletions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Rules the application relies on (also enforced here) ─────────────────────

ALTER TABLE "creator_sources" ADD CONSTRAINT "creator_sources_upload_check"
  CHECK ("upload_mode" IN ('single', 'multipart')
     AND ("declared_sha256" IS NULL OR "declared_sha256" ~ '^[0-9a-f]{64}$')
     AND ("upload_mode" = 'single'
          OR ("part_size_bytes" BETWEEN 5242880 AND 268435456
              AND "part_count" BETWEEN 1 AND 10000))
     AND ("multipart_upload_id" IS NULL OR "upload_mode" = 'multipart'));

ALTER TABLE "creator_source_parts" ADD CONSTRAINT "creator_source_parts_check"
  CHECK ("part_number" BETWEEN 1 AND 10000 AND "size_bytes" > 0
     AND "sha256" ~ '^[0-9a-f]{64}$'
     AND ("uploaded_at" IS NULL OR "etag" IS NOT NULL));

-- Only server-generated creator keys of the row's own workspace are ever queued.
ALTER TABLE "creator_storage_deletions" ADD CONSTRAINT "creator_storage_deletions_check"
  CHECK (("storage_key" LIKE 'workspaces/' || "workspace_id"::text || '/creator-sources/%'
          OR "storage_key" LIKE 'workspaces/' || "workspace_id"::text || '/creator-exports/%')
     AND "attempts" >= 0
     AND "reason" IN ('project_deleted', 'upload_expired', 'source_rejected', 'render_discarded'));

ALTER TABLE "creator_job_steps" ADD CONSTRAINT "creator_job_steps_costs_check"
  CHECK (("local_processing_ms" IS NULL OR "local_processing_ms" >= 0)
     AND ("provider_audio_seconds" IS NULL OR "provider_audio_seconds" >= 0)
     AND ("provider_input_tokens" IS NULL OR "provider_input_tokens" >= 0)
     AND ("provider_output_tokens" IS NULL OR "provider_output_tokens" >= 0)
     AND ("provider_cost_micro_usd" IS NULL OR "provider_cost_micro_usd" >= 0));

-- ── Tenant isolation (same functions as every workspace-owned table) ──────────

CREATE TRIGGER "creator_source_parts_same_workspace" BEFORE INSERT OR UPDATE ON "creator_source_parts"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"('source_id', 'creator_sources');
CREATE TRIGGER "creator_source_parts_workspace_immutable" BEFORE UPDATE ON "creator_source_parts"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
CREATE TRIGGER "creator_storage_deletions_workspace_immutable" BEFORE UPDATE ON "creator_storage_deletions"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();

-- A queued deletion's identity never changes: only its progress (attempts, error code,
-- next attempt, completion) is updated.
CREATE FUNCTION "creator_storage_deletions_identity_trigger"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."storage_key" IS DISTINCT FROM OLD."storage_key"
     OR NEW."storage_provider" IS DISTINCT FROM OLD."storage_provider"
     OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
     OR NEW."reason" IS DISTINCT FROM OLD."reason" THEN
    RAISE EXCEPTION 'creator_storage_deletions: identity columns are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."completed_at" IS NOT NULL AND NEW."completed_at" IS NULL THEN
    RAISE EXCEPTION 'creator_storage_deletions: a completed deletion cannot be reopened'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "creator_storage_deletions_identity" BEFORE UPDATE ON "creator_storage_deletions"
  FOR EACH ROW EXECUTE FUNCTION "creator_storage_deletions_identity_trigger"();

-- A project being deleted gets nothing new: no upload, job, transcript, clip or export.
-- The project row is read FOR SHARE, so an insert racing the deletion's transaction (which
-- holds the row FOR UPDATE) waits for it and then sees DELETING.
CREATE FUNCTION "creator_project_active_trigger"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_status text;
BEGIN
  SELECT "status"::text INTO current_status FROM "creator_projects"
    WHERE "id" = NEW."project_id" FOR SHARE;
  IF current_status = 'DELETING' THEN
    RAISE EXCEPTION 'creator project % is being deleted', NEW."project_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "creator_sources_project_active" BEFORE INSERT ON "creator_sources"
  FOR EACH ROW EXECUTE FUNCTION "creator_project_active_trigger"();
CREATE TRIGGER "creator_jobs_project_active" BEFORE INSERT ON "creator_jobs"
  FOR EACH ROW EXECUTE FUNCTION "creator_project_active_trigger"();
CREATE TRIGGER "creator_transcripts_project_active" BEFORE INSERT ON "creator_transcripts"
  FOR EACH ROW EXECUTE FUNCTION "creator_project_active_trigger"();
CREATE TRIGGER "creator_clips_project_active" BEFORE INSERT ON "creator_clips"
  FOR EACH ROW EXECUTE FUNCTION "creator_project_active_trigger"();
CREATE TRIGGER "creator_exports_project_active" BEFORE INSERT ON "creator_exports"
  FOR EACH ROW EXECUTE FUNCTION "creator_project_active_trigger"();
