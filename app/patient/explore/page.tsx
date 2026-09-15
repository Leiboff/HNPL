import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import ExploreView from './ExploreView';
import ExploreHeader from './ExploreHeader';
import PatientScreen from '../PatientScreen';
import {
  decorateWithDistance,
  groupIntoCards,
  type DirectoryRow,
} from '@/lib/practitioner/grouping';
import { categoryCounts } from '@/lib/practitioner/categories';
import { getRequestUser } from '@/lib/auth/requestUser';

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

  const user = await getRequestUser();
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

  // Distinct practitioners (a member can appear once per practice).
  const practitionerCount = new Set(rows.map((r) => r.member_id)).size;

  // Per-specialty counts for the header's subtitle. Distance plays no
  // part in a count, so we group with a null location — the client
  // recomputes the same cards with distances for the list itself.
  const categories = categoryCounts(groupIntoCards(decorateWithDistance(rows, null)));

  // v4: a navy header carries the title + count; ExploreView renders its
  // search, filters and results on the sheet (its own Landing hero is
  // suppressed via hideHero so the title isn't duplicated). The header is
  // a client component because inside a specialty the title IS the
  // specialty — it has to follow the ?specialty= param.
  const header = (
    <ExploreHeader practitionerCount={practitionerCount} categories={categories} />
  );

  return (
    <PatientScreen header={header} sheetClassName="px-[18px] pt-5 pb-6">
      <ExploreView rows={rows} hideHero />
    </PatientScreen>
  );
}
