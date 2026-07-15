import type { SupabaseClient } from '@supabase/supabase-js';

// ─── saveCardForPatient (Peach flavour) ─────────────────────────────
//
// Given the card + registrationId Peach returned on a successful CIT
// checkout (or on a standalone registration-only checkout), persist a
// payment_methods row for the patient. Idempotent and race-safe —
// mirrors the Paystack helper's semantics so callers see the same
// SaveCardResult shape.
//
// Peach doesn't expose a canonical card fingerprint the way Paystack
// did (`auth.signature`). We synthesise one from
//   ${brand}_${last4}_${expiryMonth}${expiryYear}
// which is stable per physical card until the issuer reissues, and
// used only for dedup — the source of truth for the reusable token is
// `payment_methods.token` (holding the Peach registrationId).

export type PeachCardOnFile = {
  registrationId: string;
  brand:          string | null;
  last4:          string | null;
  expiryMonth:    number | null;
  expiryYear:     number | null;
  holder:         string | null;
};

export type SaveCardResult =
  | { kind: 'inserted';      cardId: string }
  | { kind: 'updated';       cardId: string }
  | { kind: 'already_saved'; cardId: string }
  | { kind: 'error';         message: string };

/** Pure — build the synthetic fingerprint that dedup keys off. */
export function fingerprintForCard(input: {
  brand:       string | null | undefined;
  last4:       string | null | undefined;
  expiryMonth: number | null | undefined;
  expiryYear:  number | null | undefined;
}): string | null {
  const brand = (input.brand ?? '').trim().toUpperCase();
  const last4 = (input.last4 ?? '').trim();
  const mm    = input.expiryMonth ?? 0;
  const yy    = input.expiryYear  ?? 0;
  if (!brand || !/^\d{4}$/.test(last4) || mm < 1 || mm > 12 || yy < 2000) return null;
  const mmS = mm.toString().padStart(2, '0');
  const yyS = yy.toString();
  return `peach:${brand}:${last4}:${mmS}${yyS}`;
}

export type CardSaveAction =
  | { action: 'already_saved'; cardId: string }
  | { action: 'update';        cardId: string }
  | { action: 'insert';        isFirst: boolean };

export function chooseCardSaveAction(
  existing:      { id: string; token: string } | null,
  isFirst:       boolean,
  registrationId: string,
): CardSaveAction {
  if (existing && existing.token === registrationId) {
    return { action: 'already_saved', cardId: existing.id };
  }
  if (existing) {
    return { action: 'update', cardId: existing.id };
  }
  return { action: 'insert', isFirst };
}

export async function saveCardForPatient(
  patientId: string,
  card:      PeachCardOnFile,
  supabase:  SupabaseClient,
): Promise<SaveCardResult> {
  if (!card.registrationId) {
    return { kind: 'error', message: 'Peach card is missing registrationId.' };
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('first_name, last_name')
    .eq('id', patientId)
    .single();

  const cardholderName = profile
    ? `${profile.first_name} ${profile.last_name}`.trim()
    : (card.holder ?? '');

  const { count } = await supabase
    .from('payment_methods')
    .select('id', { count: 'exact', head: true })
    .eq('patient_id', patientId);
  const isFirst = (count ?? 0) === 0;

  const signature = fingerprintForCard({
    brand:       card.brand,
    last4:       card.last4,
    expiryMonth: card.expiryMonth,
    expiryYear:  card.expiryYear,
  });

  // ── Fingerprint path: dedup possible ────────────────────────────────
  if (signature) {
    const { data: existing } = await supabase
      .from('payment_methods')
      .select('id, token')
      .eq('patient_id', patientId)
      .eq('signature', signature)
      .maybeSingle();

    const action = chooseCardSaveAction(existing as { id: string; token: string } | null, isFirst, card.registrationId);

    if (action.action === 'already_saved') {
      return { kind: 'already_saved', cardId: action.cardId };
    }

    if (action.action === 'update') {
      // Token refresh via the same RPC as the Paystack path — the RPC
      // (migration 0041) updates the payment_methods row + repoints
      // active plans whose stored token differs. The RPC's parameters
      // are provider-neutral (p_token is any string), so no schema
      // change is required.
      const { error } = await supabase.rpc('refresh_card_token', {
        p_card_id:      action.cardId,
        p_token:        card.registrationId,
        p_brand:        card.brand ?? 'Card',
        p_last_four:    card.last4 ?? '0000',
        p_expiry_month: card.expiryMonth ?? 0,
        p_expiry_year:  card.expiryYear  ?? 0,
      });
      if (error) return { kind: 'error', message: error.message };
      return { kind: 'updated', cardId: action.cardId };
    }

    // INSERT, race-protected against concurrent webhook + return-route.
    const { data: inserted, error: insertErr } = await supabase
      .from('payment_methods')
      .insert({
        patient_id:      patientId,
        card_brand:      card.brand ?? 'Card',
        last_four:       card.last4 ?? '0000',
        expiry_month:    card.expiryMonth ?? 0,
        expiry_year:     card.expiryYear  ?? 0,
        cardholder_name: cardholderName,
        token:           card.registrationId,
        signature,
        reusable:        true,
        is_default:      isFirst,
      })
      .select('id')
      .single();

    if (insertErr) {
      if ((insertErr as { code?: string }).code === '23505') {
        const { data: now } = await supabase
          .from('payment_methods')
          .select('id')
          .eq('patient_id', patientId)
          .eq('signature', signature)
          .maybeSingle();
        if (now) return { kind: 'already_saved', cardId: now.id as string };
      }
      return { kind: 'error', message: insertErr.message };
    }
    return { kind: 'inserted', cardId: inserted.id as string };
  }

  // ── No-fingerprint path: fall back to plain insert without dedup ────
  const { data: inserted, error } = await supabase
    .from('payment_methods')
    .insert({
      patient_id:      patientId,
      card_brand:      card.brand ?? 'Card',
      last_four:       card.last4 ?? '0000',
      expiry_month:    card.expiryMonth ?? 0,
      expiry_year:     card.expiryYear  ?? 0,
      cardholder_name: cardholderName,
      token:           card.registrationId,
      signature:       null,
      reusable:        true,
      is_default:      isFirst,
    })
    .select('id')
    .single();

  if (error) return { kind: 'error', message: error.message };
  return { kind: 'inserted', cardId: inserted.id as string };
}
