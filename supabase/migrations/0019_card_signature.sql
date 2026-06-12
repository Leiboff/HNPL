-- Adds Paystack's card `signature` field to payment_methods for deduplication.
-- The same physical card always produces the same signature from Paystack,
-- so (patient_id, signature) is a reliable natural key.

ALTER TABLE payment_methods
  ADD COLUMN IF NOT EXISTS signature TEXT;

-- ─── Cleanup snippet ──────────────────────────────────────────────────────────
-- Run this BEFORE applying the unique constraint if duplicates exist.
-- It deletes older rows, keeping the most recently created row per
-- (patient_id, signature) pair. Rows where signature IS NULL are untouched
-- (the partial constraint below excludes them anyway).
--
-- DELETE FROM payment_methods
-- WHERE id NOT IN (
--   SELECT DISTINCT ON (patient_id, signature) id
--   FROM payment_methods
--   WHERE signature IS NOT NULL
--   ORDER BY patient_id, signature, created_at DESC
-- )
-- AND signature IS NOT NULL;
-- ─────────────────────────────────────────────────────────────────────────────

-- Partial unique constraint: one row per (patient_id, signature).
-- Partial (WHERE signature IS NOT NULL) so legacy rows without a signature
-- don't block the constraint from being added.
CREATE UNIQUE INDEX IF NOT EXISTS payment_methods_patient_signature_idx
  ON payment_methods (patient_id, signature)
  WHERE signature IS NOT NULL;
