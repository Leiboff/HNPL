import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function updateSession(request: NextRequest) {
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
  await supabase.auth.getUser();

  return supabaseResponse;
}
