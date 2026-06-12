-- HNPL Invoice Numbers
-- Human-readable bill references in the format HNPL-YYYY-000001.
-- The sequence is global (not per-year) so numbers are always unique even across year boundaries.

-- ── Sequence ──────────────────────────────────────────────────────────────────

CREATE SEQUENCE hnpl_invoice_seq
    START WITH 1
    INCREMENT BY 1
    NO MAXVALUE
    NO CYCLE;

-- ── Column + unique constraint ─────────────────────────────────────────────────

ALTER TABLE plans
    ADD COLUMN invoice_number TEXT;

ALTER TABLE plans
    ADD CONSTRAINT plans_invoice_number_unique UNIQUE (invoice_number);

-- ── Generator function ────────────────────────────────────────────────────────

-- SECURITY DEFINER so the authenticated role can call it without needing direct
-- USAGE on the sequence (which is owned by the migration role).
CREATE OR REPLACE FUNCTION next_invoice_number()
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT 'HNPL-'
        || to_char(CURRENT_DATE, 'YYYY')
        || '-'
        || lpad(nextval('hnpl_invoice_seq')::TEXT, 6, '0')
$$;

-- ── Permissions ───────────────────────────────────────────────────────────────

GRANT EXECUTE ON FUNCTION next_invoice_number() TO authenticated;
