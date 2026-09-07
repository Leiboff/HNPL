-- Durable Didit webhook inbox. A delivery being received is not the same as
-- its identity decision being successfully persisted.

ALTER TABLE public.didit_webhook_events
  ADD COLUMN IF NOT EXISTS payload JSONB,
  ADD COLUMN IF NOT EXISTS processing_status TEXT NOT NULL DEFAULT 'processed',
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error TEXT;

ALTER TABLE public.didit_webhook_events
  DROP CONSTRAINT IF EXISTS didit_webhook_events_processing_status_chk;
ALTER TABLE public.didit_webhook_events
  ADD CONSTRAINT didit_webhook_events_processing_status_chk
  CHECK (processing_status IN ('processing', 'processed', 'failed'));

CREATE INDEX IF NOT EXISTS didit_webhook_events_retry_idx
  ON public.didit_webhook_events (processing_status, received_at)
  WHERE processing_status = 'failed';

COMMENT ON TABLE public.didit_webhook_events IS
  'Durable Didit webhook inbox. Payloads are retained for replay; only rows '
  'with processing_status=processed are terminal duplicates. RLS permits '
  'service-role access only because payloads can contain identity data.';

CREATE OR REPLACE FUNCTION public.claim_didit_webhook_event(
  p_event_id TEXT,
  p_payload JSONB
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  current_status TEXT;
  started_at TIMESTAMPTZ;
BEGIN
  INSERT INTO public.didit_webhook_events (
    event_id, payload, processing_status, attempt_count, processing_started_at
  ) VALUES (
    p_event_id, p_payload, 'processing', 1, clock_timestamp()
  ) ON CONFLICT (event_id) DO NOTHING;

  IF FOUND THEN
    RETURN 'claimed';
  END IF;

  SELECT processing_status, processing_started_at
    INTO current_status, started_at
    FROM public.didit_webhook_events
    WHERE event_id = p_event_id
    FOR UPDATE;

  IF current_status = 'processed' THEN
    RETURN 'processed';
  END IF;

  -- A live lease owns this event. An expired lease is recoverable after a
  -- crashed invocation; a failed attempt is immediately retryable.
  IF current_status = 'processing'
     AND started_at > clock_timestamp() - INTERVAL '5 minutes' THEN
    RETURN 'active';
  END IF;

  UPDATE public.didit_webhook_events
    SET payload = p_payload,
        processing_status = 'processing',
        attempt_count = attempt_count + 1,
        processing_started_at = clock_timestamp(),
        processed_at = NULL,
        last_error = NULL
    WHERE event_id = p_event_id;
  RETURN 'claimed';
END;
$$;

REVOKE ALL ON FUNCTION public.claim_didit_webhook_event(TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_didit_webhook_event(TEXT, JSONB) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_didit_webhook_event(TEXT, JSONB) TO service_role;
