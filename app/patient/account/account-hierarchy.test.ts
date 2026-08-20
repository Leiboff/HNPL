import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── Account hierarchy — the invariants the accordion→screens rework
// ─── must not lose ─────────────────────────────────────────────────────
//
// Source-level because every page here is an async server component. The
// interaction uniformity is tested behaviourally in ./AccountSettings.test.tsx;
// the per-field behaviour in ../profile/PhoneField.test.tsx and
// ../profile/SalaryDaySection.test.tsx. What is left for this file is what
// only the composed pages can answer: which fields are masked, which are
// locked and say why, where provenance renders and — the important half —
// where it deliberately does not.
//
// RE-HOMED (2026-08-20) for the accordion→screens conversion: everything
// that used to be a `const personalDetails = (...)` block built inline on
// app/patient/account/page.tsx now lives on its own route,
// app/patient/account/personal/page.tsx — LockedField included. The index
// page (PAGE below) shrank to the record card + the settings menu + the
// footer; PERSONAL is where identity/phone/salary assertions now point.
//
// Comments are stripped throughout. This surface's own prose DISCUSSES the
// very things some assertions below require to be absent (it explains at
// length why phone has no provenance line), so an un-stripped read would let
// the explanation satisfy the assertion. See lib/testing/stripComments.ts.

const ROOT = resolve(process.cwd());
const read     = (p: string) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const codeOf   = (p: string) => stripComments(read(p));

const PAGE     = codeOf('app/patient/account/page.tsx');
const PERSONAL = codeOf('app/patient/account/personal/page.tsx');
const PAY      = codeOf('app/patient/account/pay/page.tsx');
const SETTINGS = codeOf('app/patient/account/AccountSettings.tsx');
const PHONE    = codeOf('app/patient/profile/PhoneField.tsx');
const SALARY   = codeOf('app/patient/profile/SalaryDaySection.tsx');
const AMOUNT   = codeOf('app/patient/profile/SalaryAmountSection.tsx');
const PASSKEYS = codeOf('app/patient/profile/PasskeysSection.tsx');
const CARDS    = codeOf('app/patient/payment-methods/PaymentMethods.tsx');
const LOGOUT   = codeOf('app/patient/profile/ProfileLogoutSection.tsx');
const PASSWORD = codeOf('app/patient/account/PasswordSection.tsx');
const ACTIONS  = codeOf('app/patient/account/actions.ts');
const PHONE_ACTIONS = codeOf('app/patient/account/phoneChangeActions.ts');
const LOADING  = codeOf('app/patient/account/loading.tsx');

// ─── Masking ──────────────────────────────────────────────────────────────

