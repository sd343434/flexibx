-- AI Creator Studio (Pass 8): content projects, uploaded sources, leased processing jobs
-- and their steps, transcripts and translations, clips, rendered exports and the event log.

-- CreateEnum
CREATE TYPE "creator_project_status" AS ENUM ('DRAFT', 'UPLOADING', 'READY', 'PROCESSING', 'NEEDS_REVIEW', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "creator_source_status" AS ENUM ('PENDING_UPLOAD', 'UPLOADED', 'VERIFIED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "creator_job_kind" AS ENUM ('ANALYZE', 'TRANSCRIBE', 'TRANSLATE', 'EXPORT');

-- CreateEnum
CREATE TYPE "creator_job_state" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "creator_step_state" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "creator_transcript_kind" AS ENUM ('ORIGINAL', 'TRANSLATION');

-- CreateEnum
CREATE TYPE "creator_clip_status" AS ENUM ('SUGGESTED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "creator_aspect_ratio" AS ENUM ('PORTRAIT_9_16', 'LANDSCAPE_16_9', 'SQUARE_1_1');

-- CreateEnum
CREATE TYPE "creator_export_status" AS ENUM ('QUEUED', 'RENDERING', 'READY', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "creator_projects" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" VARCHAR(2000),
    "status" "creator_project_status" NOT NULL DEFAULT 'DRAFT',
    "created_by_user_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_sources" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "status" "creator_source_status" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "storage_provider" "StorageProvider" NOT NULL,
    "storage_key" VARCHAR(300) NOT NULL,
    "original_name" VARCHAR(200) NOT NULL,
    "declared_content_type" VARCHAR(100) NOT NULL,
    "declared_bytes" INTEGER NOT NULL,
    "upload_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "uploaded_at" TIMESTAMPTZ(3),
    "verified_at" TIMESTAMPTZ(3),
    "container" VARCHAR(20),
    "byte_size" INTEGER,
    "sha256" VARCHAR(64),
    "duration_ms" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "fps_milli" INTEGER,
    "has_audio" BOOLEAN,
    "has_video" BOOLEAN,
    "video_codec" VARCHAR(40),
    "audio_codec" VARCHAR(40),
    "rejection_code" VARCHAR(60),
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "export_id" UUID,
    "kind" "creator_job_kind" NOT NULL,
    "state" "creator_job_state" NOT NULL DEFAULT 'QUEUED',
    "stage" VARCHAR(40),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "lease_token" UUID,
    "lease_expires_at" TIMESTAMPTZ(3),
    "run_after" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadline_at" TIMESTAMPTZ(3) NOT NULL,
    "failure_code" VARCHAR(60),
    "options" JSONB NOT NULL DEFAULT '{}',
    "idempotency_key" VARCHAR(120) NOT NULL,
    "requested_by_user_id" UUID,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_job_steps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "stage" VARCHAR(40) NOT NULL,
    "position" INTEGER NOT NULL,
    "state" "creator_step_state" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "hold_id" UUID,
    "provider" VARCHAR(40),
    "model" VARCHAR(120),
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "output" JSONB NOT NULL DEFAULT '{}',
    "error_code" VARCHAR(60),
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_job_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_transcripts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "job_id" UUID,
    "kind" "creator_transcript_kind" NOT NULL,
    "language" VARCHAR(16) NOT NULL,
    "translated_from_id" UUID,
    "provider" VARCHAR(40) NOT NULL,
    "model" VARCHAR(120),
    "simulated" BOOLEAN NOT NULL,
    "segment_count" INTEGER NOT NULL,
    "edited_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_transcripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_transcript_segments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "transcript_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "text" VARCHAR(2000) NOT NULL,
    "edited" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_transcript_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_clips" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "transcript_id" UUID,
    "title" VARCHAR(200) NOT NULL,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "suggested_start_ms" INTEGER,
    "suggested_end_ms" INTEGER,
    "text" VARCHAR(4000) NOT NULL,
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "score" INTEGER NOT NULL DEFAULT 0,
    "status" "creator_clip_status" NOT NULL DEFAULT 'SUGGESTED',
    "origin" VARCHAR(20) NOT NULL,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "crop_x" INTEGER NOT NULL DEFAULT 50,
    "version" INTEGER NOT NULL DEFAULT 1,
    "reviewed_by_user_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_clips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_exports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "clip_id" UUID NOT NULL,
    "status" "creator_export_status" NOT NULL DEFAULT 'QUEUED',
    "aspect_ratio" "creator_aspect_ratio" NOT NULL,
    "burn_subtitles" BOOLEAN NOT NULL DEFAULT false,
    "subtitle_transcript_id" UUID,
    "format" VARCHAR(10) NOT NULL DEFAULT 'mp4',
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "crop_x" INTEGER NOT NULL,
    "storage_provider" "StorageProvider",
    "storage_key" VARCHAR(300),
    "byte_size" INTEGER,
    "sha256" VARCHAR(64),
    "duration_ms" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "failure_code" VARCHAR(60),
    "requested_by_user_id" UUID,
    "ready_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_exports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_project_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "type" VARCHAR(60) NOT NULL,
    "actor_user_id" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_project_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "creator_projects_workspace_id_updated_at_idx" ON "creator_projects"("workspace_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "creator_projects_created_by_user_id_idx" ON "creator_projects"("created_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "creator_sources_storage_key_key" ON "creator_sources"("storage_key");

-- CreateIndex
CREATE INDEX "creator_sources_workspace_id_project_id_created_at_idx" ON "creator_sources"("workspace_id", "project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "creator_sources_status_upload_expires_at_idx" ON "creator_sources"("status", "upload_expires_at");

-- CreateIndex
CREATE INDEX "creator_sources_created_by_user_id_idx" ON "creator_sources"("created_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "creator_jobs_export_id_key" ON "creator_jobs"("export_id");

-- CreateIndex
CREATE INDEX "creator_jobs_state_run_after_idx" ON "creator_jobs"("state", "run_after");

-- CreateIndex
CREATE INDEX "creator_jobs_state_lease_expires_at_idx" ON "creator_jobs"("state", "lease_expires_at");

-- CreateIndex
CREATE INDEX "creator_jobs_workspace_id_project_id_created_at_idx" ON "creator_jobs"("workspace_id", "project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "creator_jobs_source_id_idx" ON "creator_jobs"("source_id");

-- CreateIndex
CREATE INDEX "creator_jobs_requested_by_user_id_idx" ON "creator_jobs"("requested_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "creator_jobs_workspace_id_idempotency_key_key" ON "creator_jobs"("workspace_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "creator_job_steps_workspace_id_job_id_idx" ON "creator_job_steps"("workspace_id", "job_id");

-- CreateIndex
CREATE UNIQUE INDEX "creator_job_steps_job_id_stage_key" ON "creator_job_steps"("job_id", "stage");

-- CreateIndex
CREATE INDEX "creator_transcripts_workspace_id_project_id_idx" ON "creator_transcripts"("workspace_id", "project_id");

-- CreateIndex
CREATE INDEX "creator_transcripts_source_id_idx" ON "creator_transcripts"("source_id");

-- CreateIndex
CREATE UNIQUE INDEX "creator_transcripts_job_id_key" ON "creator_transcripts"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "creator_transcripts_translated_from_id_language_key" ON "creator_transcripts"("translated_from_id", "language");

-- CreateIndex
CREATE INDEX "creator_transcript_segments_workspace_id_idx" ON "creator_transcript_segments"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "creator_transcript_segments_transcript_id_position_key" ON "creator_transcript_segments"("transcript_id", "position");

-- CreateIndex
CREATE INDEX "creator_clips_workspace_id_project_id_start_ms_idx" ON "creator_clips"("workspace_id", "project_id", "start_ms");

-- CreateIndex
CREATE INDEX "creator_clips_source_id_idx" ON "creator_clips"("source_id");

-- CreateIndex
CREATE INDEX "creator_clips_reviewed_by_user_id_idx" ON "creator_clips"("reviewed_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "creator_exports_storage_key_key" ON "creator_exports"("storage_key");

-- CreateIndex
CREATE INDEX "creator_exports_workspace_id_project_id_created_at_idx" ON "creator_exports"("workspace_id", "project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "creator_exports_clip_id_idx" ON "creator_exports"("clip_id");

-- CreateIndex
CREATE INDEX "creator_exports_requested_by_user_id_idx" ON "creator_exports"("requested_by_user_id");

-- CreateIndex
CREATE INDEX "creator_project_events_workspace_id_project_id_created_at_idx" ON "creator_project_events"("workspace_id", "project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "creator_project_events_actor_user_id_idx" ON "creator_project_events"("actor_user_id");

-- AddForeignKey
ALTER TABLE "creator_projects" ADD CONSTRAINT "creator_projects_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_projects" ADD CONSTRAINT "creator_projects_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_sources" ADD CONSTRAINT "creator_sources_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_sources" ADD CONSTRAINT "creator_sources_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "creator_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_sources" ADD CONSTRAINT "creator_sources_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_jobs" ADD CONSTRAINT "creator_jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_jobs" ADD CONSTRAINT "creator_jobs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "creator_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_jobs" ADD CONSTRAINT "creator_jobs_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "creator_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_jobs" ADD CONSTRAINT "creator_jobs_export_id_fkey" FOREIGN KEY ("export_id") REFERENCES "creator_exports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_jobs" ADD CONSTRAINT "creator_jobs_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_job_steps" ADD CONSTRAINT "creator_job_steps_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_job_steps" ADD CONSTRAINT "creator_job_steps_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "creator_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_transcripts" ADD CONSTRAINT "creator_transcripts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_transcripts" ADD CONSTRAINT "creator_transcripts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "creator_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_transcripts" ADD CONSTRAINT "creator_transcripts_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "creator_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_transcripts" ADD CONSTRAINT "creator_transcripts_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "creator_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_transcripts" ADD CONSTRAINT "creator_transcripts_translated_from_id_fkey" FOREIGN KEY ("translated_from_id") REFERENCES "creator_transcripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_transcript_segments" ADD CONSTRAINT "creator_transcript_segments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_transcript_segments" ADD CONSTRAINT "creator_transcript_segments_transcript_id_fkey" FOREIGN KEY ("transcript_id") REFERENCES "creator_transcripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_clips" ADD CONSTRAINT "creator_clips_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_clips" ADD CONSTRAINT "creator_clips_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "creator_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_clips" ADD CONSTRAINT "creator_clips_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "creator_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_clips" ADD CONSTRAINT "creator_clips_transcript_id_fkey" FOREIGN KEY ("transcript_id") REFERENCES "creator_transcripts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_clips" ADD CONSTRAINT "creator_clips_reviewed_by_user_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_exports" ADD CONSTRAINT "creator_exports_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_exports" ADD CONSTRAINT "creator_exports_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "creator_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_exports" ADD CONSTRAINT "creator_exports_clip_id_fkey" FOREIGN KEY ("clip_id") REFERENCES "creator_clips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_exports" ADD CONSTRAINT "creator_exports_subtitle_transcript_id_fkey" FOREIGN KEY ("subtitle_transcript_id") REFERENCES "creator_transcripts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_exports" ADD CONSTRAINT "creator_exports_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_project_events" ADD CONSTRAINT "creator_project_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_project_events" ADD CONSTRAINT "creator_project_events_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "creator_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_project_events" ADD CONSTRAINT "creator_project_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── Rules the application relies on (also enforced here) ─────────────────────

ALTER TABLE "creator_projects" ADD CONSTRAINT "creator_projects_check"
  CHECK (length(btrim("name")) > 0 AND "version" >= 1);

-- Keys are server-generated under the row's own workspace and category.
ALTER TABLE "creator_sources" ADD CONSTRAINT "creator_sources_check"
  CHECK ("declared_bytes" > 0
     AND "storage_key" LIKE 'workspaces/' || "workspace_id"::text || '/creator-sources/%'
     AND ("byte_size" IS NULL OR "byte_size" > 0)
     AND ("duration_ms" IS NULL OR "duration_ms" > 0)
     AND ("width" IS NULL OR "width" > 0) AND ("height" IS NULL OR "height" > 0)
     AND ("fps_milli" IS NULL OR "fps_milli" > 0)
     AND ("status" <> 'VERIFIED' OR ("verified_at" IS NOT NULL AND "byte_size" IS NOT NULL
          AND "sha256" IS NOT NULL AND "duration_ms" IS NOT NULL AND "container" IS NOT NULL))
     AND ("status" <> 'REJECTED' OR "rejection_code" IS NOT NULL));

ALTER TABLE "creator_jobs" ADD CONSTRAINT "creator_jobs_check"
  CHECK ("attempts" >= 0 AND "max_attempts" BETWEEN 1 AND 10
     AND (("kind" = 'EXPORT') = ("export_id" IS NOT NULL))
     AND (("state" IN ('QUEUED', 'RUNNING')) = ("finished_at" IS NULL))
     AND ("state" <> 'FAILED' OR "failure_code" IS NOT NULL)
     AND (("lease_token" IS NULL) = ("lease_expires_at" IS NULL))
     AND ("state" = 'RUNNING' OR "lease_token" IS NULL));
-- One active job of a kind per source (and per target language for translations): a
-- double click or a retried request never starts the same work twice.
CREATE UNIQUE INDEX "creator_jobs_one_active" ON "creator_jobs"
  ("source_id", "kind", (COALESCE("options" ->> 'targetLanguage', '')))
  WHERE "state" IN ('QUEUED', 'RUNNING') AND "kind" <> 'EXPORT';

ALTER TABLE "creator_job_steps" ADD CONSTRAINT "creator_job_steps_check"
  CHECK ("attempts" >= 0 AND "position" >= 0
     AND ("state" <> 'FAILED' OR "error_code" IS NOT NULL)
     AND ("state" <> 'SUCCEEDED' OR "finished_at" IS NOT NULL));

ALTER TABLE "creator_transcripts" ADD CONSTRAINT "creator_transcripts_check"
  CHECK ("segment_count" >= 0
     AND (("kind" = 'TRANSLATION') = ("translated_from_id" IS NOT NULL))
     AND length(btrim("language")) > 0);

ALTER TABLE "creator_transcript_segments" ADD CONSTRAINT "creator_transcript_segments_check"
  CHECK ("position" >= 0 AND "start_ms" >= 0 AND "end_ms" > "start_ms");

ALTER TABLE "creator_clips" ADD CONSTRAINT "creator_clips_check"
  CHECK ("start_ms" >= 0 AND "end_ms" > "start_ms"
     AND "end_ms" - "start_ms" BETWEEN 1000 AND 600000
     AND "score" BETWEEN 0 AND 100 AND "crop_x" BETWEEN 0 AND 100 AND "version" >= 1
     AND "origin" IN ('SUGGESTED', 'MANUAL')
     AND ("status" = 'SUGGESTED' OR "reviewed_at" IS NOT NULL));

ALTER TABLE "creator_exports" ADD CONSTRAINT "creator_exports_check"
  CHECK ("end_ms" > "start_ms" AND "end_ms" - "start_ms" BETWEEN 1000 AND 600000
     AND "crop_x" BETWEEN 0 AND 100 AND "format" = 'mp4'
     AND ("burn_subtitles" = false OR "subtitle_transcript_id" IS NOT NULL)
     AND ("storage_key" IS NULL
          OR "storage_key" LIKE 'workspaces/' || "workspace_id"::text || '/creator-exports/%')
     AND ("status" <> 'READY' OR ("storage_key" IS NOT NULL AND "storage_provider" IS NOT NULL
          AND "byte_size" > 0 AND "sha256" IS NOT NULL AND "duration_ms" > 0
          AND "width" > 0 AND "height" > 0 AND "ready_at" IS NOT NULL))
     AND ("status" <> 'FAILED' OR "failure_code" IS NOT NULL));

-- ── Workspace isolation: every reference stays in the row's workspace ─────────

CREATE TRIGGER "creator_projects_workspace_immutable" BEFORE UPDATE ON "creator_projects"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
CREATE TRIGGER "creator_sources_same_workspace" BEFORE INSERT OR UPDATE ON "creator_sources"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"('project_id', 'creator_projects');
CREATE TRIGGER "creator_sources_workspace_immutable" BEFORE UPDATE ON "creator_sources"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
CREATE TRIGGER "creator_jobs_same_workspace" BEFORE INSERT OR UPDATE ON "creator_jobs"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"(
    'project_id', 'creator_projects', 'source_id', 'creator_sources', 'export_id', 'creator_exports');
CREATE TRIGGER "creator_jobs_workspace_immutable" BEFORE UPDATE ON "creator_jobs"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
CREATE TRIGGER "creator_job_steps_same_workspace" BEFORE INSERT OR UPDATE ON "creator_job_steps"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"(
    'job_id', 'creator_jobs', 'hold_id', 'credit_holds');
CREATE TRIGGER "creator_job_steps_workspace_immutable" BEFORE UPDATE ON "creator_job_steps"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
CREATE TRIGGER "creator_transcripts_same_workspace" BEFORE INSERT OR UPDATE ON "creator_transcripts"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"(
    'project_id', 'creator_projects', 'source_id', 'creator_sources', 'job_id', 'creator_jobs',
    'translated_from_id', 'creator_transcripts');
CREATE TRIGGER "creator_transcripts_workspace_immutable" BEFORE UPDATE ON "creator_transcripts"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
CREATE TRIGGER "creator_transcript_segments_same_workspace" BEFORE INSERT OR UPDATE ON "creator_transcript_segments"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"('transcript_id', 'creator_transcripts');
CREATE TRIGGER "creator_transcript_segments_workspace_immutable" BEFORE UPDATE ON "creator_transcript_segments"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
CREATE TRIGGER "creator_clips_same_workspace" BEFORE INSERT OR UPDATE ON "creator_clips"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"(
    'project_id', 'creator_projects', 'source_id', 'creator_sources',
    'transcript_id', 'creator_transcripts');
CREATE TRIGGER "creator_clips_workspace_immutable" BEFORE UPDATE ON "creator_clips"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
CREATE TRIGGER "creator_exports_same_workspace" BEFORE INSERT OR UPDATE ON "creator_exports"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"(
    'project_id', 'creator_projects', 'clip_id', 'creator_clips',
    'subtitle_transcript_id', 'creator_transcripts');
CREATE TRIGGER "creator_exports_workspace_immutable" BEFORE UPDATE ON "creator_exports"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
CREATE TRIGGER "creator_project_events_same_workspace" BEFORE INSERT ON "creator_project_events"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"('project_id', 'creator_projects');

-- ── Project consistency: what a row points at belongs to the row's project ────

CREATE FUNCTION "creator_same_project_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  i integer := 0;
  row_data jsonb := to_jsonb(NEW);
  ref uuid;
  owner uuid;
BEGIN
  WHILE i < TG_NARGS LOOP
    ref := (row_data ->> TG_ARGV[i])::uuid;
    IF ref IS NOT NULL THEN
      EXECUTE format('SELECT project_id FROM %I WHERE id = $1', TG_ARGV[i + 1])
        INTO owner USING ref;
      IF owner IS DISTINCT FROM NEW.project_id THEN
        RAISE EXCEPTION '% of % belongs to another project', TG_ARGV[i], TG_TABLE_NAME
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    i := i + 2;
  END LOOP;
  RETURN NEW;
END
$$;
CREATE TRIGGER "creator_jobs_same_project" BEFORE INSERT OR UPDATE ON "creator_jobs"
  FOR EACH ROW EXECUTE FUNCTION "creator_same_project_trigger"(
    'source_id', 'creator_sources', 'export_id', 'creator_exports');
CREATE TRIGGER "creator_transcripts_same_project" BEFORE INSERT OR UPDATE ON "creator_transcripts"
  FOR EACH ROW EXECUTE FUNCTION "creator_same_project_trigger"(
    'source_id', 'creator_sources', 'job_id', 'creator_jobs',
    'translated_from_id', 'creator_transcripts');
CREATE TRIGGER "creator_clips_same_project" BEFORE INSERT OR UPDATE ON "creator_clips"
  FOR EACH ROW EXECUTE FUNCTION "creator_same_project_trigger"(
    'source_id', 'creator_sources', 'transcript_id', 'creator_transcripts');
CREATE TRIGGER "creator_exports_same_project" BEFORE INSERT OR UPDATE ON "creator_exports"
  FOR EACH ROW EXECUTE FUNCTION "creator_same_project_trigger"(
    'clip_id', 'creator_clips', 'subtitle_transcript_id', 'creator_transcripts');

-- ── The event log is history ──────────────────────────────────────────────────

CREATE FUNCTION "creator_project_events_append_only_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'creator_project_events is append-only' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER "creator_project_events_append_only" BEFORE UPDATE ON "creator_project_events"
  FOR EACH ROW EXECUTE FUNCTION "creator_project_events_append_only_trigger"();
