'use server';

import { headers } from 'next/headers';
import { isValidEmail } from '@/lib/validation/email';
import { normalizePhoneZA } from '@/lib/validation';
import { checkAndRecord as checkContactRate } from '@/lib/contact/contactRateLimit';
import { sendContactEnquiryEmail, type EnquirerKind } from '@/lib/email/templates/contactEnquiry';
import { SUPPORT_EMAIL } from '@/lib/config/contact';

// ─── Public contact enquiry — /contact form ──────────────────────────
//
// Called by an anonymous, unauthenticated visitor. Sends ONE email to the
// support mailbox with Reply-To set to the submitter. It writes NOTHING to
// the database: an enquiry is a message, not a record, and adding a table
// would mean RLS, retention and a surface to read it from — none of which
// this task needs.
//
// Modelled on app/practices/publicLeadAction.ts, which is the repo's
// existing public unauthenticated write path, and reuses the same three
// abuse controls in the same order.
//
// ─── ABUSE CONTROLS, IN ORDER ────────────────────────────────────────
//
//   1. HONEYPOT. A hidden `website` field. Filled → return ok:true and send
//      nothing. Looking successful is the point: a bot told it failed will
//      retry or mutate, whereas one told it succeeded goes away. Same field
//      name and same silent-success behaviour as the practices form, so the
//      two public surfaces cannot be told apart by probing them.
//
//   2. SERVER-SIDE VALIDATION, authoritative. The client validates too, for
//      the error messages, but nothing here trusts it: `required` attributes
//      and `type="email"` are absent the moment someone POSTs directly.
//
//   3. PER-IP RATE LIMIT, checked AFTER validation, so only a submission
//      that would otherwise be SENT spends a token. The reasoning for that
//      order is written out at the check itself; the short version is that
//      validation costs two regexes and a few trims, which is not worth
//      protecting with a budget a real person needs. See
//      lib/contact/contactRateLimit.ts for why it has its own bucket rather
//      than sharing the CRM one.
//
// Deliberately NOT added: a third-party captcha. It would be the first
// third-party script on the marketing surface, it sends visitor data to a
// vendor on a page whose whole job is publishing our own contact details,
// and this endpoint costs us one email rather than money. Flagged as
// available if the three layers above prove insufficient in practice.
//
// Also deliberately NOT added: a submit-timing check ("humans take >2s").
// /contact is a STATICALLY PRERENDERED route, so a server-issued nonce or
// timestamp would be baked in at build time and identical for every visitor
// — worthless as a freshness signal. Issuing it client-side instead just
// asks the bot to set a field, which it will. The honest options were a
// worthless check or making the page dynamic, and neither is worth it.
//
// ─── WHAT NEVER REACHES THE USER ─────────────────────────────────────
//
// No provider error, ever. Resend's failure strings are logged server-side
// and replaced with a fixed message. Precedent: a raw Resend error string
// once leaked onto a practice screen. The user-facing copy for a send
// failure also must not claim the message was sent — it says so plainly and
// points at the mailbox they can use directly.

/** Max lengths. Bound what a public form can push into an inbox we read. */
const MAX = {
  name:    120,
  email:   254,
  phone:    40,
  message: 2000,
} as const;

const KINDS: readonly EnquirerKind[] = ['patient', 'practice'];

export type ContactEnquiryFormInput = {
  kind:    string;
  name:    string;
  email:   string;
  phone:   string;
  message: string;
  /** Honeypot — hidden on the form, so a non-empty value means a bot. */
  website: string;
};

export type ContactEnquiryResult =
  | { ok: true }
  | {
      ok: false;
      error: 'rate_limited' | 'invalid' | 'send_failed';
      field?: 'kind' | 'name' | 'email' | 'phone' | 'message';
      message?: string;
    };

