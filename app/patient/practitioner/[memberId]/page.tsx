import { redirect, notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import type { DirectoryRow } from '@/lib/practitioner/grouping';
import DetailView from './DetailView';
import { getRequestUser } from '@/lib/auth/requestUser';

// ─── Practitioner detail screen ────────────────────────────────────────
//
// Tap-through target for the explore list card. URL carries a
// member_id — the page resolves that row's `hpcsa_group_key` and
// fetches all rows sharing it (the same grouping logic the list page
// uses, just server-side instead of client-side). For a null-key row
// (practitioner with no HPCSA on file) the page shows just the one
// row — the same "never hide anyone" fallback the list uses.
//
// Reads from the SAME `practitioners_directory` safe view that the
// list page uses — no new sensitive surface. The view's column
// allowlist (no banking, no fee_percent, no internal FKs, no raw
// HPCSA) is the security boundary; this page can't reach more.
//
// Branding + content rules (mirrored from the list):
//   • Locations list — Call to book + Directions per row.
//   • NO medical-aid-network language anywhere (no "Cover", no
//     "In Network", no "Premier Plus", no "Nominate as primary GP").
//   • NO HPCSA badge.
//
// Distance: the detail page does its own client-side geolocation in
// DetailView, same re-prompt contract as the list page. A direct
// link shared between users still works without the explore session.

export const dynamic = 'force-dynamic';

export default async function PractitionerDetailPage({
  params,
}: {
  params: Promise<{ memberId: string }>;
}) {
  const { memberId } = await params;

  const supabase = await createClient();
  const user = await getRequestUser();
  if (!user) redirect('/login');

  // Step 1 — fetch THIS member's row. The view is GRANTed to
  // `authenticated`, so a logged-in patient sees the row if it
  // exists. A request for a member_id that doesn't satisfy the
  // view's WHERE (active + provider + practice approved) returns
  // null → 404.
  const { data: anchorRaw } = await supabase
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
    .eq('member_id', memberId)
    .maybeSingle();

  const anchor = anchorRaw as unknown as DirectoryRow | null;
  if (!anchor) notFound();

  // Step 2 — if this practitioner has an HPCSA grouping key, fetch
  // every sibling membership; otherwise the practitioner is a
  // standalone row (NULL key fallback) and the anchor IS the entire
  // set. Same null-fallback rule as groupIntoCards.
  let rows: DirectoryRow[];
  if (anchor.hpcsa_group_key) {
    const { data: siblingRaw } = await supabase
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
      .eq('hpcsa_group_key', anchor.hpcsa_group_key);
    rows = (siblingRaw ?? []) as unknown as DirectoryRow[];
  } else {
    rows = [anchor];
  }

  return <DetailView rows={rows} />;
}
