-- ─── Practice coordinates — drive the "practices near me" filter ───────
--
-- Adds latitude + longitude on practices. Populated server-side by the
-- admin practice create/edit flow via Google Geocoding API (see
-- lib/maps/geocode.ts and the admin practice action that calls it).
-- Manual override is also supported on the admin form (SA-range
-- validation in the action) so a failed geocode or a wrong-pin can be
-- hand-corrected.
--
-- NUMERIC(9,6) gives a precision of ~10 cm at the equator — more than
-- enough for a "is this practice ~3 km away" lookup. Both nullable —
-- a practice can exist without coordinates (geocoding failed,
-- new-practice not yet geocoded), in which case the explore page lands
-- it in the "other practices" bucket rather than dropping it.
--
-- Index uses btree on (latitude, longitude). Postgres CAN do a
-- bounding-box scan against a btree composite when filters look like
-- WHERE latitude BETWEEN a AND b AND longitude BETWEEN c AND d, but we
-- compute Haversine entirely client-side over the whole approved set
-- (typically dozens, not thousands). The index is for future-proofing
-- when the practice count grows past the in-memory-friendly threshold.

ALTER TABLE practices ADD COLUMN IF NOT EXISTS latitude  NUMERIC(9,6);
ALTER TABLE practices ADD COLUMN IF NOT EXISTS longitude NUMERIC(9,6);

CREATE INDEX IF NOT EXISTS practices_coordinates_idx
  ON practices (latitude, longitude)
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL;