describe('sensitive values are masked consistently, and stay editable', () => {
  it('the index page never renders a raw email — including in the navy header', () => {
    // The header was the leak: it printed profile.email in full above a
    // section that masked the SA ID. Both now go through maskEmail — the
    // header still lives on the index page even though the SA ID moved to
    // Personal details, so this pin still targets PAGE.
    expect(PAGE).toMatch(/maskEmail\(profile\?\.email/);
    expect(PAGE).not.toMatch(/\{profile\?\.email \?\? ''\}/);
    expect(PAGE).not.toMatch(/value=\{profile\?\.email/);
  });

  it('Personal details also masks email (repeated for the identity field) and SA ID — neither is hand-rolled', () => {
    expect(PERSONAL).toMatch(/maskSaId\(/);
    expect(PERSONAL).toMatch(/maskEmail\(/);
    expect(PHONE).toMatch(/maskPhone\(/);
    // No inline bullet-building anywhere — that is how masks drift apart.
    for (const [name, src] of [['personal', PERSONAL], ['phone', PHONE]] as const) {
      expect(src, name).not.toMatch(/'•'\.repeat/);
    }
  });

  it('phone is masked for DISPLAY and raw in the INPUT', () => {
    // Masked-but-editable. A field whose input also showed bullets would be
    // uncorrectable, which is the way this requirement fails in practice.
    expect(PHONE).toMatch(/\{maskPhone\(current\)\}/);
    expect(PHONE).toMatch(/value=\{draft\}/);
    expect(PHONE).not.toMatch(/value=\{maskPhone/);
    // The staged number is masked too — it is just as personal as the current
    // one, and the pending banner is a place the raw value could easily leak.
    expect(PHONE).toMatch(/maskPhone\(staged\)/);
  });

  it('the phone validator is still the shared one, on both sides', () => {
    // A phone change requires OTP re-verification, so no page writes
    // profiles.phone directly — the validator is the shared normaliser on
    // the client pre-check and again in the server action as the real gate.
    expect(PHONE).toMatch(/normalizePhoneZA\(raw\)/);
    expect(PHONE_ACTIONS).toMatch(/normalizePhoneZA\(\(phoneRaw \?\? ''\)\.trim\(\)\)/);
    expect(PERSONAL).not.toMatch(/\.update\(\{ phone \}\)/);
    expect(PAGE).not.toMatch(/\.update\(\{ phone \}\)/);
  });
});

// ─── Locked fields ────────────────────────────────────────────────────────

describe('a locked field is visibly locked and says why, per field — on Personal details', () => {
  it('renders three locked fields, each with its own reason', () => {
    // The reason used to be one footnote at the bottom of the section, so a
    // field was read-only without looking locked and the explanation was
    // somewhere else on the screen.
    expect(PERSONAL.match(/<LockedField/g) ?? []).toHaveLength(3);
    expect(PERSONAL.match(/reason="/g) ?? []).toHaveLength(3);
  });

  it('the lock is a visible icon with an accessible label', () => {
    expect(PERSONAL).toMatch(/aria-label="Locked"/);
    expect(PERSONAL).toMatch(/data-testid="locked-field-icon"/);
  });

  it('LockedField cannot be constructed without a reason', () => {
    // Typed as required, so a fourth locked field added later must explain
    // itself. The absence of `reason?:` is the assertion.
    expect(PERSONAL).toMatch(/reason: string;/);
    expect(PERSONAL).not.toMatch(/reason\?: string/);
  });

  it('the three locked fields are name, SA ID and email — not phone, not salary', () => {
    // Phone and both salary fields are editable; locking any of them would
    // be a real regression.
    expect(PERSONAL).toMatch(/label="Full name"/);
    expect(PERSONAL).toMatch(/label="SA ID number"/);
    expect(PERSONAL).toMatch(/label="Email"/);
    expect(PERSONAL).toMatch(/<PhoneField/);
    expect(PERSONAL).toMatch(/<SalaryDaySection/);
    expect(PERSONAL).toMatch(/<SalaryAmountSection/);
    // PhoneField cannot be wrapped in a LockedField, structurally: LockedField
    // takes no children and is always self-closing, so there is no closing tag
    // anywhere for anything to sit inside.
    expect(PERSONAL).not.toMatch(/<\/LockedField>/);
  });

  it('the index page no longer builds any locked fields itself', () => {
    // The whole point of the move — LockedField now has exactly one home.
    expect(PAGE).not.toMatch(/<LockedField/);
    expect(PAGE).not.toMatch(/function LockedField/);
  });
});

// ─── Provenance: present where real, ABSENT where not ─────────────────────

describe('provenance renders only where the data exists', () => {
  it('the index page renders member-since and terms acceptance from real columns', () => {
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

  it('neither the index page nor Personal details can print the literal string "undefined"', () => {
    // Scoped deliberately to RENDERABLE occurrences. Both pages use
    // `undefined` in TYPE positions (`string | null | undefined`), which can
    // never reach the screen. What would reach the screen is a quoted
    // literal or a String() coercion of a possibly-missing value.
    for (const [name, src] of [['page', PAGE], ['personal', PERSONAL]] as const) {
      expect(src, name).not.toMatch(/'undefined'|"undefined"|`undefined`/);
      expect(src, name).not.toMatch(/\{String\(/);
      expect(src, name).not.toMatch(/\?\?\s*'unknown'/);
      // Every `undefined` that IS present sits in a type annotation.
      for (const hit of src.match(/.*undefined.*/g) ?? []) {
        expect(hit, `${name}: ${hit.trim()}`).toMatch(/\|\s*undefined|undefined\s*\|/);
      }
    }
  });

  it('SALARY DATE renders no provenance line — there is no rule and no timestamp', () => {
    // There is no change-frequency rule anywhere in this codebase and no
    // salary_day change timestamp, so any date rendered here would have to
    // come from an unrelated column.
    expect(SALARY).not.toMatch(/Last changed|Last updated|last_changed|updated_at/);
    expect(SALARY).not.toMatch(/salary_day_changed_at/);
    expect(SALARY).not.toMatch(/<Provenance/);
    // And the consequence that IS real is still stated.
    expect(SALARY).toMatch(/Existing plans keep their current schedule/);
  });

  it('SALARY AMOUNT renders no provenance line either — same absence, same reason', () => {
    // profiles has no salary_amount_changed_at either. Same discipline as
    // salary date: no invented "last updated" line.
    expect(AMOUNT).not.toMatch(/Last changed|Last updated|last_changed|updated_at/);
    expect(AMOUNT).not.toMatch(/salary_amount_changed_at/);
    expect(AMOUNT).not.toMatch(/<Provenance/);
  });

  it('PHONE renders verification STATE but still no date', () => {
    // A phone change requires OTP re-verification, and the promotion writes
    // phone and phone_verified_at in ONE update — so the timestamp can no
    // longer describe anything but the current number. Stating the state is
        // therefore honest, and it is required.
    //
    // What remains banned is a DATE. "Verified 12 Mar 2026" would invite the
    // reader to treat the age of the verification as meaningful, and nothing
    // acts on it; the binary fact is the whole of what we know.
    expect(PHONE).toMatch(/phone-state-verified/);
    expect(PHONE).toMatch(/phone-state-unverified/);
    expect(PHONE).not.toMatch(/Last updated|Last changed/);
    expect(PHONE).not.toMatch(/formatDate|toLocaleDateString/);
    expect(PHONE).not.toMatch(/<Provenance/);
  });

  it('neither the index page nor Personal details reads the flag-gated verification columns', () => {
    // liveness_verified_at and credit_check_completed_at sit behind flags
    // that default off, and liveness is a stub that always passes.
    for (const [name, src] of [['page', PAGE], ['personal', PERSONAL]] as const) {
      expect(src, name).not.toMatch(/liveness_verified_at/);
      expect(src, name).not.toMatch(/credit_check_completed_at/);
      expect(src, name).not.toMatch(/Identity verified/);
    }
  });

  it('card provenance comes from the column already selected', () => {
    expect(CARDS).toMatch(/Added \{formatDate\(card\.created_at\.slice\(0, 10\)\)\}/);
    // Reuses the shared formatter rather than adding another local copy.
    expect(CARDS).toMatch(/import \{ formatDate \} from '@\/app\/patient\/_format'/);
  });
});

// ─── Empty states ─────────────────────────────────────────────────────────

describe('every empty state has an icon and a sentence', () => {
  it('all six use the shared EmptyState, not a hand-rolled block', () => {
    for (const [name, src] of [
      ['page (record)', PAGE],
      ['phone',         PHONE],
      ['salary day',    SALARY],
      ['salary amount', AMOUNT],
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
    expect(AMOUNT).not.toMatch(/: '—'/);
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
  it('the phone action still validates, normalises and revalidates — including the new Personal details route', () => {
    expect(PHONE_ACTIONS).toMatch(/'use server'/);
    expect(PHONE_ACTIONS).toMatch(/normalizePhoneZA\(/);
    expect(PHONE_ACTIONS).toMatch(/code: 'invalid_phone'/);
    expect(PHONE_ACTIONS).toMatch(/revalidatePath\('\/patient\/account'\)/);
    expect(PHONE_ACTIONS).toMatch(/revalidatePath\('\/patient\/account\/personal'\)/);
    expect(PHONE_ACTIONS).toMatch(/\.update\(\{ phone_pending: normalized \}\)/);
  });

  it('the salary day action still gates on ALLOWED_SALARY_DAYS and revalidates both routes', () => {
    expect(ACTIONS).toMatch(/if \(!isAllowedSalaryDay\(day\)\)/);
    expect(ACTIONS).toMatch(/\.update\(\{ salary_day: day \}\)/);
    expect(ACTIONS).toMatch(/revalidatePath\('\/patient\/account\/personal'\)/);
    expect(ACTIONS).toMatch(/revalidatePath\('\/patient'\)/);
  });

  it('the salary amount action gates on isValidSalaryAmount and revalidates both routes', () => {
    expect(ACTIONS).toMatch(/if \(!isValidSalaryAmount\(amount\)\)/);
    expect(ACTIONS).toMatch(/\.update\(\{ salary_amount: amount \}\)/);
  });

  it('both salary actions are passed into Personal details, not built inline there', () => {
    expect(PERSONAL).toMatch(/saveSalaryDay,\s*saveSalaryAmount/);
    expect(PERSONAL).toMatch(/saveSalaryDay=\{saveSalaryDay\}/);
    expect(PERSONAL).toMatch(/saveSalaryAmount=\{saveSalaryAmount\}/);
  });

  it('the card actions are still the same three, passed through unchanged — now on the Payment cards screen', () => {
    expect(PAY).toMatch(/initializeCardRegistration=\{initializeCardRegistration\}/);
    expect(PAY).toMatch(/changeDefaultCard=\{changeDefaultCard\}/);
    expect(PAY).toMatch(/removeCard=\{removeCard\}/);
  });

  it('the card removal lock is still computed server-side', () => {
    expect(PAY).toMatch(/lockedCardIds=\{lockedCardIds\}/);
    expect(PAY).toMatch(/activeTokens\.has\(c\.token\)/);
    // The server-only token is still stripped before cards reach the client.
    expect(PAY).toMatch(/map\(\(\{ token: _token, \.\.\.row \}\) => row\)/);
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

describe('the account route tree still uses the shared loading skeleton', () => {
  it('loading.tsx is the shared DelayedSkeleton + PatientShellShape', () => {
    expect(LOADING).toMatch(/from '@\/components\/loading\/DelayedSkeleton'/);
    expect(LOADING).toMatch(/from '@\/components\/loading\/PatientShellShape'/);
    expect(LOADING).toMatch(/<DelayedSkeleton>/);
    expect(LOADING).toMatch(/<PatientDetailShape/);
  });

  it('no second skeleton system was introduced alongside it, on the index or any sub-screen', () => {
    // The rework adds six new routes, which is exactly when someone
    // hand-rolls a shimmer div rather than relying on the one loading.tsx
    // that already covers the whole /patient/account subtree.
    expect(LOADING).not.toMatch(/animate-pulse|animate-spin/);
    for (const [name, src] of [['page', PAGE], ['settings', SETTINGS], ['personal', PERSONAL], ['pay', PAY]] as const) {
      expect(src, name).not.toMatch(/animate-pulse/);
      expect(src, name).not.toMatch(/Skeleton/);
    }
  });
});
