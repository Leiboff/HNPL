import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';

export type UpdateSessionResult = {
  /** The response carrying any refreshed auth cookies. */
  response: NextResponse;
  /**
   * The authenticated user, or null.
   *
   * Returned rather than discarded so callers don't have to call
   * `auth.getUser()` a second time — that call validates the JWT against
   * Supabase over the network, so a duplicate is a real round trip added
   * to every request. proxy.ts needs it for the absolute session cap.
   */
  user: User | null;
  /**
   * The cookie-bound client, so a caller can act on the session it just
   * read (proxy.ts revokes here when the cap is exceeded) without
   * constructing a second client against the same cookies.
   */
  supabase: SupabaseClient;
};

export async function updateSession(request: NextRequest): Promise<UpdateSessionResult> {
  // Start with a passthrough response. If setAll needs to write cookies it will
  // replace this with a new NextResponse that carries the Set-Cookie headers.
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // Write the updated cookies onto the request so subsequent
          // createServerClient calls in the same request see them.
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          // Rebuild the response so the Set-Cookie headers reach the browser.
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Refreshes the session and rotates the access token if it has expired.
  // Must be called before any logic that depends on the session.
  const { data: { user } } = await supabase.auth.getUser();

  return { response: supabaseResponse, user, supabase };
}
