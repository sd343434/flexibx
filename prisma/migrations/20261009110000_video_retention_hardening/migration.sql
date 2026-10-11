-- ── Generated video retention: hardening (review follow-up) ──

-- The success timestamp is the database clock at insert. statement_timestamp() is used
-- (not now()) because Prisma treats a now() default as its own @default(now()) and then
-- sends the application server's time; a dbgenerated default is omitted from INSERTs.
ALTER TABLE "generated_videos" ALTER COLUMN "succeeded_at" SET DEFAULT statement_timestamp();

-- Files may only be attached to a video that is still AVAILABLE. FOR SHARE makes the
-- retention job's claim (FOR UPDATE … SKIP LOCKED) wait for, or skip, an in-flight
-- insert, so a file can never appear after the job has listed a video's files.
CREATE FUNCTION "generated_video_files_insert_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM "generated_videos"
    WHERE "id" = NEW.video_id AND "status" = 'AVAILABLE'
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'files can only be added to an AVAILABLE generated video'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "generated_video_files_insert_guard" BEFORE INSERT ON "generated_video_files"
  FOR EACH ROW EXECUTE FUNCTION "generated_video_files_insert_trigger"();

-- A row whose stored objects have not been deleted can never be deleted itself — not
-- directly and not through ON DELETE CASCADE from a workspace hard delete. Otherwise the
-- objects would be orphaned in storage with no record left to delete them from.
-- (TRUNCATE, used only by the test-suite reset, does not fire row triggers.)
CREATE FUNCTION "generated_videos_delete_guard_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'DELETED' THEN
    RAISE EXCEPTION 'generated video % still has stored files; let the retention job delete them first', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER "generated_videos_delete_guard" BEFORE DELETE ON "generated_videos"
  FOR EACH ROW EXECUTE FUNCTION "generated_videos_delete_guard_trigger"();

CREATE FUNCTION "generated_video_files_delete_guard_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.deleted_at IS NULL THEN
    RAISE EXCEPTION 'generated video file % has not been deleted from storage', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER "generated_video_files_delete_guard" BEFORE DELETE ON "generated_video_files"
  FOR EACH ROW EXECUTE FUNCTION "generated_video_files_delete_guard_trigger"();
