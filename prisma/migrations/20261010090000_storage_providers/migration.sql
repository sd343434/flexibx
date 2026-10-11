-- Object storage providers (platform admin): record where every stored object lives, and
-- keep platform-wide, non-secret storage settings. Backward compatible:
-- * every existing object row is backfilled to LEGACY_S3 — the S3-compatible store
--   configured by the S3_* environment variables, where all of them were written. No
--   existing object is ever assumed to be in Wasabi;
-- * the recorded provider cannot change in place (triggers below): reads and deletes
--   always go to the provider an object was written to. Moving objects between providers
--   needs a deliberate data migration (copy, verify, update, rollback plan).

CREATE TYPE "StorageProvider" AS ENUM ('LEGACY_S3', 'WASABI');

ALTER TABLE "media_assets"
  ADD COLUMN "storage_provider" "StorageProvider" NOT NULL DEFAULT 'LEGACY_S3';
ALTER TABLE "generated_video_files"
  ADD COLUMN "storage_provider" "StorageProvider" NOT NULL DEFAULT 'LEGACY_S3';

-- Generated video files: storage_provider joins the fields that never change.
CREATE OR REPLACE FUNCTION "generated_video_files_immutable_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.video_id IS DISTINCT FROM OLD.video_id
     OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
     OR NEW.storage_provider IS DISTINCT FROM OLD.storage_provider
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at) THEN
    RAISE EXCEPTION 'generated_video_files rows are immutable except for deleted_at (set once)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- Media assets: the stored object's key and provider never change in place.
CREATE FUNCTION "media_assets_storage_immutable_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.storage_key IS DISTINCT FROM OLD.storage_key
     OR NEW.storage_provider IS DISTINCT FROM OLD.storage_provider THEN
    RAISE EXCEPTION 'media_assets storage_key and storage_provider are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "media_assets_storage_immutable" BEFORE UPDATE ON "media_assets"
  FOR EACH ROW EXECUTE FUNCTION "media_assets_storage_immutable_trigger"();

-- Platform-wide storage settings: exactly one row (id = 1). Non-secret values only.
CREATE TABLE "platform_storage_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "write_provider" "StorageProvider" NOT NULL DEFAULT 'LEGACY_S3',
    "wasabi_region" VARCHAR(32),
    "wasabi_endpoint" VARCHAR(255),
    "wasabi_bucket" VARCHAR(63),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_storage_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_storage_settings_singleton_check" CHECK ("id" = 1),
    -- Wasabi can only be the write target once its settings are complete.
    CONSTRAINT "platform_storage_settings_wasabi_complete_check" CHECK (
      "write_provider" <> 'WASABI'
      OR ("wasabi_region" IS NOT NULL AND "wasabi_endpoint" IS NOT NULL AND "wasabi_bucket" IS NOT NULL)
    )
);
