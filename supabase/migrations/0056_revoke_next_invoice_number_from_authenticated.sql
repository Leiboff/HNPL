-- ─── M2 — revoke next_invoice_number from authenticated ─────────────────
--
-- Audit finding (2026-06-21, M2): the sequence-advancing RPC
-- next_invoice_number() was granted to `authenticated`, letting any
-- logged-in user spam it to burn invoice numbers. Effect was cosmetic
-- (gaps in HNPL-YYYY-NNNNNN), but unnecessary attack surface.
--
-- Bill creation (app/practice/bills/new/actions.ts) was already
-- creating a service-role client for its other writes — the same
-- commit that lands this migration switches the next_invoice_number
-- call to that svc client. After the revoke, no authenticated caller
-- can advance the sequence.

REVOKE EXECUTE ON FUNCTION next_invoice_number() FROM authenticated;

-- Ensure service-role retains EXECUTE (it does by default since
-- migration 0014 created the function as the migration-running role,
-- and service-role is privileged — but be explicit so a future
-- environment rebuild can't accidentally drop it).
GRANT EXECUTE ON FUNCTION next_invoice_number() TO service_role;
