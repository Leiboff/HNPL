'use client';

import { createClient } from '@/lib/supabase/client';

export default function LogoutButton() {
  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = '/login';
  }

  return (
    <button
      onClick={handleSignOut}
      aria-label="Sign out"
      className="flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-white/70 hover:text-white hover:bg-white/12 transition-colors"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
        <polyline points="16 17 21 12 16 7" />
        <line x1="21" y1="12" x2="9" y2="12" />
      </svg>
      <span className="hidden sm:inline text-xs font-medium">Sign out</span>
    </button>
  );
}