export async function submitContactEnquiry(
  input: ContactEnquiryFormInput,
): Promise<ContactEnquiryResult> {
  // ── 1. Honeypot — drop silently, look successful to the bot ──
  if (input.website && input.website.trim().length > 0) {
    return { ok: true };
  }

  // ── 2. Validation — server-authoritative ────────────────────
  const kindRaw = (input.kind ?? '').trim();
  const name    = (input.name  ?? '').trim().slice(0, MAX.name);
  const email   = (input.email ?? '').trim().toLowerCase().slice(0, MAX.email);
  const phone   = (input.phone ?? '').trim().slice(0, MAX.phone);
  const message = (input.message ?? '').trim().slice(0, MAX.message);

  if (!KINDS.includes(kindRaw as EnquirerKind)) {
    return { ok: false, error: 'invalid', field: 'kind', message: 'Let us know whether you are a patient or a practice.' };
  }
  const kind = kindRaw as EnquirerKind;

  if (!name) {
    return { ok: false, error: 'invalid', field: 'name', message: 'Please tell us your name.' };
  }
  // Email is REQUIRED, unlike the practices lead form where either a phone or
  // an email will do. Here it is the reply channel: Reply-To is the whole
  // mechanism that makes answering an enquiry work, so an enquiry without a
  // valid address is one we cannot answer.
  if (!isValidEmail(email)) {
    return { ok: false, error: 'invalid', field: 'email', message: 'Please enter an email address we can reply to.' };
  }
  // The phone is OPTIONAL — email already guarantees a reply path, and making
  // a second contact detail mandatory buys nothing. But if one IS given it
  // must be real, because a silently-wrong number is worse than a blank one.
  // Landlines allowed: a practice's switchboard is a perfectly good number.
  if (phone && !normalizePhoneZA(phone, { allowLandline: true })) {
    return { ok: false, error: 'invalid', field: 'phone', message: 'That does not look like a South African phone number.' };
  }
  if (!message) {
    return { ok: false, error: 'invalid', field: 'message', message: 'Please add a short message so we know how to help.' };
  }

  const phoneNormalised = phone
    ? normalizePhoneZA(phone, { allowLandline: true }) ?? phone
    : '';

  // ── 3. Rate limit per IP — AFTER validation, deliberately ───
  //
  // A token is spent only by a submission that would otherwise be SENT.
  //
  // This used to run before validation, on the reasoning that validating
  // first lets an attacker burn CPU on unlimited malformed payloads. That
  // reasoning does not survive looking at what validation actually costs:
  // a handful of trims, length caps and two regexes. No database call, no
  // email, no crypto. There is nothing there worth protecting with a
  // budget that a real person needs.
  //
  // And the old order had a genuine victim. Someone fumbling the form —
  // a mistyped email three times, a message they forgot to write twice —
  // spent all five tokens without ever sending anything, and was then
  // locked out for an hour having never once succeeded. That is a worse
  // outcome than the CPU it was protecting.
  //
  // The honeypot still runs FIRST and still spends nothing, so a bot
  // cannot drain the budget of a real visitor sharing its IP (CGNAT, a
  // practice's office NAT). That ordering is load-bearing and pinned.
  const h  = await headers();
  const ip = (h.get('x-forwarded-for') ?? '').split(',')[0].trim()
          || h.get('x-real-ip')
          || 'anon';
  if (!checkContactRate(ip)) {
    return {
      ok: false,
      error: 'rate_limited',
      // Routes to the mailbox as well as asking them to wait: someone who
      // has hit the limit still has something to say, and the left column
      // of the page already shows this address.
      message: `You've sent a few messages in a short time — please try again shortly, or email us directly at ${SUPPORT_EMAIL}.`,
    };
  }

  // ── 4. Send. One email, to support, Reply-To the submitter ──
  const sent = await sendContactEnquiryEmail({
    kind,
    name,
    email,
    phone: phoneNormalised,
    message,
  });

  if (!sent.ok) {
    // The provider string stays HERE. It is the operator's diagnostic, and
    // it is exactly the kind of value that has leaked to a user before.
    console.error('[submitContactEnquiry] send failed', { error: sent.error });
    return {
      ok: false,
      error: 'send_failed',
      // Says plainly that it did NOT send, and gives a route that does not
      // depend on the thing that just broke.
      message: `We could not send your message just now — nothing was sent. Please email us directly at ${SUPPORT_EMAIL}.`,
    };
  }

  return { ok: true };
}
