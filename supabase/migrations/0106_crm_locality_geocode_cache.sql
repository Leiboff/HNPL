-- ─── Persistent cache for bulk-import neighbourhood geocoding ───────────
--
-- lib/crm/localityGeocode.ts resolves a free-text neighbourhood string
-- ("Springs, Springs, Gauteng") to an approximate centroid via Places
-- API (New) Text Search for the /crm/import "Quick import" flow. Without
-- a persistent cache, every SEPARATE import batch re-queries Google for
-- the same handful of SA suburbs that recur across thousands of leads
-- and multiple import runs over time. This table makes that lookup
-- happen once, ever, per distinct locality string — not once per row,
-- and not once per import batch either.
--
-- Only successful geocodes are cached. A miss (no match found, or a
-- transient failure) is never written here, so it's retried on the next
-- import rather than being memorialised as a permanent dead end.

CREATE TABLE IF NOT EXISTS crm_locality_geocode_cache (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  query_normalised   TEXT        NOT NULL UNIQUE, -- lib/crm/localityGeocode.ts normaliseLocalityQuery() output
  latitude           NUMERIC     NOT NULL,
  longitude          NUMERIC     NOT NULL,
  formatted_address  TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Same scope as crm_leads/crm_activities — only the sales team imports
-- leads, so only they need to read or populate this cache.

ALTER TABLE crm_locality_geocode_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "crm_locality_geocode_cache_admin_sales_select"
  ON crm_locality_geocode_cache FOR SELECT
  USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales')
  );

CREATE POLICY "crm_locality_geocode_cache_admin_sales_insert"
  ON crm_locality_geocode_cache FOR INSERT
  WITH CHECK (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales')
  );

CREATE POLICY "crm_locality_geocode_cache_admin_sales_update"
  ON crm_locality_geocode_cache FOR UPDATE
  USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales')
  )
  WITH CHECK (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales')
  );

CREATE POLICY "crm_locality_geocode_cache_admin_sales_delete"
  ON crm_locality_geocode_cache FOR DELETE
  USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales')
  );
