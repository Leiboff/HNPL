import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { diffFactorSnapshots, type FactorSnapshotRow } from '@/lib/auth/mfaFactorDiff';

// ─── Scheduled MFA factor audit (item F) ────────────────────────────────
//
// Detects factor changes the self-service audit hooks cannot: a factor
// removed with the service-role admin API, or any change made outside the
// app. It reads a read-only snapshot of auth.mfa_factors (via the
// public.mfa_factor_snapshot() SECURITY DEFINER function — the auth schema
// itself is neither exposed nor modified), diffs it against the
// public.mfa_factor_state table the last run left, writes one
// admin_audit_log row per change, then reconciles the state table.
//
// This is the fallback the prompt names: auth.audit_log_entries is empty
// on this project and we could not confirm it populates on enrolment, so a
// scheduled diff of the factors table is the mechanism we build on instead
// of anything layered over that empty table.
//
// Same CRON_SECRET / timing-safe Bearer auth as the other three jobs.
// Runs under service_role (bypasses RLS; may call the snapshot function).

export const dynamic = 'force-dynamic';

const REQUIRE_CRON_SECRET = true;

async function handle(req: NextRequest): Promise<NextResponse> {
  // ── 1. Auth ─────────────────────────────────────────────────────────
  const secret = process.env.CRON_SECRET;
  if (REQUIRE_CRON_SECRET) {
    if (!secret) {
      console.error('[cron/mfa-factor-audit] CRON_SECRET is not set — refusing to run.');
      return NextResponse.json({ error: 'Cron secret not configured.' }, { status: 500 });
    }
    const expected    = `Bearer ${secret}`;
    const receivedHdr = req.headers.get('authorization') ?? '';
    const expectedBuf = Buffer.from(expected, 'utf8');
    const receivedBuf = Buffer.from(receivedHdr, 'utf8');
    const authValid =
      receivedBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(receivedBuf, expectedBuf);
    if (!authValid) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const startedAt = new Date();
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // ── 2. Live snapshot + previous state ────────────────────────────────
  const { data: snapRaw, error: snapErr } = await svc.rpc('mfa_factor_snapshot');
  if (snapErr) {
    console.error('[cron/mfa-factor-audit] snapshot failed', snapErr);
    return NextResponse.json({ error: snapErr.message }, { status: 500 });
  }
  const current: FactorSnapshotRow[] = (snapRaw ?? []).map((r: {
    factor_id: string; user_id: string; factor_type: string; status: string;
  }) => ({
    factor_id:   r.factor_id,
    user_id:     r.user_id,
    factor_type: r.factor_type,
    status:      r.status,
  }));

  const { data: prevRaw, error: prevErr } = await svc
    .from('mfa_factor_state')
    .select('factor_id, user_id, factor_type, status');
  if (prevErr) {
    console.error('[cron/mfa-factor-audit] state read failed', prevErr);
    return NextResponse.json({ error: prevErr.message }, { status: 500 });
  }
  const previous: FactorSnapshotRow[] = (prevRaw ?? []) as FactorSnapshotRow[];

  // ── 3. Diff and alert ────────────────────────────────────────────────
  const events = diffFactorSnapshots(previous, current);

  for (const ev of events) {
    const { error: logErr } = await svc.from('admin_audit_log').insert({
      actor_id:    null, // out-of-band: no in-app actor is known.
      entity_type: 'auth_factor',
      entity_id:   ev.userId,
      action:      ev.action,
      payload: {
        source:      'cron_diff',
        factor_id:   ev.factorId,
        factor_type: ev.factorType,
        from_status: ev.fromStatus,
        to_status:   ev.toStatus,
      },
    });
    if (logErr) {
      // Alertable but non-fatal — reconciliation below is skipped on any
      // failure so the change is re-detected next run rather than lost.
      console.error('[cron/mfa-factor-audit] ALERT failed to log factor change', {
        action: ev.action, userId: ev.userId, error: logErr.message,
      });
      return NextResponse.json({ error: 'audit insert failed', logged: false }, { status: 500 });
    }
  }

  // ── 4. Reconcile state to the live snapshot ──────────────────────────
  //       Only after every event is logged, so a mid-run failure leaves the
  //       change un-reconciled and it re-alerts next run (at worst a
  //       duplicate row — the safe direction).
  const nowIso = new Date().toISOString();
  if (events.length > 0 || previous.length !== current.length) {
    // Upsert every live factor; delete any the snapshot no longer has.
    if (current.length > 0) {
      const { error: upErr } = await svc.from('mfa_factor_state').upsert(
        current.map((r) => ({
          factor_id:   r.factor_id,
          user_id:     r.user_id,
          factor_type: r.factor_type,
          status:      r.status,
          last_seen:   nowIso,
        })),
        { onConflict: 'factor_id' },
      );
      if (upErr) console.error('[cron/mfa-factor-audit] state upsert failed', upErr);
    }
    const liveIds = new Set(current.map((r) => r.factor_id));
    const staleIds = previous.filter((r) => !liveIds.has(r.factor_id)).map((r) => r.factor_id);
    if (staleIds.length > 0) {
      const { error: delErr } = await svc.from('mfa_factor_state').delete().in('factor_id', staleIds);
      if (delErr) console.error('[cron/mfa-factor-audit] state prune failed', delErr);
    }
  }

  const finishedAt = new Date();
  const summary = {
    started_at:    startedAt.toISOString(),
    finished_at:   finishedAt.toISOString(),
    live_factors:  current.length,
    changes:       events.length,
    appeared:      events.filter((e) => e.action === 'mfa_factor_appeared').length,
    disappeared:   events.filter((e) => e.action === 'mfa_factor_disappeared').length,
    status_change: events.filter((e) => e.action === 'mfa_factor_status_changed').length,
  };

  const { error: recordErr } = await svc.from('cron_runs').insert({
    job_name:    'mfa-factor-audit',
    started_at:  startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    summary,
  });
  if (recordErr) console.error('[cron/mfa-factor-audit] failed to record run', recordErr);

  return NextResponse.json({ ok: true, ...summary });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}
