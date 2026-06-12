-- Stores safe card display data only.
-- No full card number, CVV, or sensitive card data is stored here.
-- The `token` column holds a processor token that references the real card
-- stored securely at the payment processor.

CREATE TABLE payment_methods (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id       UUID        NOT NULL REFERENCES profiles(id),
  card_brand       TEXT        NOT NULL,
  last_four        TEXT        NOT NULL CHECK (last_four ~ '^\d{4}$'),
  expiry_month     INTEGER     NOT NULL CHECK (expiry_month BETWEEN 1 AND 12),
  expiry_year      INTEGER     NOT NULL CHECK (expiry_year >= 2000),
  cardholder_name  TEXT        NOT NULL,
  token            TEXT        NOT NULL,
  is_default       BOOLEAN     NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE payment_methods ENABLE ROW LEVEL SECURITY;

CREATE INDEX payment_methods_patient_id_idx ON payment_methods (patient_id);

-- Patients: full CRUD on their own rows
CREATE POLICY patients_select_own_payment_methods
  ON payment_methods FOR SELECT
  USING (patient_id = auth.uid());

CREATE POLICY patients_insert_own_payment_methods
  ON payment_methods FOR INSERT
  WITH CHECK (patient_id = auth.uid());

CREATE POLICY patients_update_own_payment_methods
  ON payment_methods FOR UPDATE
  USING (patient_id = auth.uid())
  WITH CHECK (patient_id = auth.uid());

CREATE POLICY patients_delete_own_payment_methods
  ON payment_methods FOR DELETE
  USING (patient_id = auth.uid());

-- Admins: read all
CREATE POLICY admins_select_all_payment_methods
  ON payment_methods FOR SELECT
  USING (is_platform_admin());
