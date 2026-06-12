import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Subset of Paystack's `authorization` payload we rely on. Both the
 * webhook's `charge.success` event and the callback's
 * `/transaction/verify` response surface this shape.
 */
export type PaystackAuthorization = {
  authorization_code: string;
  signature?:         string | null;
  brand?:             string;
  last4?:             string;
  exp_month?:         string | number;
  exp_year?:          string | number;
  account_name?:      string;
};

/**
 * Outcome of attempting to save a card. Lets callers (webhook handler +
 * the callback verify page) branch on what actually happened rather
 * than infer from side effects.
 *
 *   inserted      → brand-new row written
 *   updated       → same signature was on file; token was refreshed
 *   already_saved → same signature AND same token; nothing changed
 *   error         → bailed out cleanly with a message
 */
export type SaveCardResult =
  | { kind: 'inserted';      cardId: string }
  | { kind: 'updated';       cardId: string }
  | { kind: 'already_saved'; cardId: string }
  | { kind: 'error';         message: string };

/**
 * Decide which action to take for a card-save attempt. Pure — easy to
 * test without faking a Supabase client.
 *
 *   • existing with same token   → already_saved (idempotent no-op)
 *   • existing with newer token  → update         (Paystack reissued)
 *   • no existing row            → insert         (fresh card OR previously removed)
 */
export type CardSaveAction =
  | { action: 'already_saved'; cardId: string }
  | { action: 'update';        cardId: string }
  | { action: 'insert';        isFirst: boolean };

export function chooseCardSaveAction(
  existing: { id: string; token: string } | null,
  isFirst:  boolean,
  authCode: string,
): CardSaveAction {
  if (existing && existing.token === authCode) {
    return { action: 'already_saved', cardId: existing.id };
  }
  if (existing) {
    return { action: 'update', cardId: existing.id };
  }
  return { action: 'insert', isFirst };
}

/**
 * Save (or update, or recognise as already saved) a Paystack-authorised
 * card on the patient's profile. Idempotent and race-safe — if a
 * concurrent writer (typically the webhook hitting at the same time as
 * the callback verify) wins the INSERT, we re-read and report
 * `already_saved` instead of surfacing the unique-violation.
 *
 * Caller must pass a service-role Supabase client (RLS would otherwise
 * block the count() and the insert from non-owner contexts).
 */
export async function saveCardForPatient(
  patientId: string,
  auth:      PaystackAuthorization,
  supabase:  SupabaseClient,
): Promise<SaveCardResult> {
  if (!auth.authorization_code) {
    return { kind: 'error', message: 'Paystack authorization is missing authorization_code.' };
  }

  const authCode      = auth.authorization_code;
  const cardSignature = auth.signature ?? null;

  const { data: profile } = await supabase
    .from('profiles')
    .select('first_name, last_name')
    .eq('id', patientId)
    .single();

  const cardholderName = profile
    ? `${profile.first_name} ${profile.last_name}`.trim()
    : (auth.account_name ?? '');

  // The first card a patient adds becomes the default. Subsequent adds
  // do not change is_default — it's flipped explicitly via the
  // change_default_card RPC.
  const { count } = await supabase
    .from('payment_methods')
    .select('id', { count: 'exact', head: true })
    .eq('patient_id', patientId);
  const isFirst = (count ?? 0) === 0;

  // ── Signature path: dedup is possible ───────────────────────────────
  if (cardSignature) {
    const { data: existing } = await supabase
      .from('payment_methods')
      .select('id, token')
      .eq('patient_id', patientId)
      .eq('signature', cardSignature)
      .maybeSingle();

    const action = chooseCardSaveAction(existing as { id: string; token: string } | null, isFirst, authCode);

    if (action.action === 'already_saved') {
      return { kind: 'already_saved', cardId: action.cardId };
    }

    if (action.action === 'update') {
      // Token refresh — Paystack reissued an authorization_code for a
      // card whose signature is already on file. Route through the
      // refresh_card_token RPC (migration 0040), which atomically
      //   1) UPDATEs the payment_methods row (token + display fields,
      //      preserving is_default)
      //   2) if the card is the patient's default, repoints every
      //      active / pending plan whose stored token isn't already
      //      the new value (same IS DISTINCT FROM predicate as
      //      change_default_card), and writes a 'token_refreshed'
      //      plan_events row per repointed plan.
      // All inside one function-scoped transaction — drift can never
      // persist past this point.
      const { error } = await supabase.rpc('refresh_card_token', {
        p_card_id:      action.cardId,
        p_token:        authCode,
        p_brand:        auth.brand ?? 'Card',
        p_last_four:    auth.last4 ?? '0000',
        p_expiry_month: Number(auth.exp_month ?? 0),
        p_expiry_year:  Number(auth.exp_year  ?? 0),
      });
      if (error) return { kind: 'error', message: error.message };
      return { kind: 'updated', cardId: action.cardId };
    }

    // INSERT, race-protected.
    const { data: inserted, error: insertErr } = await supabase
      .from('payment_methods')
      .insert({
        patient_id:      patientId,
        card_brand:      auth.brand ?? 'Card',
        last_four:       auth.last4 ?? '0000',
        expiry_month:    Number(auth.exp_month ?? 0),
        expiry_year:     Number(auth.exp_year  ?? 0),
        cardholder_name: cardholderName,
        token:           authCode,
        signature:       cardSignature,
        reusable:        true,
        is_default:      isFirst,
      })
      .select('id')
      .single();

    if (insertErr) {
      // Postgres unique-violation: a concurrent writer (typically the
      // webhook firing in parallel with our verify path) wrote the same
      // (patient_id, signature) row first. Re-read and treat the result
      // as "already saved" — both call sites are trying to record the
      // same physical card.
      if ((insertErr as { code?: string }).code === '23505') {
        const { data: now } = await supabase
          .from('payment_methods')
          .select('id')
          .eq('patient_id', patientId)
          .eq('signature', cardSignature)
          .maybeSingle();
        if (now) return { kind: 'already_saved', cardId: now.id as string };
      }
      return { kind: 'error', message: insertErr.message };
    }
    return { kind: 'inserted', cardId: inserted.id as string };
  }

  // ── No-signature path: rare; dedup not possible ─────────────────────
  const { data: inserted, error } = await supabase
    .from('payment_methods')
    .insert({
      patient_id:      patientId,
      card_brand:      auth.brand ?? 'Card',
      last_four:       auth.last4 ?? '0000',
      expiry_month:    Number(auth.exp_month ?? 0),
      expiry_year:     Number(auth.exp_year  ?? 0),
      cardholder_name: cardholderName,
      token:           authCode,
      signature:       null,
      reusable:        true,
      is_default:      isFirst,
    })
    .select('id')
    .single();

  if (error) return { kind: 'error', message: error.message };
  return { kind: 'inserted', cardId: inserted.id as string };
}
