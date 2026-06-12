-- Change invoice number prefix from 'HNPL-' to 'BN-' for new invoices.
-- Existing stored values (HNPL-YYYY-NNNNNN) are not touched.

CREATE OR REPLACE FUNCTION next_invoice_number()
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT 'BN-'
        || to_char(CURRENT_DATE, 'YYYY')
        || '-'
        || lpad(nextval('hnpl_invoice_seq')::TEXT, 6, '0')
$$;
