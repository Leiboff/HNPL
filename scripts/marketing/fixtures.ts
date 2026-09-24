// ─── Fixtures for the device-approved marketing capture ──────────────────
//
// Every value here is fictional. First name only — no surname, no ID number,
// no real email, no card digits beyond the generic 4242. The PII test in
// device-approved.test.ts scans this file's source for anything that looks
// real, so keep new values obviously made up.

export type FixturePlan = {
  id:           string;
  status:       string;
  total_amount: number;
  plan_type:    number;
  instalments:  Array<{ amount: number; due_date: string }>;
};

export const FIXTURE = {
  /** Pinned clock for the render and the browser (SAST, a salary-day 25th). */
  clock: '2026-09-25T07:41:00+02:00',

  user: {
    id:                 '00000000-0000-4000-8000-000000000001',
    email:              'thandi@example.com',
    email_confirmed_at: '2026-09-01T00:00:00Z',
    last_sign_in_at:    '2026-09-25T05:41:00Z',
    identity_providers: ['email'],
  },

  profile: {
    role:                              'patient',
    first_name:                        'Thandi',
    last_name:                         null,
    terms_accepted_at:                 '2026-09-01T00:00:00Z',
    login_count:                       0,
    passkey_prompt_next_show_at_login: 99,
    passkey_prompt_permanent_dismiss:  true,
  },

  /** The headline figure. Round, and nothing spent against it yet. */
  approvedAllowance: 8000,
  availableBalance:  8000,

  card: { brand: 'Visa', last4: '4242' },

  /** The celebration screen shows no plan. Any plan added later must be
   *  Pay in 3 — the fixture test enforces the arithmetic. */
  plans: [] as FixturePlan[],
} as const;
