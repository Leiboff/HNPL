import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

// ─── The two sides of the Refer screen are not symmetrical ───────────────
//
// This file pins the asymmetry, because it is a product decision that looks
// like an oversight if you only read the components:
//
//   A FRIEND is shareable. A code, a link, the system share sheet where one
//   exists, and named WhatsApp/email channels where it does not — the email
//   invitation form is one channel among them, not the only door.
//
//   A PRACTICE is NOT shareable, and there is nothing to share: a practice
//   cannot sign itself up, so there is no signup a code could be carried
//   into, and a link handed to a receptionist leads nowhere. What that side
//   produces is a LEAD. Migration 0145 says the same thing one layer down —
//   the referrals_link_is_patient_only constraint refuses a practice referral
//   with channel='link' — so a share affordance here would be offering
//   something the database would reject.
//
// The share-sheet half is tested against a browser that HAS navigator.share
// and one that does not, because "the button silently does nothing" is the
// exact failure the named channels exist to prevent.

vi.mock('./actions', () => ({
  referAFriend:   vi.fn(async () => ({ ok: true, message: 'sent' })),
  referAPractice: vi.fn(async () => ({ ok: true, message: 'sent' })),
}));

import ReferTabs from './ReferTabs';

const CODE = 'A2C4K9PT';

/** happy-dom gives no navigator.share; add or remove one per test. */
function withShareSheet(present: boolean) {
  if (present) {
    Object.defineProperty(navigator, 'share', {
      value: vi.fn(async () => {}), configurable: true, writable: true,
    });
  } else if ('share' in navigator) {
    delete (navigator as unknown as Record<string, unknown>).share;
  }
}

beforeEach(() => {
  withShareSheet(false);
  // The link is built from the browser's own origin, never from
  // NEXT_PUBLIC_APP_URL — see ReferralShareCard for why.
  expect(window.location.origin).toBeTruthy();
});

afterEach(() => { cleanup(); withShareSheet(false); });

describe('the friend side is shareable', () => {
  it('shows the code and both named channels', () => {
    render(<ReferTabs code={CODE} />);
    expect(screen.getByTestId('referral-code').textContent).toBe(CODE);
    expect(screen.getByTestId('referral-channel-whatsapp')).toBeTruthy();
    expect(screen.getByTestId('referral-channel-email')).toBeTruthy();
    expect(screen.getByTestId('referral-copy-link')).toBeTruthy();
  });

  it('the WhatsApp channel is a real link carrying the code', () => {
    // A real <a>, not a scripted window.open: not blocked by a popup blocker,
    // long-pressable, and no CSP question.
    render(<ReferTabs code={CODE} />);
    const href = screen.getByTestId('referral-channel-whatsapp').getAttribute('href') ?? '';
    expect(href.startsWith('https://wa.me/?text=')).toBe(true);
    expect(decodeURIComponent(href)).toContain(`?ref=${CODE}`);
    expect(decodeURIComponent(href)).toContain(window.location.origin);
  });

  it('the email channel is a mailto draft carrying the code', () => {
    render(<ReferTabs code={CODE} />);
    const href = screen.getByTestId('referral-channel-email').getAttribute('href') ?? '';
    expect(href.startsWith('mailto:?')).toBe(true);
    expect(decodeURIComponent(href)).toContain(`?ref=${CODE}`);
  });

  it('offers the system share sheet when the browser has one', () => {
    withShareSheet(true);
    render(<ReferTabs code={CODE} />);
    fireEvent.click(screen.getByTestId('referral-share'));
    const share = navigator.share as unknown as ReturnType<typeof vi.fn>;
    expect(share).toHaveBeenCalledTimes(1);
    const payload = share.mock.calls[0][0] as { text: string; url: string };
    expect(payload.url).toContain(`?ref=${CODE}`);
    // Both fields: some targets take the text and append the url, others show
    // only the url. The message already contains the link either way.
    expect(payload.text).toContain(payload.url);
  });

  it('renders no share BUTTON where there is no sheet — the channels carry it', () => {
    // The failure this prevents: a Share button that is present, tappable,
    // and silently does nothing on desktop Firefox.
    render(<ReferTabs code={CODE} />);
    expect(screen.queryByTestId('referral-share')).toBeNull();
    expect(screen.getByTestId('referral-channel-whatsapp')).toBeTruthy();
  });

  it('renders no share card at all when the code could not be minted', () => {
    // Rather than a card with a blank code and channels linking nowhere. The
    // page shows its own "your link isn't ready" notice in this case, and the
    // email-invitation form below still works — it mints the code itself.
    render(<ReferTabs code={null} />);
    expect(screen.queryByTestId('referral-share-card')).toBeNull();
    expect(screen.getByTestId('refer-form')).toBeTruthy();
  });
});

