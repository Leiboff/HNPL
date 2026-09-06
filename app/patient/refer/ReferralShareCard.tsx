'use client';

import { useState, useSyncExternalStore } from 'react';
import {
  referralLink,
  referralShareMessage,
  whatsappShareUrl,
  emailShareUrl,
} from '@/lib/referrals/link';

// ─── The code, the link, and every way to pass it on ─────────────────────
//
// A client component because all of its jobs are browser jobs:
// window.location.origin, navigator.share and navigator.clipboard. The code
// itself comes from the server as a prop — nothing here mints, validates or
// interprets it.
//
// ─── TWO LAYERS OF SHARING, AND WHY BOTH ─────────────────────────────────
//
//   1. The SHARE SHEET. `navigator.share` opens the operating system's own
//      picker: WhatsApp, Messages, Signal, Telegram, Gmail, AirDrop, whatever
//      this person actually has. It is the right answer wherever it exists,
//      because it offers apps we would never think to list and it is the
//      gesture people already know from every other app.
//
//   2. NAMED CHANNELS. WhatsApp, email, copy — always rendered, never hidden
//      behind the sheet. On desktop Firefox, desktop Chrome without OS
//      integration, and plenty of embedded webviews there IS no share sheet,
//      and a screen whose only affordance is a button that silently does
//      nothing is worse than no button. See lib/referrals/link.ts for why
//      those two channels and not a third.
//
// So the primary button is Share where a sheet exists and is simply absent
// where one does not — the row of named channels below carries the feature on
// its own in that case, rather than being a fallback that appears in an empty
// space.
//
// ─── WHY THE ORIGIN COMES FROM THE BROWSER ───────────────────────────────
//
// The server has NEXT_PUBLIC_APP_URL, which on a preview deployment points at
// production. A tester on a preview build would copy a production link, share
// it, and the referral would be attributed on a different environment. The
// browser's own origin is the only correct answer to "what URL is this person
// looking at", so the link is built here.
//
// Which means the link is EMPTY on the server render and until hydration.
// That is why the code — which does not depend on the origin — is the primary
// object on this card: the thing a person can read aloud is present
// immediately, and the share affordances enable when they have something to
// share.
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
// is how a screenshot becomes a commitment. The shared MESSAGE is built by
// referralShareMessage() for the same reason — one string, reviewable once,
// rather than a different pitch per channel.

/** Neither browser value ever changes, so there is nothing to subscribe to. */
const noSubscription = () => () => {};

const ICON = {
  share: (
    <>
      <path d="M12 15V4M12 4 8.5 7.5M12 4l3.5 3.5" />
      <path d="M5 12.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5.5" />
    </>
  ),
  whatsapp: (
    <>
      <path d="M3.5 20.5 5 16.4A8 8 0 1 1 8.1 19.4Z" />
      <path d="M9 9.2c0 3 2.4 5.2 5 5.6l.9-1.4 1.7.8c-.4 1-1.3 1.5-2.3 1.4a7.6 7.6 0 0 1-6.6-6.5c-.1-1 .4-1.9 1.3-2.3l.9 1.7Z" />
    </>
  ),
  email: (
    <>
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <path d="m3.5 7 8.5 6 8.5-6" />
    </>
  ),
  copy: (
    <>
      <rect x="8.5" y="8.5" width="12" height="12" rx="2.5" />
      <path d="M15.5 5.5h-9a2 2 0 0 0-2 2v9" />
    </>
  ),
} as const;

function Glyph({ name }: { name: keyof typeof ICON }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-none"
    >
      {ICON[name]}
    </svg>
  );
}

const CHANNEL_CLASS =
  'flex flex-1 items-center justify-center gap-2 rounded-tile py-[11px] text-[13.5px] font-semibold '
  + 'aria-disabled:opacity-50';

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

  const link    = origin ? referralLink(code, origin) : null;
  const message = link ? referralShareMessage(link) : null;

  async function copy(what: 'link' | 'code', value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      // Cleared on a timer rather than on blur: the confirmation is the only
      // feedback a copy gives, and it has to outlive the tap.
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Clipboard permission refused, or an insecure origin. The code is on
      // screen and selectable and the named channels are right there, so
      // there is nothing useful to say — an error here would be noise about a
      // fallback the person already has.
    }
  }

  async function share() {
    if (!link || !message) return;
    try {
      // `text` and `url` both: some targets (WhatsApp, Messages) take the
      // text and append the url, others (Twitter, Mail) prefer the url. The
      // message already contains the link, so a target that shows only one of
      // them still shows a usable share.
      await navigator.share({ text: message, url: link });
    } catch {
      // Includes the person simply dismissing the sheet, which is not a
      // failure and must not be reported as one.
    }
  }

  /** A channel is a real link, so it is an <a> — never a scripted window.open. */
  function channel(href: string | null, label: string, icon: keyof typeof ICON, external: boolean) {
    const disabled = href === null;
    return (
      <a
        href={href ?? undefined}
        aria-disabled={disabled}
        onClick={(e) => { if (disabled) e.preventDefault(); }}
        {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        data-testid={`referral-channel-${icon}`}
        className={CHANNEL_CLASS}
        style={{ border: '1px solid var(--portal-line)', color: 'var(--portal-ink)' }}
      >
        <Glyph name={icon} />
        {label}
      </a>
    );
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
        Send this to anyone. When they open it and create an account, they&rsquo;ll show up
        below as one of your referrals.
      </p>

      {canShare && (
        <button
          type="button"
          onClick={share}
          disabled={!link}
          data-testid="referral-share"
          className="mt-[14px] flex w-full items-center justify-center gap-2 rounded-tile py-[13px] text-[14.5px] font-semibold text-white disabled:opacity-60"
          style={{ background: 'var(--portal-ink)' }}
        >
          <Glyph name="share" />
          Share
        </button>
      )}

      <div className="mt-[10px] flex gap-2">
        {channel(message ? whatsappShareUrl(message) : null, 'WhatsApp', 'whatsapp', true)}
        {channel(message ? emailShareUrl(message)    : null, 'Email',    'email',    false)}
      </div>

      <button
        type="button"
        onClick={() => link && copy('link', link)}
        disabled={!link}
        data-testid="referral-copy-link"
        className={`mt-2 w-full ${CHANNEL_CLASS} disabled:opacity-50`}
        style={{ border: '1px solid var(--portal-line)', color: 'var(--portal-ink)' }}
      >
        <Glyph name="copy" />
        {copied === 'link' ? 'Link copied' : 'Copy link'}
      </button>

      <button
        type="button"
        onClick={() => copy('code', code)}
        data-testid="referral-copy-code"
        className="mt-[10px] w-full py-1 text-[13px] font-semibold underline underline-offset-2"
        style={{ color: 'var(--portal-accent-ink)' }}
      >
        {copied === 'code' ? 'Code copied' : 'Copy the code instead'}
      </button>
    </section>
  );
}
