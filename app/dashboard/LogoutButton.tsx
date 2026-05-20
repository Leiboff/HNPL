'use client';

import { createClient } from '@/lib/supabase/client';

export default function LogoutButton() {
  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = '/login';
  }

  return (
    <button
      onClick={handleLogout}
      className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
    >
      Log out
    </button>
  );
}
