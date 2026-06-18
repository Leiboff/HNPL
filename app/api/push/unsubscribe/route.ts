import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';

// ─── POST /api/push/unsubscribe ──────────────────────────────────────────
//
// Called from the in-app toggle when the patient turns notifications
// OFF. Body is { endpoint: string }.
//
// Soft-deletes the row so:
//   • the sender stops fanning out to this device (deleted_at IS NULL
//     filter in lib/notifications/sendPush.ts);
//   • we keep the audit trail of "patient opted out at time X".
//
// Idempotent: a second call from a stale UI doesn't surface an error.
// We only update rows where user_id = session user — the RLS would
// catch a cross-account attempt, but defence in depth.

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  let body: { endpoint?: string };
  try {
    body = await req.json() as { endpoint?: string };
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (!body.endpoint) {
    return NextResponse.json({ error: 'missing_endpoint' }, { status: 400 });
  }

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const { error } = await svc
    .from('push_subscriptions')
    .update({ deleted_at: new Date().toISOString() })
    .eq('endpoint', body.endpoint)
    .eq('user_id', user.id)
    .is('deleted_at', null);

  if (error) {
    console.error('[push] unsubscribe failed', { userId: user.id, error: error.message });
    return NextResponse.json({ error: 'db_error' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
