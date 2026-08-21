'use server';

import { createClient } from '@/lib/supabase/server';
import { checkAndRecord as checkContactRate } from '@/lib/contact/contactRateLimit';
import { sendContactEnquiryEmail } from '@/lib/email/templates/contactEnquiry';
import { decryptIdForDisplay } from '@/lib/idEncryption';
import { maskSaId } from '@/lib/saIdMask';
import { SUPPORT_EMAIL } from '@/lib/config/contact';

// ─── Patient contact enquiry — /patient/account/contact ─────────────────
//
// The signed-in counterpart to app/contact/contactAction.ts. That form asks
// an anonymous visitor to type their own name, email and phone; this one
// does not ask, because it does not need to — the caller is authenticated,
// so name/email/phone/ID are read from THEIR OWN profile server-side and
// never accepted as input. There is nothing here for a client to spoof: the
// only thing the client contributes is `message`.
//
// Reuses sendContactEnquiryEmail (same inbox, same template) with
// verified: true, which is what tells a support reader these fields are
// trustworthy rather than typed — see that file's header.
//
// Rate-limited by ACCOUNT id, not IP — reusing the public form's bucket
// function (it just takes a string key) rather than a new abstraction. A
// signed-in patient could otherwise bypass the public form's per-IP limit
// by hopping networks; keying on their own id closes that without touching
// the public bucket at all.

const MAX_MESSAGE = 2000;

export type PatientContactResult =
  | { ok: true }
  | {
      ok: false;
      error: 'not_authenticated' | 'rate_limited' | 'invalid' | 'send_failed';
      message?: string;
    };

export async function submitPatientContactEnquiry(rawMessage: string): Promise<PatientContactResult> {
  // A server action is its OWN request, separate from the one that
  // rendered ./page.tsx — same reasoning app/patient/account/actions.ts
  // and every other action module here already follows (see
  // lib/auth/requestUser.ts's header on why the request-scoped memo is
  // deliberately NOT used in server actions: there is no sibling render to
  // share the round trip with).
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: 'not_authenticated', message: 'Please sign in and try again.' };
  }

  const message = (rawMessage ?? '').trim().slice(0, MAX_MESSAGE);
  if (!message) {
    return { ok: false, error: 'invalid', message: 'Please add a short message so we know how to help.' };
  }

  // Same defence-in-depth order as the public form: nothing DB-costly runs
  // before this, so a token is only spent on a message that would actually
  // be sent.
  if (!checkContactRate(`patient:${user.id}`)) {
    return {
      ok: false,
      error: 'rate_limited',
      message: `You've sent a few messages in a short time — please try again shortly, or email us directly at ${SUPPORT_EMAIL}.`,
    };
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('first_name, last_name, phone, sa_id_number')
    .eq('id', user.id)
    .single();

  const name  = [profile?.first_name, profile?.last_name].filter(Boolean).join(' ').trim() || 'betternow patient';
  const email = user.email ?? '';
  const phone = (profile?.phone as string | null) ?? '';

  if (!email) {
    // Shouldn't happen for a confirmed patient account, but the send call
    // and its Reply-To both depend on having one.
    return { ok: false, error: 'invalid', message: `We could not find an email address on your account. Please email us directly at ${SUPPORT_EMAIL}.` };
  }

  const decryptedSaId = decryptIdForDisplay(profile?.sa_id_number as string | null | undefined);
  const patientRef    = decryptedSaId ? maskSaId(decryptedSaId) : null;

  const sent = await sendContactEnquiryEmail({
    kind: 'patient',
    name,
    email,
    phone,
    message,
    verified:   true,
    patientRef,
  });

  if (!sent.ok) {
    console.error('[submitPatientContactEnquiry] send failed', { error: sent.error });
    return {
      ok: false,
      error: 'send_failed',
      message: `We could not send your message just now — nothing was sent. Please email us directly at ${SUPPORT_EMAIL}.`,
    };
  }

  return { ok: true };
}
