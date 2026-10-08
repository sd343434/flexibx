-- CreateTable
CREATE TABLE "rate_limits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "last_request" BIGINT NOT NULL,

    CONSTRAINT "rate_limits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rate_limits_key_key" ON "rate_limits"("key");

-- CreateIndex
CREATE INDEX "rate_limits_last_request_idx" ON "rate_limits"("last_request");

-- A counter is never negative.
ALTER TABLE "rate_limits" ADD CONSTRAINT "rate_limits_count_check" CHECK ("count" >= 0);
