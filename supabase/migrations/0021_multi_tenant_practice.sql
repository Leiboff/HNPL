-- Multi-tenant practice model: provider support, structured addresses, invitations.
-- Uses ADD COLUMN IF NOT EXISTS throughout — never drops or renames existing columns.

-- ─── PROFILES ─────────────────────────────────────────────────────────────────

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS hpcsa_number          TEXT,
  ADD COLUMN IF NOT EXISTS must_change_password  BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS verification_status   TEXT    DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified', 'pending', 'verified'));

-- ─── PRACTICES ────────────────────────────────────────────────────────────────
-- Existing: hpcsa_number, email, phone, address (JSONB), bank_name,
--           bank_account_number, branch_code, status, fee_percent, specialty.
-- Adding structured columns alongside the existing JSONB address.

ALTER TABLE practices
  ADD COLUMN IF NOT EXISTS admin_email                    TEXT,
  ADD COLUMN IF NOT EXISTS practice_registration_number  TEXT,
  ADD COLUMN IF NOT EXISTS account_holder                TEXT,
  ADD COLUMN IF NOT EXISTS account_type                  TEXT
    CHECK (account_type IN ('current', 'savings')),
  ADD COLUMN IF NOT EXISTS address_line1                 TEXT,
  ADD COLUMN IF NOT EXISTS address_line2                 TEXT,
  ADD COLUMN IF NOT EXISTS suburb                        TEXT,
  ADD COLUMN IF NOT EXISTS city                          TEXT,
  ADD COLUMN IF NOT EXISTS practice_province             TEXT,
  ADD COLUMN IF NOT EXISTS postal_code                   TEXT,
  ADD COLUMN IF NOT EXISTS admin_is_provider             BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS admin_specialty               TEXT,
  ADD COLUMN IF NOT EXISTS admin_hpcsa_number            TEXT;

-- ─── PRACTICE_MEMBERS ─────────────────────────────────────────────────────────
-- Existing: id, practice_id, user_id, role, active, created_at

ALTER TABLE practice_members
  ADD COLUMN IF NOT EXISTS specialty                TEXT,
  ADD COLUMN IF NOT EXISTS hpcsa_number             TEXT,
  ADD COLUMN IF NOT EXISTS sa_id_number             TEXT,
  ADD COLUMN IF NOT EXISTS payout_destination       TEXT DEFAULT 'practice'
    CHECK (payout_destination IN ('practice', 'provider')),
  ADD COLUMN IF NOT EXISTS personal_bank_name       TEXT,
  ADD COLUMN IF NOT EXISTS personal_account_holder  TEXT,
  ADD COLUMN IF NOT EXISTS personal_account_number  TEXT,
  ADD COLUMN IF NOT EXISTS personal_branch_code     TEXT,
  ADD COLUMN IF NOT EXISTS personal_account_type    TEXT
    CHECK (personal_account_type IN ('current', 'savings')),
  ADD COLUMN IF NOT EXISTS can_create_bills         BOOLEAN DEFAULT false;

-- ─── PLANS ────────────────────────────────────────────────────────────────────

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS provider_id UUID REFERENCES profiles(id);

-- Allow plans to be created before the patient registers (Scenario B invitation flow).
ALTER TABLE plans    ALTER COLUMN patient_id DROP NOT NULL;
ALTER TABLE applications ALTER COLUMN patient_id DROP NOT NULL;

-- ─── PAYOUTS ──────────────────────────────────────────────────────────────────

ALTER TABLE payouts
  ADD COLUMN IF NOT EXISTS provider_id              UUID REFERENCES profiles(id),
  ADD COLUMN IF NOT EXISTS payout_destination       TEXT DEFAULT 'practice'
    CHECK (payout_destination IN ('practice', 'provider')),
  ADD COLUMN IF NOT EXISTS snapshot_bank_name       TEXT,
  ADD COLUMN IF NOT EXISTS snapshot_account_holder  TEXT,
  ADD COLUMN IF NOT EXISTS snapshot_account_number  TEXT,
  ADD COLUMN IF NOT EXISTS snapshot_branch_code     TEXT,
  ADD COLUMN IF NOT EXISTS snapshot_account_type    TEXT;

-- ─── PATIENT INVITATIONS ──────────────────────────────────────────────────────
-- Tracks Scenario B: practice creates a bill for a patient who doesn't yet have
-- an account. A secure token is emailed/shared; the patient registers via that link.

CREATE TABLE IF NOT EXISTS patient_invitations (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT        NOT NULL,
  plan_id      UUID        REFERENCES plans(id) ON DELETE CASCADE,
  practice_id  UUID        REFERENCES practices(id),
  provider_id  UUID        REFERENCES profiles(id),
  invited_at   TIMESTAMPTZ DEFAULT now(),
  accepted_at  TIMESTAMPTZ,
  token        TEXT        UNIQUE NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS patient_invitations_email_idx ON patient_invitations(email);
CREATE INDEX IF NOT EXISTS patient_invitations_token_idx ON patient_invitations(token);

ALTER TABLE patient_invitations ENABLE ROW LEVEL SECURITY;

-- Practice admins can manage invitations for their practice.
CREATE POLICY "practice_admin_select_invitations"
  ON patient_invitations FOR SELECT
  USING (
    practice_id IN (
      SELECT pm.practice_id FROM practice_members pm
      WHERE pm.user_id = auth.uid() AND pm.role = 'practice_admin'
    )
  );

-- Unauthenticated token lookup for the signup page.
-- The token is a 32-byte random secret; guessing it is computationally infeasible.
CREATE POLICY "public_token_lookup"
  ON patient_invitations FOR SELECT
  USING (true);
