/**
 * Backfill check — finds any active / pending-first-payment plan whose
 * stored Paystack authorization_code DOES NOT match its patient's
 * current default card's token. Pure read; reports findings, never
 * writes. Decide on the backfill (manual SQL UPDATE, the
 * change_default_card RPC per patient, or leave alone) after seeing the
 * counts.
 *
 * Usage:
 *   pnpm tsx --env-file=.env.local scripts/audit-card-default-mismatch.ts
 *
 * Requires:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   (server key — bypasses RLS)
 */

import { createClient } from '@supabase/supabase-js';

const URL  = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL || !KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local.');
  process.exit(1);
}

const supabase = createClient(URL, KEY, { auth: { persistSession: false } });

type Plan = {
  id:                          string;
  invoice_number:              string | null;
  patient_id:                  string;
  status:                      string;
  peach_registration_id: string | null;
};

type Card = {
  patient_id: string;
  token:      string;
  last_four:  string;
};

async function main() {
  console.log('\n[audit] Scanning active / pending plans for default-card mismatches…\n');

  const { data: plans, error: planErr } = await supabase
    .from('plans')
    .select('id, invoice_number, patient_id, status, peach_registration_id')
    .in('status', ['active', 'pending_first_payment'])
    .not('peach_registration_id', 'is', null);

  if (planErr) {
    console.error('[audit] Failed to load plans:', planErr.message);
    process.exit(1);
  }

  if (!plans || plans.length === 0) {
    console.log('No active / pending plans with a stored auth code.');
    process.exit(0);
  }

  const patientIds = [...new Set((plans as Plan[]).map((p) => p.patient_id))];

  const { data: defaults, error: cardErr } = await supabase
    .from('payment_methods')
    .select('patient_id, token, last_four')
    .in('patient_id', patientIds)
    .eq('is_default', true);

  if (cardErr) {
    console.error('[audit] Failed to load default cards:', cardErr.message);
    process.exit(1);
  }

  const defaultByPatient = new Map<string, Card>();
  for (const c of (defaults ?? []) as Card[]) defaultByPatient.set(c.patient_id, c);

  // ── Classify findings ─────────────────────────────────────────────────
  const noDefault:       Plan[] = [];
  const mismatch:        Plan[] = [];
  const matchesDefault:  Plan[] = [];

  for (const p of plans as Plan[]) {
    const def = defaultByPatient.get(p.patient_id);
    if (!def)                                       noDefault.push(p);
    else if (def.token !== p.peach_registration_id) mismatch.push(p);
    else                                            matchesDefault.push(p);
  }

  // ── Report ────────────────────────────────────────────────────────────
  console.log(`Scanned ${plans.length} active / pending plans across ${patientIds.length} patients.`);
  console.log(`  ✓ matching default      : ${matchesDefault.length}`);
  console.log(`  ⚠ patient has NO default: ${noDefault.length}`);
  console.log(`  ⚠ mismatched token      : ${mismatch.length}`);
  console.log('');

  if (mismatch.length > 0) {
    console.log('── MISMATCHED PLANS ───────────────────────────────────────────────');
    for (const p of mismatch) {
      const def = defaultByPatient.get(p.patient_id);
      console.log(
        `  ${p.invoice_number ?? p.id.slice(0, 8)}  patient=${p.patient_id.slice(0, 8)}…  ` +
        `status=${p.status}  default_last4=${def?.last_four ?? '?'}  ` +
        `plan_token=${(p.peach_registration_id ?? '').slice(0, 12)}…`,
      );
    }
    console.log('');
  }

  if (noDefault.length > 0) {
    console.log('── PLANS WHOSE PATIENT HAS NO DEFAULT CARD ────────────────────────');
    for (const p of noDefault) {
      console.log(
        `  ${p.invoice_number ?? p.id.slice(0, 8)}  patient=${p.patient_id.slice(0, 8)}…  ` +
        `status=${p.status}  plan_token=${(p.peach_registration_id ?? '').slice(0, 12)}…`,
      );
    }
    console.log('');
  }

  if (mismatch.length === 0 && noDefault.length === 0) {
    console.log('✓ Invariant already holds — every active/pending plan matches its patient\'s default card.\n');
  } else {
    console.log('Report only — no rows have been changed. Decide on a backfill strategy before remediating.\n');
  }
}

main().catch((err) => {
  console.error('[audit] Uncaught error:', err);
  process.exit(1);
});
