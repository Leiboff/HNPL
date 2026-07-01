import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import ExploreView from './ExploreView';
import type { DirectoryRow } from '@/lib/practitioner/grouping';

// ─── Find a Practitioner ───────────────────────────────────────────────
//
// Server component: fetches every active provider at an approved
// practice (one row per practitioner-at-a-practice) via the
// `practitioners_directory` safe view (migration 0064), and hands the
// list to <ExploreView> (client). The client groups rows by HPCSA
// (with a null fallback), decorates with Haversine distance,
// bucketizes by radius, and applies the filters (proximity + specialty
// + name search).
//
// Why we query `practitioners_directory`, not the underlying tables:
//   `practice_members` and `practices` are both governed by
//   relationship-scoped SELECT policies — a patient querying the
//   tables for discovery would see only providers at practices they
//   already have a plan with. Migration 0064 introduces a definer
//   view that exposes ONLY the directory-safe columns (no banking,
//   no fee_percent, no personal_*, no SA-ID, no raw HPCSA — HPCSA
//   is exposed as md5(hash) + a registered boolean badge), filters
//   to active providers at approved practices, and is GRANTed only
//   to `authenticated`. Internal flows continue to query the base
//   tables with their existing RLS.

export default async function ExplorePage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // The view enforces (role='provider', active=true, status='approved')
  // by construction. We don't repeat those filters here.
  const { data: rawRows } = await supabase
    .from('practitioners_directory')
    .select([
      'member_id',
      'hpcsa_group_key',
      'hpcsa_registered',
      'first_name',
      'last_name',
      'specialty',
      'practice_id',
      'practice_name',
      'practice_suburb',
      'practice_city',
      'practice_latitude',
      'practice_longitude',
      'practice_phone',
    ].join(','))
    .order('last_name')
    .order('first_name');

  // PostgREST/typegen doesn't know about the view's column shape;
  // cast through `unknown` since the view IS the source of truth for
  // the column set (asserted by the source-text tests).
  const rows = (rawRows ?? []) as unknown as DirectoryRow[];

  // The Landing screen owns its own hero heading + copy; the Results
  // view owns its own back-link + search bar. The page shell here is
  // deliberately empty of headings so the two views can each set
  // their own tone without a mismatched outer H1.
  return (
    <div className="mx-auto max-w-2xl px-4 sm:px-5 py-6 sm:py-8">
      <ExploreView rows={rows} />
    </div>
  );
}
