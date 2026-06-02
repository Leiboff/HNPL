import { createClient } from '@/lib/supabase/server';
import ConfirmedView from './ConfirmedView';

const ROLE_DESTINATIONS: Record<string, string> = {
  patient:           '/patient',
  practice_admin:    '/practice',
  practice_provider: '/provider',
};

export default async function ConfirmedPage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();

  let destination = '/patient';

  if (user) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (profile?.role && ROLE_DESTINATIONS[profile.role]) {
      destination = ROLE_DESTINATIONS[profile.role];
    }
  }

  return <ConfirmedView destination={destination} />;
}
