import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── Account hierarchy rework — the invariants the rework must not lose ───
//
// Source-level because the page is an async server component. The interaction
// uniformity is tested behaviourally in ./AccountSettings.test.tsx; the
// per-field behaviour in ../profile/PhoneField.test.tsx and
// ../profile/SalaryDaySection.test.tsx. What is left for this file is what
// only the composed page can answer: which fields are masked, which are
// locked and say why, where provenance renders and — the important half —
// where it deliberately does not.
//
// Comments are stripped throughout. This page's own prose DISCUSSES the very
// things some assertions below require to be absent (it explains at length
// why phone has no provenance line), so an un-stripped read would let the
// explanation satisfy the assertion. See lib/testing/stripComments.ts.

const ROOT = resolve(process.cwd());
const read     = (p: string) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const codeOf   = (p: string) => stripComments(read(p));

const PAGE     = codeOf('app/patient/account/page.tsx');
const SETTINGS = codeOf('app/patient/account/AccountSettings.tsx');
const PHONE    = codeOf('app/patient/profile/PhoneField.tsx');
const SALARY   = codeOf('app/patient/profile/SalaryDaySection.tsx');
const PASSKEYS = codeOf('app/patient/profile/PasskeysSection.tsx');
const CARDS    = codeOf('app/patient/payment-methods/PaymentMethods.tsx');
const LOGOUT   = codeOf('app/patient/profile/ProfileLogoutSection.tsx');
const PASSWORD = codeOf('app/patient/account/PasswordSection.tsx');
const LOADING  = codeOf('app/patient/account/loading.tsx');

// ─── Masking ──────────────────────────────────────────────────────────────

