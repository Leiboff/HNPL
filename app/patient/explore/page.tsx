import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import ExploreView from './ExploreView';
import { geocodeSuburb } from './actions';

// ─── Explore practices ─────────────────────────────────────────────────
//
// Server component: fetches every APPROVED practice with their address +
// coordinates and hands the list to <ExploreView> (client). The client
// then handles geolocation, suburb fallback, Haversine sort, and the
// radius filter — all in-session, never persisted (POPIA).

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

  const { data: rawPractices } = await supabase
    .from('practices')
    .select('id, name, specialty, phone, email, suburb, city, latitude, longitude')
    .eq('status', 'approved')
    .order('name');

  const practices = (rawPractices ?? []) as PracticeCard[];

  return (
    <div className="mx-auto max-w-2xl px-4 sm:px-5 py-6 sm:py-8">
      <h1 className="text-2xl font-semibold mb-1" style={{ color: '#13294B' }}>Find a Practice</h1>
      <p className="text-sm text-gray-500 mb-6">
        Allow location to see practices near you, or search by suburb.
      </p>
      <ExploreView practices={practices} geocodeSuburb={geocodeSuburb} />
    </div>
  );
}
