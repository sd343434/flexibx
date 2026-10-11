-- succeeded_at is stored with millisecond precision, so the database's own now() can be
-- rounded up by less than a millisecond and look "in the future". Allow one second of
-- tolerance; anything later is still rejected. Expiry stays succeeded_at + 168 hours.
CREATE OR REPLACE FUNCTION "generated_videos_retention_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.succeeded_at > now() + interval '1 second' THEN
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
