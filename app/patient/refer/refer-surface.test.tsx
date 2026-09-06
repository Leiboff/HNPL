import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';

// ─── The two sides of the Refer screen are not symmetrical ───────────────
//
// This file pins the asymmetry, because it is a product decision that looks
// like an oversight if you only read the components:
//
//   A FRIEND is shareable, and shareable is ALL it is. A code, a link, the
//   system share sheet where one exists, and named WhatsApp/email channels
//   where it does not. There is no form on this side: a friend signs
//   themselves up, and the referral is recorded when they arrive.
//
//   A DOCTOR is NOT shareable, and there is nothing to share: a practice
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
  referADoctor: vi.fn(async () => ({ ok: true, message: 'sent' })),
}));

// PlacesAutocomplete talks to Google. The stub captures its onSelect so a
// test can fire a canned pick — which is the ONLY way an address reaches the
// form, in the test and in a browser alike.
const placesOnSelect: {
  current: ((p: {
    placeId: string;
    formattedAddress: string;
    latitude: number;
    longitude: number;
    addressComponents: Array<{ longText: string; shortText: string; types: string[] }>;
  }) => void) | null;
} = { current: null };

vi.mock('@/app/_components/PlacesAutocomplete', () => ({
  default: (props: { onSelect: (p: never) => void; inputId?: string }) => {
    placesOnSelect.current = props.onSelect as never;
    return <input data-testid="places-input" id={props.inputId} />;
  },
}));

import ReferChoice from './ReferChoice';
import { referADoctor } from './actions';

const CODE = 'A2C4K9PT';

const PICKED = {
  placeId: 'place-1',
  formattedAddress: '12 Sturdee Ave, Rosebank, Johannesburg, 2196',
  latitude: -26.1445,
  longitude: 28.0416,
  addressComponents: [
    { longText: '12',           shortText: '12',   types: ['street_number'] },
    { longText: 'Sturdee Ave',  shortText: 'Sturdee Ave', types: ['route'] },
    { longText: 'Rosebank',     shortText: 'Rosebank',    types: ['sublocality_level_1'] },
    { longText: 'Johannesburg', shortText: 'JHB',         types: ['locality'] },
    { longText: 'Gauteng',      shortText: 'GP',          types: ['administrative_area_level_1'] },
  ],
};

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

/**
 * Fire the Places pick. Wrapped in act() because this is the one state update
 * on this screen that no DOM event drives — a real pick comes out of a fetch
 * inside PlacesAutocomplete, which the stub above stands in for.
 */
function pickAddress() {
  act(() => { placesOnSelect.current?.(PICKED); });
}

/** Open the doctor side and fill in everything the action requires. */
function fillDoctorForm(over: Partial<Record<string, string>> = {}) {
  fireEvent.click(screen.getByTestId('refer-choose-doctor'));
  const set = (testid: string, value: string) =>
    fireEvent.change(screen.getByTestId(testid), { target: { value } });

  set('refer-doctor-name',      over.name      ?? 'Dr Ayanda Naidoo');
  set('refer-doctor-specialty', over.specialty ?? 'General Dental Practitioner');
  set('refer-doctor-phone',     over.phone     ?? '011 555 1234');
  if (over.address !== '') pickAddress();
}

beforeEach(() => {
  withShareSheet(false);
  placesOnSelect.current = null;
  vi.mocked(referADoctor).mockClear();
  // The link is built from the browser's own origin, never from
  // NEXT_PUBLIC_APP_URL — see ReferralShareCard for why.
  expect(window.location.origin).toBeTruthy();
});

afterEach(() => { cleanup(); withShareSheet(false); });

describe('the screen opens on a choice, not on a form', () => {
  it('offers exactly two buttons and nothing else', () => {
    render(<ReferChoice code={CODE} />);
    expect(screen.getByTestId('refer-choose-friend')).toBeTruthy();
    expect(screen.getByTestId('refer-choose-doctor')).toBeTruthy();
    // Neither side's affordances are on screen before a choice is made — the
    // old tab strip put a form up before anybody had said what they were
    // referring.
    expect(screen.queryByTestId('referral-share-card')).toBeNull();
    expect(screen.queryByTestId('refer-form')).toBeNull();
  });

  it('names both sides in the words the patient uses', () => {
    render(<ReferChoice code={CODE} />);
    expect(screen.getByTestId('refer-choose-friend').textContent).toMatch(/refer a friend/i);
    expect(screen.getByTestId('refer-choose-doctor').textContent).toMatch(/refer a doctor/i);
  });

  it('goes back from either side', () => {
    render(<ReferChoice code={CODE} />);
    fireEvent.click(screen.getByTestId('refer-choose-doctor'));
    expect(screen.getByTestId('refer-form')).toBeTruthy();
    fireEvent.click(screen.getByTestId('refer-back'));
    expect(screen.getByTestId('refer-choose-friend')).toBeTruthy();

    fireEvent.click(screen.getByTestId('refer-choose-friend'));
    expect(screen.getByTestId('referral-share-card')).toBeTruthy();
    fireEvent.click(screen.getByTestId('refer-back'));
    expect(screen.getByTestId('refer-choose-doctor')).toBeTruthy();
  });

  it('discards a half-typed doctor referral on the way back', () => {
    // ReferChoice unmounts the form rather than clearing it by hand — the
    // tabbed version cleared four pieces of state and would have missed the
    // fifth.
    render(<ReferChoice code={CODE} />);
    fireEvent.click(screen.getByTestId('refer-choose-doctor'));
    fireEvent.change(screen.getByTestId('refer-doctor-name'), { target: { value: 'Dr Naidoo' } });

    fireEvent.click(screen.getByTestId('refer-back'));
    fireEvent.click(screen.getByTestId('refer-choose-doctor'));

    expect((screen.getByTestId('refer-doctor-name') as HTMLInputElement).value).toBe('');
  });
});

