import { cache, Suspense } from 'react';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import ExploreView from './ExploreView';
import PatientScreen from '../PatientScreen';
import type { DirectoryRow } from '@/lib/practitioner/grouping';
import { getRequestUser } from '@/lib/auth/requestUser';
import { NavyLine, PatientListBody } from '@/components/loading/PatientShellShape';

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

// The title "Find care" is static — it renders immediately. The count in
// the subtitle and the results list both come from the SAME directory
// query, so they Suspend together off one shared, request-memoised fetch
// rather than each re-querying the view. Zero-argument like
// getRequestUser() (lib/auth/requestUser.ts): the view scopes results by
// RLS on the request's own session, not by a patient_id filter, so there
// is no useful cache key beyond "this request" — a zero-arg cache() has
// exactly one key, so both Suspense children below always hit it.
const loadDirectoryRows = cache(async () => {
  const supabase = await createClient();

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
  return (rawRows ?? []) as unknown as DirectoryRow[];
});

async function ExploreSubtitle() {
  const rows = await loadDirectoryRows();
  // Distinct practitioners (a member can appear once per practice).
  const practitionerCount = new Set(rows.map((r) => r.member_id)).size;
  return (
    <p className="mt-1.5 text-[13.5px]" style={{ color: 'rgba(255,255,255,.62)' }}>
      {practitionerCount > 0
        ? `Pay later at ${practitionerCount} practitioner${practitionerCount === 1 ? '' : 's'} near you.`
        : 'Pay later at practitioners near you.'}
    </p>
  );
}

async function ExploreBody() {
  const rows = await loadDirectoryRows();
  return <ExploreView rows={rows} hideHero />;
}

export default async function ExplorePage() {
  const user = await getRequestUser();
  if (!user) redirect('/login');

  // v4: a navy header carries the title + count; ExploreView renders its
  // search, filters and results on the sheet (its own Landing hero is
  // suppressed via hideHero so the title isn't duplicated).
  const header = (
    <>
      <p className="text-[24px] font-semibold text-white" style={{ letterSpacing: '-.025em' }}>Find care</p>
      <Suspense fallback={<NavyLine w="w-52" h="h-3" className="mt-1.5" />}>
        <ExploreSubtitle />
      </Suspense>
    </>
  );

  return (
    <PatientScreen header={header} sheetClassName="px-[18px] pt-5 pb-6">
      <Suspense fallback={<PatientListBody label="Loading practitioners" />}>
        <ExploreBody />
      </Suspense>
    </PatientScreen>
  );
}
