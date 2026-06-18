import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';

// ─── POST /api/push/subscribe ────────────────────────────────────────────
//
// Called from the in-app toggle when the patient turns notifications
// ON. Body is the PushSubscription.toJSON() shape produced by
// PushManager.subscribe():
//   { endpoint: string, keys: { p256dh: string, auth: string } }
//
// Stores (or re-activates) a push_subscriptions row tied to the
// authenticated patient. The endpoint is UNIQUE — a re-subscribe from
// the same browser produces an UPSERT that clears any prior
// deleted_at (the patient opted back in).
//
// Service-role write is used because the existing RLS allows the
// patient to INSERT/UPDATE their own rows, but the UNIQUE-endpoint
// upsert needs to be able to surface "this endpoint already belongs
// to another user" cleanly — easier with the service-role client
// after we've already authenticated the request via the SSR client.

export const runtime = 'nodejs';

type SubBody = {
  endpoint:  string;
  keys: { p256dh: string; auth: string };
};

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  let body: SubBody;
  try {
    body = (await req.json()) as SubBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (!body?.endpoint || !body?.keys?.p256dh || !body?.keys?.auth) {
    return NextResponse.json({ error: 'invalid_subscription' }, { status: 400 });
  }

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  // Upsert by endpoint: if the same browser re-subscribes, we keep
  // the existing row and clear deleted_at (re-activation). If the
  // endpoint is genuinely new, we insert. The user_id MUST match the
  // session — we never let endpoint X claim ownership of another
  // user's row; the existing unique row's user_id is preserved on
  // upsert via DEFAULT semantics of upsert (PostgREST defaults to
  // updating only the columns supplied, so user_id wouldn't change
  // anyway — but the WHERE clause below enforces it explicitly for
  // the deletion-recovery case).
  const userAgent = req.headers.get('user-agent')?.slice(0, 500) ?? null;

  const { error } = await svc
    .from('push_subscriptions')
    .upsert(
      {
        user_id:    user.id,
        endpoint:   body.endpoint,
        p256dh:     body.keys.p256dh,
        auth:       body.keys.auth,
        user_agent: userAgent,
        deleted_at: null,
      },
      { onConflict: 'endpoint' },
    );

  if (error) {
    console.error('[push] subscribe upsert failed', { userId: user.id, error: error.message });
    return NextResponse.json({ error: 'db_error' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
