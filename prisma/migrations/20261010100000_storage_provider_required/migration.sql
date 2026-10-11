-- Storage provider hardening (follows 20261010090000_storage_providers, whose column
-- defaults backfilled every existing row to LEGACY_S3; that backfill is kept as is).
--
-- 1. No default any more: a new object row must state the provider it was written to.
--    An insert that omits it fails (NOT NULL) instead of silently claiming LEGACY_S3 —
--    a mislabelled row would send reads and deletes to a store that does not hold the
--    object, and a delete of a missing key "succeeds", hiding the error.
ALTER TABLE "media_assets" ALTER COLUMN "storage_provider" DROP DEFAULT;
ALTER TABLE "generated_video_files" ALTER COLUMN "storage_provider" DROP DEFAULT;

-- 2. Optimistic concurrency for the platform storage settings: every change increments
--    the version, and a change decided on an older version is refused.
ALTER TABLE "platform_storage_settings" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "platform_storage_settings" ADD CONSTRAINT "platform_storage_settings_version_check"
  CHECK ("version" >= 0);
