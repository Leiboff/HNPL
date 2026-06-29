import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import ExploreView from './ExploreView';

// ─── Explore practices ─────────────────────────────────────────────────
//
// Server component: fetches every APPROVED practice with their address +
// coordinates and hands the list to <ExploreView> (client). The client
// then handles geolocation, suburb fallback, Haversine sort, and the
// radius filter — all in-session, never persisted (POPIA).
//
// Why we query `practices_directory` (the view), not `practices`
// directly:
//   The `practices` table's SELECT policies are ALL relationship-scoped
//   (member, owner, platform admin, patient-with-an-existing-plan,
//   brand admin) — a patient querying the table for discovery sees
//   only practices they ALREADY have a plan with. Migration 0063
//   introduces `practices_directory`, a security-definer view that
//   (a) exposes only directory-safe columns (no banking, no
//   fee_percent, no internal FKs) and (b) hard-filters to
//   status = 'approved'. Authenticated patients can SELECT through it
//   to discover every approved practice; sensitive columns are
//   physically absent from the view. The base table's policies stay
//   exactly as they were.

export type PracticeCard = {
  id:        string;
  name:      string;
  specialty: string | null;
  phone:     string | null;
  email:     string | null;
  suburb:    string | null;
  city:      string | null;
  latitude:  number | null;
  longitude: number | null;
};

export default async function ExplorePage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // The view is approved-only by construction; we don't repeat the
  // status filter here. Selecting only the columns the page needs
  // (matches the safe set in the view definition).
  const { data: rawPractices } = await supabase
    .from('practices_directory')
    .select('id, name, specialty, phone, email, suburb, city, latitude, longitude')
    .order('name');

  const practices = (rawPractices ?? []) as PracticeCard[];

  return (
    <div className="mx-auto max-w-2xl px-4 sm:px-5 py-6 sm:py-8">
      <h1 className="text-2xl font-semibold mb-1" style={{ color: '#13294B' }}>Find a Practice</h1>
      <p className="text-sm text-gray-500 mb-6">
        Allow location to see practices near you, or search by suburb.
      </p>
      <ExploreView practices={practices} />
    </div>
  );
}
