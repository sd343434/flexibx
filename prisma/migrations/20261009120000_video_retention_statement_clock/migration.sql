-- succeeded_at now defaults to statement_timestamp(), which inside a long transaction is
-- later than now() (the transaction start). Compare against the current wall clock so a
-- legitimate insert late in a transaction is not mistaken for a future timestamp; values
-- more than one second ahead are still rejected. Expiry stays succeeded_at + 168 hours.
CREATE OR REPLACE FUNCTION "generated_videos_retention_trigger"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.succeeded_at > clock_timestamp() + interval '1 second' THEN
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
