-- ─── POPIA minimisation — drop the patient's physical-address columns ──
--
-- HNPL is a payment product, not a delivery product — the patient's
-- physical postal address isn't needed for any flow today, and POPIA
-- (s10/11) requires minimum-necessary collection. The six columns
-- below were added by 0016_add_billing_address.sql; none of them are
-- referenced by:
--   • the 0054 protect-profiles-columns trigger (address is not in
--     the locked set; only a comment in 0054 mentions the existing
--     UPDATE call site, which is being removed alongside this);
--   • any RLS policy, fraud/dedup logic, or KYC flow;
--   • the Paystack integration (cards are tokenised; address never
--     leaves the database);
--   • any export or receipt.
--
-- Email and phone are NOT touched here — both are load-bearing for
-- auth/OTP/notifications and remain on the profiles row.
--
-- The address belongs to the PATIENT only. The PRACTICE address
-- (on the practices table, added by 0021) is NOT touched — it's
-- needed for geocoding (see 0060) and the explore page's
-- "practices near me" filter.

ALTER TABLE profiles DROP COLUMN IF EXISTS address_line1;
ALTER TABLE profiles DROP COLUMN IF EXISTS address_line2;
ALTER TABLE profiles DROP COLUMN IF EXISTS suburb;
ALTER TABLE profiles DROP COLUMN IF EXISTS city;
ALTER TABLE profiles DROP COLUMN IF EXISTS province;
ALTER TABLE profiles DROP COLUMN IF EXISTS postal_code;
