-- Operational monitoring: last run of each scheduled job (heartbeats) and cross-process
-- alert throttling. Additive; both tables hold job names, timestamps and counts only.
-- CreateTable
CREATE TABLE "system_heartbeats" (
    "name" VARCHAR(80) NOT NULL,
    "last_started_at" TIMESTAMPTZ(3),
    "last_finished_at" TIMESTAMPTZ(3),
    "last_succeeded_at" TIMESTAMPTZ(3),
    "last_status" VARCHAR(20),
    "failed_phases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_heartbeats_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "alert_throttles" (
    "key" VARCHAR(120) NOT NULL,
    "last_sent_at" TIMESTAMPTZ(3) NOT NULL,
    "suppressed_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "alert_throttles_pkey" PRIMARY KEY ("key")
);