describe('the friend side is the link, and only the link', () => {
  it('shows the code and every channel, and no form at all', () => {
    render(<ReferChoice code={CODE} />);
    fireEvent.click(screen.getByTestId('refer-choose-friend'));

    expect(screen.getByTestId('referral-code').textContent).toBe(CODE);
    expect(screen.getByTestId('referral-channel-whatsapp')).toBeTruthy();
    expect(screen.getByTestId('referral-channel-email')).toBeTruthy();
    expect(screen.getByTestId('referral-copy-link')).toBeTruthy();
    // The email-invitation form is gone with the action behind it. A friend
    // referral is recorded when the friend ARRIVES (lib/referrals/claim.ts),
    // never speculatively when a link is sent.
    expect(screen.queryByTestId('refer-form')).toBeNull();
  });

  it('the WhatsApp channel is a real link carrying the code', () => {
    // A real <a>, not a scripted window.open: not blocked by a popup blocker,
    // long-pressable, and no CSP question.
    render(<ReferChoice code={CODE} />);
    fireEvent.click(screen.getByTestId('refer-choose-friend'));
    const href = screen.getByTestId('referral-channel-whatsapp').getAttribute('href') ?? '';
    expect(href.startsWith('https://wa.me/?text=')).toBe(true);
    expect(decodeURIComponent(href)).toContain(`?ref=${CODE}`);
    expect(decodeURIComponent(href)).toContain(window.location.origin);
  });

  it('the email channel is a mailto draft carrying the code', () => {
    render(<ReferChoice code={CODE} />);
    fireEvent.click(screen.getByTestId('refer-choose-friend'));
    const href = screen.getByTestId('referral-channel-email').getAttribute('href') ?? '';
    expect(href.startsWith('mailto:?')).toBe(true);
    expect(decodeURIComponent(href)).toContain(`?ref=${CODE}`);
  });

  it('offers the system share sheet when the browser has one', () => {
    withShareSheet(true);
    render(<ReferChoice code={CODE} />);
    fireEvent.click(screen.getByTestId('refer-choose-friend'));
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
    render(<ReferChoice code={CODE} />);
    fireEvent.click(screen.getByTestId('refer-choose-friend'));
    expect(screen.queryByTestId('referral-share')).toBeNull();
    expect(screen.getByTestId('referral-channel-whatsapp')).toBeTruthy();
  });

  it('renders no share card at all when the code could not be minted', () => {
    // Rather than a card with a blank code and channels linking nowhere. The
    // page shows its own "your link isn't ready" notice in that case, and
    // says the doctor side still works — which it does, because the doctor
    // side never needed the code.
    render(<ReferChoice code={null} />);
    fireEvent.click(screen.getByTestId('refer-choose-friend'));
    expect(screen.queryByTestId('referral-share-card')).toBeNull();

    fireEvent.click(screen.getByTestId('refer-back'));
    fireEvent.click(screen.getByTestId('refer-choose-doctor'));
    expect(screen.getByTestId('refer-form')).toBeTruthy();
  });
});

