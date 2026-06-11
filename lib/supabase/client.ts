/**
 * Browser-side Supabase client.
 *
 * Use this in Client Components (`'use client'`). It reads and writes auth
 * cookies directly in the browser. Do NOT import this in Server Components,
 * Route Handlers, or Server Actions — use server.ts for those.
 */

import { createBrowserClient } from '@supabase/ssr';

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // Opt into the experimental passkey API. @supabase/ssr 0.10.3 spreads
      // options.auth into the inner createClient call, so this nested
      // `experimental` flag threads through cleanly.
      auth: { experimental: { passkey: true } },
    },
  );
}
