'use client';

import { useState, useSyncExternalStore } from 'react';
import { referralLink, referralShareMessage } from '@/lib/referrals/link';

// ─── The code, the link, and the two ways to pass it on ───────────────────
//
// A client component because all three of its jobs are browser jobs:
// window.location.origin, navigator.clipboard and navigator.share. The code
// itself comes from the server as a prop — nothing here mints, validates or
// interprets it.
//
// ─── WHY THE ORIGIN COMES FROM THE BROWSER ───────────────────────────────
//
// The server has NEXT_PUBLIC_APP_URL, which on a preview deployment points at
// production. A tester on a preview build would copy a production link, share
// it, and the referral would be attributed on a different environment. The
// browser's own origin is the only correct answer to "what URL is this person
// looking at", so the link is built here after mount.
//
// Which means the link is EMPTY on the server render and until hydration.
// That is why the code — which does not depend on the origin — is the primary
// object on this card and the link is secondary: the thing a person can read
// aloud is present immediately, and the copy button enables when it has
// something to copy.
//
// Read through useSyncExternalStore rather than a useEffect + setState pair.
// Both browser-only values here (the origin, and whether this browser has a
// share sheet) are constants for the life of the page, so an effect would be
// a cascading render for a value that will never change again — and React's
// own answer for "render a value that only exists on the client, without a
// hydration mismatch" is this hook, with a server snapshot that says so.
//
// ─── NO REWARD COPY ──────────────────────────────────────────────────────
//
// There is no incentive programme (docs/REFERRALS.md), so this card explains
// what happens and promises nothing. The temptation is a line like "earn R100
// when they pay their first instalment"; writing it before the policy exists
// is how a screenshot becomes a commitment.

/** Neither value ever changes, so there is nothing to subscribe to. */
const noSubscription = () => () => {};

export default function ReferralShareCard({ code }: { code: string }) {
  const [copied, setCopied] = useState<'link' | 'code' | null>(null);

  const origin = useSyncExternalStore(
    noSubscription,
    () => window.location.origin,
    () => null,                       // server: there is no origin to know
  );
  const canShare = useSyncExternalStore(
    noSubscription,
    () => typeof navigator.share === 'function',
    () => false,                      // server: assume no share sheet
  );

  const link = origin ? referralLink(code, origin) : null;

  async function copy(what: 'link' | 'code', value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      // Cleared on a timer rather than on blur: the confirmation is the only
      // feedback a copy gives, and it has to outlive the tap.
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Clipboard permission refused, or an insecure origin. The code is on
      // screen and selectable, so there is nothing useful to say — an error
      // toast here would be noise about a fallback the user already has.
    }
  }

  async function share() {
    if (!link) return;
    try {
      await navigator.share({ text: referralShareMessage(link), url: link });
    } catch {
      // Includes the user simply dismissing the share sheet, which is not a
      // failure and must not be reported as one.
    }
  }

  return (
    <section
      className="rounded-card bg-white p-[18px]"
      style={{ border: '1px solid rgba(19,41,75,.06)', boxShadow: '0 2px 6px -2px rgba(15,31,58,.07)' }}
      data-testid="referral-share-card"
    >
      <p
        className="text-[11px] font-semibold uppercase"
        style={{ letterSpacing: '.14em', color: 'rgba(19,41,75,.45)' }}
      >
        Your referral code
      </p>

      <p
        className="mt-2 font-mono text-[26px] font-bold tabular-nums"
        style={{ color: 'var(--portal-ink)', letterSpacing: '.12em' }}
        data-testid="referral-code"
      >
        {code}
      </p>

      <p className="mt-2 text-[13px] leading-[1.55]" style={{ color: 'var(--portal-muted)' }}>
        Share this code or your link. When someone opens it and creates an account,
        we&rsquo;ll show them here as one of your referrals.
      </p>

      <div className="mt-[14px] flex flex-col gap-2">
        <button
          type="button"
          onClick={() => link && copy('link', link)}
          disabled={!link}
          data-testid="referral-copy-link"
          className="w-full rounded-tile py-[13px] text-[14.5px] font-semibold text-white disabled:opacity-60"
          style={{ background: 'var(--portal-ink)' }}
        >
          {copied === 'link' ? 'Link copied' : 'Copy my link'}
        </button>

        {canShare && (
          <button
            type="button"
            onClick={share}
            disabled={!link}
            data-testid="referral-share"
            className="w-full rounded-tile py-[13px] text-[14.5px] font-semibold disabled:opacity-60"
            style={{ border: '1px solid var(--portal-line)', color: 'var(--portal-ink)' }}
          >
            Share
          </button>
        )}

        <button
          type="button"
          onClick={() => copy('code', code)}
          data-testid="referral-copy-code"
          className="w-full py-1 text-[13px] font-semibold underline underline-offset-2"
          style={{ color: 'var(--portal-accent-ink)' }}
        >
          {copied === 'code' ? 'Code copied' : 'Copy the code instead'}
        </button>
      </div>
    </section>
  );
}