describe('the practice side is a lead form, and offers nothing to share', () => {
  it('hides the share card entirely', () => {
    render(<ReferTabs code={CODE} />);
    expect(screen.getByTestId('referral-share-card')).toBeTruthy();

    fireEvent.click(screen.getByTestId('refer-mode-practice'));

    expect(screen.queryByTestId('referral-share-card')).toBeNull();
    expect(screen.queryByTestId('referral-code')).toBeNull();
    expect(screen.queryByTestId('referral-share')).toBeNull();
    expect(screen.queryByTestId('referral-channel-whatsapp')).toBeNull();
    expect(screen.queryByTestId('referral-channel-email')).toBeNull();
    expect(screen.queryByTestId('referral-copy-link')).toBeNull();
  });

  it('asks for what a rep will need on the phone', () => {
    render(<ReferTabs code={CODE} />);
    fireEvent.click(screen.getByTestId('refer-mode-practice'));
    for (const field of ['name', 'contact', 'email', 'phone', 'suburb', 'note']) {
      expect(screen.getByTestId(`refer-practice-${field}`), field).toBeTruthy();
    }
  });

  it('says plainly that this goes to our team, not to the practice', () => {
    render(<ReferTabs code={CODE} />);
    fireEvent.click(screen.getByTestId('refer-mode-practice'));
    expect(screen.getByTestId('refer-form').textContent)
      .toMatch(/goes to our team as a new lead, not to the practice/i);
  });

  it('and switching back restores the share card', () => {
    render(<ReferTabs code={CODE} />);
    fireEvent.click(screen.getByTestId('refer-mode-practice'));
    fireEvent.click(screen.getByTestId('refer-mode-friend'));
    expect(screen.getByTestId('referral-share-card')).toBeTruthy();
  });
});

describe('switching sides discards the half-typed form', () => {
  it('a friend’s email address does not survive onto the practice form', () => {
    // ReferTabs remounts ReferForm with key={mode} rather than clearing state
    // by hand — the hand-written version cleared four things and would have
    // missed the fifth.
    render(<ReferTabs code={CODE} />);
    const email = screen.getByTestId('refer-friend-email') as HTMLInputElement;
    fireEvent.change(email, { target: { value: 'sipho@example.com' } });
    expect(email.value).toBe('sipho@example.com');

    fireEvent.click(screen.getByTestId('refer-mode-practice'));
    fireEvent.click(screen.getByTestId('refer-mode-friend'));

    expect((screen.getByTestId('refer-friend-email') as HTMLInputElement).value).toBe('');
  });
});

describe('nothing on this screen promises a reward', () => {
  it('neither side mentions one', () => {
    // There is no incentive programme (docs/REFERRALS.md). This screen is the
    // most screenshotted surface the referral system has.
    const { container } = render(<ReferTabs code={CODE} />);
    const text = () => container.textContent!.replace(/interest-free/gi, '');
    expect(text()).not.toMatch(/reward|bonus|R\d+|discount|cashback|earn|free/i);
    fireEvent.click(screen.getByTestId('refer-mode-practice'));
    expect(text()).not.toMatch(/reward|bonus|R\d+|discount|cashback|earn|free/i);
  });
});
