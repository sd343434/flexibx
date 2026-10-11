-- CreateEnum
CREATE TYPE "video_job_state" AS ENUM ('RESERVED', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'ACCEPTED', 'REJECTED', 'FAILED', 'LIMIT_REACHED', 'NEEDS_RECONCILIATION', 'CANCELLED');

-- CreateEnum
CREATE TYPE "video_attempt_state" AS ENUM ('INTENDED', 'SUBMITTED', 'OUTPUT_READY', 'VALIDATED', 'FAILED_RETRYABLE', 'FAILED_PERMANENT', 'REFUSED_BY_PROVIDER', 'TIMED_OUT', 'OUTCOME_UNKNOWN', 'CANCELLED');

-- CreateEnum
CREATE TYPE "usage_ledger_kind" AS ENUM ('RESERVE', 'CAPTURE', 'RELEASE');

-- CreateTable
CREATE TABLE "video_generation_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "user_id" UUID,
    "title" VARCHAR(200) NOT NULL,
    "prompt" VARCHAR(2000) NOT NULL,
    "duration_seconds" INTEGER NOT NULL,
    "aspect_ratio" VARCHAR(5) NOT NULL,
    "resolution" VARCHAR(5) NOT NULL,
    "audio" BOOLEAN NOT NULL,
    "tier" VARCHAR(16) NOT NULL,
    "state" "video_job_state" NOT NULL DEFAULT 'RESERVED',
    "max_attempts" INTEGER NOT NULL DEFAULT 2,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "provider" VARCHAR(40) NOT NULL,
    "model" VARCHAR(100) NOT NULL,
    "rate_card_version" VARCHAR(40) NOT NULL,
    "reserved_micros" BIGINT NOT NULL,
    "captured_micros" BIGINT NOT NULL DEFAULT 0,
    "released_micros" BIGINT NOT NULL DEFAULT 0,
    "failure_code" VARCHAR(40),
    "generated_video_id" UUID,
    "deadline_at" TIMESTAMPTZ(3) NOT NULL,
    "lease_token" UUID,
    "lease_expires_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_generation_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_generation_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "idempotency_key" VARCHAR(64) NOT NULL,
    "state" "video_attempt_state" NOT NULL DEFAULT 'INTENDED',
    "provider" VARCHAR(40) NOT NULL,
    "model" VARCHAR(100) NOT NULL,
    "provider_job_id" VARCHAR(200),
    "failure_code" VARCHAR(40),
    "billed_seconds" INTEGER,
    "cost_micros" BIGINT,
    "cost_estimated" BOOLEAN NOT NULL DEFAULT false,
    "output_sha256" CHAR(64),
    "output_bytes" INTEGER,
    "submitted_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_generation_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_ledger_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "category" VARCHAR(40) NOT NULL,
    "period" DATE NOT NULL,
    "kind" "usage_ledger_kind" NOT NULL,
    "amount_micros" BIGINT NOT NULL,
    "estimated" BOOLEAN NOT NULL DEFAULT false,
    "rate_card_version" VARCHAR(40) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "video_generation_jobs_generated_video_id_key" ON "video_generation_jobs"("generated_video_id");

