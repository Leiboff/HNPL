/**
 * Server-side Supabase client.
 *
 * Use this in Server Components, Route Handlers, and Server Actions. It reads
 * and writes auth cookies via the Next.js `cookies()` API so the session is
 * available during server-side rendering. Do NOT import this in Client
 * Components — use client.ts for those.
 */

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // setAll is called from Server Components where cookies cannot be
            // mutated. Safe to ignore — the middleware will refresh the session.
          }
        },
      },
    },
  );
}
