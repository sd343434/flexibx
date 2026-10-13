-- Periodic consistency checks run by the scheduled tick (first: credit-ledger integrity).
-- Additive; holds check names, timestamps and violation counts only.
-- CreateTable
CREATE TABLE "ops_check_results" (
    "name" VARCHAR(80) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "counts" JSONB NOT NULL DEFAULT '{}',
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "duration_ms" INTEGER,
    "error_code" VARCHAR(40),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_check_results_pkey" PRIMARY KEY ("name")
);