-- CreateIndex
CREATE INDEX "video_generation_jobs_workspace_id_created_at_idx" ON "video_generation_jobs"("workspace_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "video_generation_jobs_workspace_id_state_created_at_idx" ON "video_generation_jobs"("workspace_id", "state", "created_at");

-- CreateIndex
CREATE INDEX "video_generation_jobs_state_updated_at_idx" ON "video_generation_jobs"("state", "updated_at");

-- CreateIndex
CREATE INDEX "video_generation_jobs_user_id_idx" ON "video_generation_jobs"("user_id");

-- CreateIndex
CREATE INDEX "video_generation_attempts_workspace_id_job_id_idx" ON "video_generation_attempts"("workspace_id", "job_id");

-- CreateIndex
CREATE INDEX "video_generation_attempts_provider_provider_job_id_idx" ON "video_generation_attempts"("provider", "provider_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "video_generation_attempts_job_id_attempt_no_key" ON "video_generation_attempts"("job_id", "attempt_no");

-- CreateIndex
CREATE UNIQUE INDEX "video_generation_attempts_workspace_id_idempotency_key_key" ON "video_generation_attempts"("workspace_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "usage_ledger_entries_workspace_id_period_category_idx" ON "usage_ledger_entries"("workspace_id", "period", "category");

-- CreateIndex
CREATE INDEX "usage_ledger_entries_job_id_idx" ON "usage_ledger_entries"("job_id");

-- AddForeignKey
ALTER TABLE "video_generation_jobs" ADD CONSTRAINT "video_generation_jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_generation_jobs" ADD CONSTRAINT "video_generation_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_generation_jobs" ADD CONSTRAINT "video_generation_jobs_generated_video_id_fkey" FOREIGN KEY ("generated_video_id") REFERENCES "generated_videos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_generation_attempts" ADD CONSTRAINT "video_generation_attempts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_generation_attempts" ADD CONSTRAINT "video_generation_attempts_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "video_generation_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_ledger_entries" ADD CONSTRAINT "usage_ledger_entries_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_ledger_entries" ADD CONSTRAINT "usage_ledger_entries_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "video_generation_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Generative video core rules Prisma cannot express ──

-- Every reference stays inside the row's own workspace, and rows never move to another
-- workspace (Phase 3 trigger functions).
CREATE TRIGGER "video_generation_jobs_same_workspace" BEFORE INSERT OR UPDATE ON "video_generation_jobs"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"('generated_video_id', 'generated_videos');
CREATE TRIGGER "video_generation_jobs_workspace_immutable" BEFORE UPDATE ON "video_generation_jobs"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
CREATE TRIGGER "video_generation_attempts_same_workspace" BEFORE INSERT OR UPDATE ON "video_generation_attempts"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"('job_id', 'video_generation_jobs');
CREATE TRIGGER "video_generation_attempts_workspace_immutable" BEFORE UPDATE ON "video_generation_attempts"
  FOR EACH ROW EXECUTE FUNCTION "marketing_workspace_immutable_trigger"();
CREATE TRIGGER "usage_ledger_entries_same_workspace" BEFORE INSERT ON "usage_ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "marketing_same_workspace_trigger"('job_id', 'video_generation_jobs');

-- Request shape (the service validates first; these are the last line of defence).
ALTER TABLE "video_generation_jobs" ADD CONSTRAINT "video_generation_jobs_request_check" CHECK (
  "duration_seconds" BETWEEN 1 AND 60
  AND "aspect_ratio" IN ('16:9', '9:16')
  AND "resolution" IN ('720p', '1080p')
  AND "tier" IN ('DRAFT', 'STANDARD')
  AND char_length(btrim("prompt")) > 0);
-- Attempt bound, and money: captured + released never exceed the reservation.
ALTER TABLE "video_generation_jobs" ADD CONSTRAINT "video_generation_jobs_bounds_check" CHECK (
  "max_attempts" BETWEEN 1 AND 5
  AND "attempt_count" BETWEEN 0 AND "max_attempts"
  AND "reserved_micros" > 0
  AND "captured_micros" >= 0
  AND "released_micros" >= 0
  AND "captured_micros" + "released_micros" <= "reserved_micros");
-- Failed outcomes carry a reason; others do not.
ALTER TABLE "video_generation_jobs" ADD CONSTRAINT "video_generation_jobs_failure_check" CHECK (
  ("state" IN ('FAILED', 'LIMIT_REACHED', 'NEEDS_RECONCILIATION')) = ("failure_code" IS NOT NULL));

ALTER TABLE "video_generation_attempts" ADD CONSTRAINT "video_generation_attempts_check" CHECK (
  "attempt_no" >= 1
  AND ("state" NOT IN ('SUBMITTED', 'OUTPUT_READY', 'VALIDATED') OR "provider_job_id" IS NOT NULL)
  AND (("state" IN ('FAILED_RETRYABLE', 'FAILED_PERMANENT', 'REFUSED_BY_PROVIDER', 'TIMED_OUT',
        'OUTCOME_UNKNOWN')) = ("failure_code" IS NOT NULL))
  AND ("state" <> 'VALIDATED' OR ("output_sha256" IS NOT NULL AND "output_bytes" > 0))
  AND ("cost_micros" IS NULL OR "cost_micros" >= 0)
  AND ("billed_seconds" IS NULL OR "billed_seconds" >= 0));

ALTER TABLE "usage_ledger_entries" ADD CONSTRAINT "usage_ledger_entries_amount_check"
  CHECK ("amount_micros" > 0);

-- Legal state transitions (mirrors src/server/videos/generation/states.ts). Staying in
-- the same state is always allowed (e.g. counting attempts).
CREATE FUNCTION "video_job_transition_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = OLD.state THEN RETURN NEW; END IF;
  IF (OLD.state, NEW.state) IN (
    ('RESERVED', 'IN_PROGRESS'), ('RESERVED', 'FAILED'), ('RESERVED', 'CANCELLED'),
    ('IN_PROGRESS', 'READY_FOR_REVIEW'), ('IN_PROGRESS', 'FAILED'),
    ('IN_PROGRESS', 'LIMIT_REACHED'), ('IN_PROGRESS', 'NEEDS_RECONCILIATION'),
    ('IN_PROGRESS', 'CANCELLED'),
    ('NEEDS_RECONCILIATION', 'IN_PROGRESS'), ('NEEDS_RECONCILIATION', 'FAILED'),
    ('READY_FOR_REVIEW', 'ACCEPTED'), ('READY_FOR_REVIEW', 'REJECTED')
  ) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'illegal video job transition % -> %', OLD.state, NEW.state
    USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER "video_generation_jobs_transition" BEFORE UPDATE ON "video_generation_jobs"
  FOR EACH ROW EXECUTE FUNCTION "video_job_transition_trigger"();

CREATE FUNCTION "video_attempt_transition_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provider_job_id IS DISTINCT FROM OLD.provider_job_id AND OLD.provider_job_id IS NOT NULL THEN
    RAISE EXCEPTION 'provider_job_id of an attempt is set once' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state = OLD.state THEN RETURN NEW; END IF;
  IF (OLD.state, NEW.state) IN (
    ('INTENDED', 'SUBMITTED'), ('INTENDED', 'FAILED_RETRYABLE'), ('INTENDED', 'FAILED_PERMANENT'),
    ('INTENDED', 'OUTCOME_UNKNOWN'), ('INTENDED', 'CANCELLED'),
    ('OUTCOME_UNKNOWN', 'SUBMITTED'), ('OUTCOME_UNKNOWN', 'FAILED_RETRYABLE'),
    ('SUBMITTED', 'OUTPUT_READY'), ('SUBMITTED', 'FAILED_RETRYABLE'),
    ('SUBMITTED', 'FAILED_PERMANENT'), ('SUBMITTED', 'REFUSED_BY_PROVIDER'),
    ('SUBMITTED', 'TIMED_OUT'), ('SUBMITTED', 'CANCELLED'),
    ('OUTPUT_READY', 'VALIDATED'), ('OUTPUT_READY', 'FAILED_RETRYABLE'),
    ('OUTPUT_READY', 'TIMED_OUT')
  ) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'illegal video attempt transition % -> %', OLD.state, NEW.state
    USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER "video_generation_attempts_transition" BEFORE UPDATE ON "video_generation_attempts"
  FOR EACH ROW EXECUTE FUNCTION "video_attempt_transition_trigger"();

-- The ledger is append-only: entries are never changed (workspace deletion still
-- cascades; the tenant guard also refuses application deletes).
CREATE FUNCTION "usage_ledger_append_only_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'usage_ledger_entries is append-only' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER "usage_ledger_entries_append_only" BEFORE UPDATE ON "usage_ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "usage_ledger_append_only_trigger"();
