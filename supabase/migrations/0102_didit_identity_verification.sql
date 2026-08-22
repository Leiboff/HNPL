-- ─── Didit identity verification (KYC + liveness + face match) ──────────
--
-- Replaces the manual SA-ID-number text field on the onboarding "identity"
-- step with a Didit-hosted session (OCR document scan + liveness + face
-- match, bundled AML screening). The SAME Didit session satisfies both the
-- 'identity' step (writes sa_id_number/sa_id_lookup_hash, same columns the
-- old manual path wrote — see 0096/0097) and the 'liveness' step (writes
-- liveness_verified_at) — see lib/onboarding/actions.ts::startIdentityVerification
-- and app/api/verification/didit/webhook/route.ts.
--
--   • didit_session_id                 — the Didit session this profile's
--                                         verification is (or was last) tied to.
--   • identity_verification_status     — lifecycle of that session, mapped
--                                         from Didit's webhook status:
--                                           pending    — session created, awaiting completion
--                                           in_review  — Didit flagged for manual review
--                                           approved   — passed; sa_id_number + liveness_verified_at written
--                                           declined   — failed (bad doc, liveness mismatch, invalid
--                                                        extracted ID, or ID already claimed by another account)
--                                           abandoned  — user left mid-flow
--                                           expired    — session URL aged out
--   • identity_verification_updated_at — stamp for the status above.
--
-- Idempotent — safe to re-run.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS didit_session_id                  TEXT,
  ADD COLUMN IF NOT EXISTS identity_verification_status      TEXT,
  ADD COLUMN IF NOT EXISTS identity_verification_reason      TEXT,
  ADD COLUMN IF NOT EXISTS identity_verification_updated_at  TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_identity_verification_status_chk'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_identity_verification_status_chk
      CHECK (
        identity_verification_status IS NULL
        OR identity_verification_status IN ('pending', 'in_review', 'approved', 'declined', 'abandoned', 'expired')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_identity_verification_reason_chk'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_identity_verification_reason_chk
      CHECK (
        identity_verification_reason IS NULL
        OR identity_verification_reason IN ('no_id_extracted', 'invalid_id', 'underage', 'id_already_registered')
      );
  END IF;
END $$;

COMMENT ON COLUMN public.profiles.didit_session_id IS
  'Didit verification session id (v3 /session/) this profile is/was tied to. Set by startIdentityVerification, read by the webhook to know which profile a delivery belongs to (in addition to vendor_data).';
COMMENT ON COLUMN public.profiles.identity_verification_status IS
  'Lifecycle of the Didit session above: pending/in_review/approved/declined/abandoned/expired. approved is written atomically with sa_id_number + liveness_verified_at by the webhook handler.';
COMMENT ON COLUMN public.profiles.identity_verification_reason IS
  'Set alongside identity_verification_status=declined so the client can show the right copy — in particular id_already_registered gets the same "an account already exists… Forgot password…" guidance the manual entry path used, rather than a generic failure. NULL for every other status.';

-- ─── Webhook delivery idempotency ledger ─────────────────────────────────
--
-- Didit retries a delivery (5xx/404/timeout) up to twice and reuses the
-- SAME event_id on every retry and across every destination the event
-- fans out to (per Didit's webhook docs). The primary-key unique
-- violation IS the dedupe check — see alreadyProcessed() in the webhook
-- route, which relies on the INSERT failing rather than a prior SELECT
-- (avoids a check-then-act race between concurrent deliveries).
--
-- Service-role only: RLS enabled with no policies, so anon/authenticated
-- roles have zero access under RLS (the webhook route uses the
-- service-role client, which bypasses RLS entirely).

CREATE TABLE IF NOT EXISTS public.didit_webhook_events (
  event_id     TEXT PRIMARY KEY,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.didit_webhook_events ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.didit_webhook_events IS
  'Idempotency ledger for Didit webhook deliveries. event_id is stable across retries and fan-out; the PK violation on a duplicate INSERT is the dedupe check itself.';