describe('the doctor side is a lead form, and offers nothing to share', () => {
  it('hides every share affordance', () => {
    render(<ReferChoice code={CODE} />);
    fireEvent.click(screen.getByTestId('refer-choose-doctor'));

    expect(screen.queryByTestId('referral-share-card')).toBeNull();
    expect(screen.queryByTestId('referral-code')).toBeNull();
    expect(screen.queryByTestId('referral-share')).toBeNull();
    expect(screen.queryByTestId('referral-channel-whatsapp')).toBeNull();
    expect(screen.queryByTestId('referral-channel-email')).toBeNull();
    expect(screen.queryByTestId('referral-copy-link')).toBeNull();
  });

  it('asks for what a rep will need on the phone', () => {
    render(<ReferChoice code={CODE} />);
    fireEvent.click(screen.getByTestId('refer-choose-doctor'));
    for (const field of ['name', 'specialty', 'phone', 'practice', 'email', 'note']) {
      expect(screen.getByTestId(`refer-doctor-${field}`), field).toBeTruthy();
    }
    // The address is not a plain input — it is a Google Places picker.
    expect(screen.getByTestId('places-input')).toBeTruthy();
  });

  it('offers the shared specialty register, not a list of its own', () => {
    // lib/specialties.ts is the single source for every specialty dropdown in
    // the app. A local list here is the exact drift that module exists to
    // prevent, so this asserts a value only the register has.
    render(<ReferChoice code={CODE} />);
    fireEvent.click(screen.getByTestId('refer-choose-doctor'));
    const select = screen.getByTestId('refer-doctor-specialty') as HTMLSelectElement;
    const values = Array.from(select.options).map(o => o.value);
    expect(values).toContain('Otorhinolaryngologist (ENT Specialist)');
    expect(values.length).toBeGreaterThan(50);
    // Grouped by initial letter — 60 flat options is a wall of text.
    expect(select.querySelectorAll('optgroup').length).toBeGreaterThan(1);
  });

  it('says plainly that this goes to our team, not to the practice', () => {
    render(<ReferChoice code={CODE} />);
    fireEvent.click(screen.getByTestId('refer-choose-doctor'));
    expect(screen.getByTestId('refer-form').textContent)
      .toMatch(/goes to our team as a new lead, not to the practice/i);
  });

  it('sends the doctor, the specialty, the number and the picked address', async () => {
    render(<ReferChoice code={CODE} />);
    fillDoctorForm();
    fireEvent.change(screen.getByTestId('refer-doctor-practice'), { target: { value: 'Rosebank Dental' } });
    fireEvent.submit(screen.getByTestId('refer-form'));

    await waitFor(() => expect(referADoctor).toHaveBeenCalledTimes(1));
    expect(vi.mocked(referADoctor).mock.calls[0][0]).toMatchObject({
      doctorName:   'Dr Ayanda Naidoo',
      specialty:    'General Dental Practitioner',
      phone:        '011 555 1234',
      practiceName: 'Rosebank Dental',
      address: {
        formattedAddress: PICKED.formattedAddress,
        streetAddress:    '12 Sturdee Ave',
        suburb:           'Rosebank',
        city:             'Johannesburg',
        province:         'Gauteng',
        latitude:         PICKED.latitude,
        longitude:        PICKED.longitude,
      },
    });
    await screen.findByTestId('refer-done');
  });
});

describe('the four compulsory fields are refused before anything is sent', () => {
  // The form is a screen the caller owns, so referADoctor refuses each of
  // these again server-side (actions.test.ts). These assert the other half:
  // that a person is told which field, instantly, and that nothing is sent.

  const CASES: Array<[string, Partial<Record<string, string>>]> = [
    ['the doctor’s name', { name: '   ' }],
    ['a specialty',       { specialty: '' }],
    ['a phone number',    { phone: '  ' }],
    ['a picked address',  { address: '' }],
  ];

  for (const [what, over] of CASES) {
    it(`will not submit without ${what}`, () => {
      render(<ReferChoice code={CODE} />);
      fillDoctorForm(over);
      fireEvent.submit(screen.getByTestId('refer-form'));

      expect(screen.getByTestId('refer-error')).toBeTruthy();
      expect(referADoctor).not.toHaveBeenCalled();
    });
  }

  it('an address that was typed but never picked does not count as one', () => {
    // PlacesAutocomplete only reports a place once it is CHOSEN, so typed
    // text never reaches the form's state. The hint under the field says so
    // until a pick lands.
    render(<ReferChoice code={CODE} />);
    fillDoctorForm({ address: '' });
    fireEvent.change(screen.getByTestId('places-input'), { target: { value: '12 Sturdee' } });

    expect(screen.getByTestId('refer-doctor-address-state').textContent)
      .toMatch(/pick a suggestion/i);

    pickAddress();
    expect(screen.getByTestId('refer-doctor-address-state').textContent)
      .toContain(PICKED.formattedAddress);
  });
});

describe('nothing on this screen promises a reward', () => {
  it('no side mentions one', () => {
    // There is no incentive programme (docs/REFERRALS.md). This screen is the
    // most screenshotted surface the referral system has.
    const { container } = render(<ReferChoice code={CODE} />);
    const text = () => container.textContent!.replace(/interest-free/gi, '');
    expect(text()).not.toMatch(/reward|bonus|R\d+|discount|cashback|earn|free/i);
    fireEvent.click(screen.getByTestId('refer-choose-friend'));
    expect(text()).not.toMatch(/reward|bonus|R\d+|discount|cashback|earn|free/i);
    fireEvent.click(screen.getByTestId('refer-back'));
    fireEvent.click(screen.getByTestId('refer-choose-doctor'));
    expect(text()).not.toMatch(/reward|bonus|R\d+|discount|cashback|earn|free/i);
  });
});
