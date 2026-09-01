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
// Service-role write is used because the endpoint is UNIQUE across all
// users: deciding "does this endpoint already belong to someone else"
// needs a read the requester's own RLS would hide. That question is now
// actually asked and actually acted on — see the block in POST.

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

  // ── Claim, then write. Never upsert user_id. ────────────────────────
  //
  // THE DEFECT (audit 2026-09-01, F-12)
  //
  // This was one upsert with onConflict:'endpoint' and `user_id` in the
  // payload, under a comment asserting that "PostgREST defaults to
  // updating only the columns supplied, so user_id wouldn't change
  // anyway — but the WHERE clause below enforces it explicitly".
  //
  // Both halves were wrong. user_id WAS one of the supplied columns, so
  // the conflict update set it; and there was no WHERE clause below. So
  // anyone who learned another user's endpoint could POST it and take
  // ownership of the row, silently redirecting that user's payment and
  // plan notifications to their own device.
  //
  // The shape below cannot do that. An existing row is only ever updated
  // with `.eq('user_id', user.id)` in the predicate, so a row belonging to
  // somebody else matches nothing and the request is refused rather than
  // quietly succeeding on the wrong row.
  const userAgent = req.headers.get('user-agent')?.slice(0, 500) ?? null;

  const { data: existing, error: lookupErr } = await svc
    .from('push_subscriptions')
    .select('id, user_id')
    .eq('endpoint', body.endpoint)
    .maybeSingle();

  if (lookupErr) {
    console.error('[push] subscribe lookup failed', { userId: user.id, error: lookupErr.message });
    return NextResponse.json({ error: 'db_error' }, { status: 500 });
  }

  if (existing && existing.user_id !== user.id) {
    // A real browser cannot produce another account's endpoint, so this is
    // either a genuine curiosity (the same physical device re-used by a
    // different person without the subscription being torn down) or an
    // attempt. Both get the same refusal, and the attempt gets logged.
    console.warn('[push] refusing to reassign an endpoint that belongs to another account', {
      requestedBy: user.id,
    });
    return NextResponse.json({ error: 'endpoint_owned' }, { status: 409 });
  }

  const row = {
    user_id:    user.id,
    endpoint:   body.endpoint,
    p256dh:     body.keys.p256dh,
    auth:       body.keys.auth,
    user_agent: userAgent,
    // Re-subscribing IS opting back in, so a prior soft-delete clears.
    deleted_at: null,
  };

  const { error } = existing
    ? await svc
        .from('push_subscriptions')
        .update(row)
        .eq('id', existing.id)
        .eq('user_id', user.id)
    : await svc
        .from('push_subscriptions')
        .insert(row);

  if (error) {
    console.error('[push] subscribe write failed', { userId: user.id, error: error.message });
    return NextResponse.json({ error: 'db_error' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