describe('sensitive values are masked consistently, and stay editable', () => {
  it('the page never renders a raw email — including in the navy header', () => {
    // The header was the leak: it printed profile.email in full above a
    // section that masked the SA ID. Both now go through maskEmail.
    expect(PAGE).toMatch(/maskEmail\(profile\?\.email/);
    expect(PAGE).not.toMatch(/\{profile\?\.email \?\? ''\}/);
    expect(PAGE).not.toMatch(/value=\{profile\?\.email/);
  });

  it('all three identifiers use a mask helper — none is hand-rolled', () => {
    expect(PAGE).toMatch(/maskSaId\(/);
    expect(PAGE).toMatch(/maskEmail\(/);
    expect(PHONE).toMatch(/maskPhone\(/);
    // No inline bullet-building anywhere — that is how masks drift apart.
    for (const [name, src] of [['page', PAGE], ['phone', PHONE]] as const) {
      expect(src, name).not.toMatch(/'•'\.repeat/);
    }
  });

  it('phone is masked for DISPLAY and raw in the INPUT', () => {
    // Masked-but-editable. A field whose input also showed bullets would be
    // uncorrectable, which is the way this requirement fails in practice.
    expect(PHONE).toMatch(/\{maskPhone\(savedPhone\)\}/);
    expect(PHONE).toMatch(/value=\{phone\}/);
    expect(PHONE).not.toMatch(/value=\{maskPhone/);
  });

  it('masking did not touch the phone validator or its save path', () => {
    // The FORBIDDEN line: structure, affordance and copy only.
    expect(PHONE).toMatch(/normalizePhoneZA\(raw\)/);
    expect(PHONE).toMatch(/await updateProfile\(\{ phone: normalized \}\)/);
    expect(PAGE).toMatch(/normalizePhoneZA\(raw\)/);
    expect(PAGE).toMatch(/\.update\(\{ phone \}\)/);
  });
});

// ─── Locked fields ────────────────────────────────────────────────────────

describe('a locked field is visibly locked and says why, per field', () => {
  it('renders three locked fields, each with its own reason', () => {
    // The reason used to be one footnote at the bottom of the section, so a
    // field was read-only without looking locked and the explanation was
    // somewhere else on the screen.
    expect(PAGE.match(/<LockedField/g) ?? []).toHaveLength(3);
    expect(PAGE.match(/reason="/g) ?? []).toHaveLength(3);
  });

  it('the lock is a visible icon with an accessible label', () => {
    expect(PAGE).toMatch(/aria-label="Locked"/);
    expect(PAGE).toMatch(/data-testid="locked-field-icon"/);
  });

  it('LockedField cannot be constructed without a reason', () => {
    // Typed as required, so a fourth locked field added later must explain
    // itself. The absence of `reason?:` is the assertion.
    expect(PAGE).toMatch(/reason: string;/);
    expect(PAGE).not.toMatch(/reason\?: string/);
  });

  it('the three locked fields are name, SA ID and email — not phone', () => {
    // Phone is the one editable field; locking it would be a real regression.
    const start = PAGE.indexOf('const personalDetails =');
    const end   = PAGE.indexOf('const salaryDate =');
    const body  = PAGE.slice(start, end);
    expect(body).toMatch(/label="Full name"/);
    expect(body).toMatch(/label="SA ID number"/);
    expect(body).toMatch(/label="Email"/);
    expect(body).toMatch(/<PhoneField/);
    // PhoneField cannot be wrapped in a LockedField, structurally: LockedField
    // takes no children and is always self-closing, so there is no closing tag
    // anywhere for anything to sit inside.
    expect(PAGE).not.toMatch(/<\/LockedField>/);
  });
});

// ─── Provenance: present where real, ABSENT where not ─────────────────────

describe('provenance renders only where the data exists', () => {
  it('renders member-since and terms acceptance from real columns', () => {
    expect(PAGE).toMatch(/created_at, terms_accepted_at, terms_version/);
    expect(PAGE).toMatch(/Member since \$\{formatDate\(/);
    expect(PAGE).toMatch(/accepted \$\{formatDate\(/);
  });

  it('every provenance value is null-guarded, never interpolated blind', () => {
    // THE failure this file exists to catch: `undefined` reaching the screen.
    // Each line is built only inside a truthiness check on its own source
    // column, and <Provenance> returns null for a falsy child.
    expect(PAGE).toMatch(/createdAtRaw\s*\?\s*`Member since/);
    expect(PAGE).toMatch(/termsAtRaw\s*\n?\s*\?\s*`Terms/);
    expect(PAGE).toMatch(/if \(!children\) return null;/);
  });

  it('Provenance renders NO element for a null value', () => {
    // Not "renders an empty string" — no element at all, so there is no
    // stray gap in the footer either.
    const start = PAGE.indexOf('function Provenance');
    const body  = PAGE.slice(start, PAGE.indexOf('export default', start));
    expect(body).toMatch(/if \(!children\) return null;/);
    expect(body).not.toMatch(/'unknown'|'undefined'|'—'/);
  });

  it('the page cannot print the literal string "undefined"', () => {
    // Scoped deliberately to RENDERABLE occurrences. An earlier version of
    // this assertion banned the substring outright and was a false positive:
    // the page uses `undefined` in TYPE positions all over
    // (`string | null | undefined`), which can never reach the screen. What
    // would reach the screen is a quoted literal or a String() coercion of a
    // possibly-missing value.
    expect(PAGE).not.toMatch(/'undefined'|"undefined"|`undefined`/);
    expect(PAGE).not.toMatch(/\{String\(/);
    expect(PAGE).not.toMatch(/\?\?\s*'unknown'/);
    // Every `undefined` that IS present sits in a type annotation.
    for (const hit of PAGE.match(/.*undefined.*/g) ?? []) {
      expect(hit, hit.trim()).toMatch(/\|\s*undefined|undefined\s*\|/);
    }
  });

  it('SALARY DATE renders no provenance line — there is no rule and no timestamp', () => {
    // The centrepiece absence. There is no change-frequency rule anywhere in
    // this codebase and no salary_day change timestamp, so any date rendered
    // here would have to come from an unrelated column. If a migration later
    // adds one, this assertion is the thing that should be updated
    // deliberately rather than a line quietly appearing.
    expect(SALARY).not.toMatch(/Last changed|Last updated|last_changed|updated_at/);
    expect(SALARY).not.toMatch(/salary_day_changed_at/);
    expect(SALARY).not.toMatch(/<Provenance/);
    // And the consequence that IS real is still stated.
    expect(SALARY).toMatch(/Existing plans keep their current schedule/);
  });

  it('PHONE renders no provenance line, and never reads phone_verified_at', () => {
    // phone_verified_at is column-locked to the OTP path (migrations 0054 /
    // 0065) and the save path does not touch it, so it holds the date the OLD
    // number was verified. Rendering it beside an edited number would state
    // that an unverified number was verified.
    expect(PHONE).not.toMatch(/phone_verified_at/);
    expect(PHONE).not.toMatch(/Verified|Last updated|Last changed/);
    expect(PHONE).not.toMatch(/<Provenance/);
  });

  it('the page does not read the flag-gated verification columns either', () => {
    // liveness_verified_at and credit_check_completed_at sit behind flags
    // that default off, and liveness is a stub that always passes.
    expect(PAGE).not.toMatch(/liveness_verified_at/);
    expect(PAGE).not.toMatch(/credit_check_completed_at/);
    expect(PAGE).not.toMatch(/Identity verified/);
  });

  it('card provenance comes from the column already selected', () => {
    expect(CARDS).toMatch(/Added \{formatDate\(card\.created_at\.slice\(0, 10\)\)\}/);
    // Reuses the shared formatter rather than adding another local copy.
    expect(CARDS).toMatch(/import \{ formatDate \} from '@\/app\/patient\/_format'/);
  });
});

// ─── Empty states ─────────────────────────────────────────────────────────

describe('every empty state has an icon and a sentence', () => {
  it('all five use the shared EmptyState, not a hand-rolled block', () => {
    for (const [name, src] of [
      ['page (record)', PAGE],
      ['phone',         PHONE],
      ['salary',        SALARY],
      ['passkeys',      PASSKEYS],
      ['cards',         CARDS],
    ] as const) {
      expect(src, name).toMatch(/<EmptyState/);
    }
  });

  it('no field falls back to a bare em-dash any more', () => {
    // The em-dash said nothing at all to someone who had never set the field.
    expect(PHONE).not.toMatch(/\|\| '—'/);
    expect(SALARY).not.toMatch(/: '—'/);
  });

  it('the record card shows an empty state instead of a heading with nothing under it', () => {
    // This is the card above the fold, so "nothing here yet" versus "still
    // loading" is the distinction that matters most.
    expect(PAGE).toMatch(/recordSegments\.length === 0 \?/);
    expect(PAGE).toMatch(/<EmptyState icon="record"/);
    // And the ladder is still only drawn when there are segments to draw.
    expect(PAGE).toMatch(/<InstalmentLadder segments=\{recordSegments\}/);
  });

  it('the passkeys unsupported case is no longer a bare sentence', () => {
    expect(PASSKEYS).toMatch(/<EmptyState icon="key" title="Not available in this browser">/);
    expect(PASSKEYS).toMatch(/<EmptyState icon="key" title="No passkeys yet">/);
  });

  it('EmptyState always renders both an icon and body copy', () => {
    // Structural: the component cannot be used to produce a bare heading,
    // because both the svg and the children paragraph are unconditional.
    const EMPTY = codeOf('components/EmptyState.tsx');
    expect(EMPTY).toMatch(/ICON_PATHS\[icon\]/);
    expect(EMPTY).toMatch(/\{children\}/);
    expect(EMPTY).not.toMatch(/children \?\?|children &&/);
  });
});

// ─── Save paths — regression, per field ───────────────────────────────────

describe('every existing save path is intact', () => {
  it('the phone action still validates, normalises and revalidates', () => {
    expect(PAGE).toMatch(/async function updateProfile\(data: \{ phone: string \| null \}\)/);
    expect(PAGE).toMatch(/'use server'/);
    expect(PAGE).toMatch(/if \(!phone\) return \{ error: 'Enter a valid South African mobile number\.' \}/);
    expect(PAGE).toMatch(/revalidatePath\('\/patient\/account'\)/);
  });

  it('the salary action still gates on ALLOWED_SALARY_DAYS and revalidates both routes', () => {
    expect(PAGE).toMatch(/if \(!isAllowedSalaryDay\(day\)\)/);
    expect(PAGE).toMatch(/\.update\(\{ salary_day: day \}\)/);
    expect(PAGE).toMatch(/revalidatePath\('\/patient'\)/);
  });

  it('the card actions are still the same three, passed through unchanged', () => {
    expect(PAGE).toMatch(/initializeCardRegistration=\{initializeCardRegistration\}/);
    expect(PAGE).toMatch(/changeDefaultCard=\{changeDefaultCard\}/);
    expect(PAGE).toMatch(/removeCard=\{removeCard\}/);
  });

  it('the card removal lock is still computed server-side', () => {
    expect(PAGE).toMatch(/lockedCardIds=\{lockedCardIds\}/);
    expect(PAGE).toMatch(/activeTokens\.has\(c\.token\)/);
    // The server-only token is still stripped before cards reach the client.
    expect(PAGE).toMatch(/map\(\(\{ token: _token, \.\.\.row \}\) => row\)/);
  });

  it('sign out still calls the same helper, with no new auth code', () => {
    expect(LOGOUT).toMatch(/logoutAndRedirect\(\)/);
    expect(LOGOUT).toMatch(/from '@\/lib\/auth\/logout'/);
    expect(LOGOUT).not.toMatch(/signOut|createClient/);
  });

  it('password reset POINTS AT the existing route and adds no second flow', () => {
    expect(PASSWORD).toMatch(/href="\/forgot-password"/);
    expect(PASSWORD).not.toMatch(/'use server'|createClient|updateUser|resetPasswordForEmail/);
  });
});

// ─── Loading affordance — inherited, not duplicated ───────────────────────

describe('the page still uses the shared loading skeleton', () => {
  it('loading.tsx is the shared DelayedSkeleton + PatientShellShape', () => {
    expect(LOADING).toMatch(/from '@\/components\/loading\/DelayedSkeleton'/);
    expect(LOADING).toMatch(/from '@\/components\/loading\/PatientShellShape'/);
    expect(LOADING).toMatch(/<DelayedSkeleton>/);
    expect(LOADING).toMatch(/<PatientDetailShape/);
  });

  it('no second skeleton system was introduced alongside it', () => {
    // The rework adds sections, which is exactly when someone hand-rolls a
    // shimmer div rather than adjusting the shared shape.
    expect(LOADING).not.toMatch(/animate-pulse|animate-spin/);
    expect(PAGE).not.toMatch(/animate-pulse/);
    expect(SETTINGS).not.toMatch(/animate-pulse|Skeleton/);
  });
});
