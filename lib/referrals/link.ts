// ─── The share link, and the one query parameter it carries ───────────────
//
// A referral link is the app's front door with a code hung off it:
//
//     https://app.betternow.co.za/?ref=A2C4K9PT
//
// The parameter is read by the proxy (proxy.ts), stashed in a cookie, and
// spent at the first authenticated request. Nothing downstream of that reads
// the query string, so this file is the only place the parameter's NAME is
// written — the proxy imports it from here rather than matching a literal.
//
// ─── WHY THE LANDING PAGE AND NOT /signup ────────────────────────────────
//
// A referred arrival is a cold visitor. They have been told "this is how I
// pay my doctor over three months" by someone they trust and they know
// nothing else; dropping them straight onto a signup form asks for an email
// address before answering the question they actually have. The landing page
// answers it, and the code survives the hop to signup because it is in a
// cookie by then, not in the URL.
//
// It also means the link is safe to share into a group chat: it goes
// somewhere sensible for a person who is not going to sign up today.

import { REFERRAL_CODE_PATTERN } from './code';

/** The query parameter. Short because it is typed and forwarded by people. */
export const REFERRAL_QUERY_PARAM = 'ref';

/**
 * Build the shareable link for a code.
 *
 * `origin` is passed in rather than read from the environment because the two
 * callers know different things: the server action has NEXT_PUBLIC_APP_URL,
 * and the browser has window.location.origin — which is the correct answer on
 * a preview deployment, where the env var points at production. Reading the
 * env var here would silently hand preview testers a production link.
 *
 * A trailing slash on the origin is tolerated; anything else about it is the
 * caller's problem, because a malformed origin is a configuration failure and
 * papering over it here would hide it.
 */
export function referralLink(code: string, origin: string): string {
  const base = origin.replace(/\/+$/, '');
  return `${base}/?${REFERRAL_QUERY_PARAM}=${encodeURIComponent(code)}`;
}

/**
 * Read a code out of a URL's search params.
 *
 * Returns the RAW value, not a normalised code — normalisation belongs to
 * `normaliseReferralCode`, and this function must not decide what is valid.
 * It only refuses values that cannot be a code at all, so a hostile query
 * string cannot push arbitrary text into a cookie: the length cap and the
 * character class are the whole point of doing anything here.
 */
export function readReferralParam(params: URLSearchParams): string | null {
  const raw = params.get(REFERRAL_QUERY_PARAM);
  if (!raw) return null;
  const candidate = raw.trim().toUpperCase();
  return REFERRAL_CODE_PATTERN.test(candidate) ? candidate : null;
}

/**
 * The message a patient sends.
 *
 * Written here, once, so the share sheet, the copy button and the email
 * invitation cannot drift into three different pitches — and so a change to
 * what we claim is a change to one string that a reviewer can see.
 *
 * Note what it does NOT say: nothing about a reward, a bonus, a discount or
 * a credit. There is no incentive programme (docs/REFERRALS.md), so promising
 * one in the message a customer forwards to their friends would be a promise
 * the platform cannot keep — and the message is the part that gets
 * screenshotted.
 */
export function referralShareMessage(link: string): string {
  return 'I use betternow to split my medical bills into interest-free '
    + `instalments. Have a look: ${link}`;
}

// ─── Named channels, for browsers with no share sheet ────────────────────
//
// `navigator.share` opens the operating system's own sheet and is the right
// answer wherever it exists — it offers every app the person actually has,
// including the ones we would never think to list. It does not exist on
// desktop Firefox, on desktop Chrome without the OS integration, or in any
// embedded webview that has not opted in, which is a large share of the
// people who will open this screen on a laptop.
//
// So the named channels below are not a nicety, they are the whole feature on
// those browsers. They are plain links rather than script: a link is not
// blocked by a popup blocker, works with a long-press or middle-click, and
// carries no CSP question (`form-action 'self'` governs form submissions, not
// navigations).
//
// WhatsApp and email are the two named, in that order, because this is South
// Africa: WhatsApp is the default way people send anything to anyone here,
// and email is the fallback that exists on every device. SMS is deliberately
// NOT a fourth button — the URI scheme takes a different separator on iOS
// (`sms:&body=`) and Android (`sms:?body=`), so a single href is wrong on one
// of the two platforms, and both of those platforms have the share sheet
// anyway, which offers Messages properly.

/**
 * WhatsApp's own "share to a chat you pick" entry point.
 *
 * `wa.me` with no number is the documented form for that — it opens the
 * contact picker rather than a conversation, which is what a share is. On a
 * phone the link hands off to the installed app; on a laptop it lands on
 * WhatsApp Web.
 */
export function whatsappShareUrl(message: string): string {
  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}

/** The subject line on the email channel. Not a promise, like the message. */
export const REFERRAL_EMAIL_SUBJECT = 'betternow — pay medical bills in instalments';

/**
 * A pre-filled mail draft with no recipient — the person picks that.
 *
 * This is the customer's OWN mail client with words in it, sent from their
 * address, to a recipient they choose. Nothing is sent from us and nothing is
 * recorded when they tap it: the referral is attributed by the code in the
 * link when the friend arrives, like any other share.
 *
 * The screen once also had an action that emailed an invitation FROM us and
 * recorded the referral before anybody clicked. It was removed with the form
 * behind it (docs/REFERRALS.md §1); this is now the only email path on the
 * friend side, and it is the customer's own.
 */
export function emailShareUrl(message: string): string {
  const subject = encodeURIComponent(REFERRAL_EMAIL_SUBJECT);
  return `mailto:?subject=${subject}&body=${encodeURIComponent(message)}`;
}
