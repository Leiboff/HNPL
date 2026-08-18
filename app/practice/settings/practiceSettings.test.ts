import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── /practice/settings — three folded screens, three surviving gates ─────
//
// Inherits and repoints every invariant the old /practice/details suite
// pinned (that page is now a redirect), and adds the ones the fold created:
// each section keeps its own authority, and the forms were MOUNTED rather
// than rewritten.
//
// Source-level because the page is an async server component. The pure
// visibility logic it delegates to is unit-tested in ./settingsSections.test.ts.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

// Shared helper — see lib/testing/stripComments.ts. This page is the file that
// exposed the bug: it discusses paths like `app/practice/pos/devices/**` inside
// `//` prose, and a hand-rolled block-then-line strip read that `/**` as a
// comment opener and deleted 3,443 of its 13,835 characters — which made eight
// absence assertions below pass for the wrong reason.
const codeOf = (src: string) => stripComments(src);

const PAGE_SRC = read('app/practice/settings/page.tsx');
const PAGE     = codeOf(PAGE_SRC);
const LINKS    = codeOf(read('app/practice/practiceManagerLinks.ts'));

// ─── Contents ─────────────────────────────────────────────────────────────

describe('contents — details, banking, till devices, and nothing else', () => {
  it('mounts all three, each in its own anchored section', () => {
    expect(PAGE).toMatch(/<BranchDetailsForm/);
    expect(PAGE).toMatch(/<BranchBankingForm/);
    expect(PAGE).toMatch(/<DeviceAdminView/);
    for (const id of ['details', 'banking', 'till']) {
      expect(PAGE).toMatch(new RegExp(`id="${id}"`));
    }
  });

  it('has NO revenue or performance rollup', () => {
    // Cross-branch comparison lives at /brand, the one place several
    // branches are seen side by side.
    expect(PAGE).not.toMatch(/BranchPerformance/);
    expect(PAGE).not.toMatch(/computeRevenue/);
    expect(PAGE).not.toMatch(/buildMonthlySeries/);
    expect(PAGE).not.toMatch(/BrandMonthlyChart/);
    expect(PAGE).not.toMatch(/totalNet/);
  });

  it('has NO Team section — /practice/members is the team surface', () => {
    expect(PAGE).not.toMatch(/TeamSection/);
    expect(PAGE).not.toMatch(/addTeamMember/);
    expect(PAGE).not.toMatch(/deactivateTeamMember/);
    expect(PAGE).not.toMatch(/from\('practice_members'\)[\s\S]{0,200}hpcsa_number/);
  });

  it('has NO bills list — that is the Bills tab', () => {
    expect(PAGE).not.toMatch(/BillsTable|BillsBrowser|BillsBlock/);
  });

  it('keeps the read-only status + commission line (set by BetterNow)', () => {
    expect(PAGE).toMatch(/Commission: \{Number\(practice\.fee_percent/);
    expect(PAGE).toMatch(/Status and commission are set by BetterNow/);
  });

  it('keeps the banking hint and its #banking jump', () => {
    // Moved here WITH the banking form. The dashboard's trading-gate CTA and
    // the setup checklist both deep-link to #banking.
    expect(PAGE).toMatch(/branch-banking-hint/);
    expect(PAGE).toMatch(/gate\.reason === 'no_banking'/);
    expect(PAGE).toMatch(/href="#banking"/);
  });

  it('shows the banking hint only to someone who can act on it', () => {
    // A manager who cannot see the banking section must not be told to
    // "add banking below" — there is no below for them.
    expect(PAGE).toMatch(/showBanking && !gate\.ok && gate\.reason === 'no_banking'/);
  });
});

// ─── The forms were MOUNTED, not rewritten ────────────────────────────────

describe('reorganisation, not a rebuild', () => {
  it('the components still live where their own test suites address them', () => {
    // Deliberately NOT moved: app/brand/brand-dashboard.test.ts and the
    // device-admin suites all address these paths, and a file move would
    // have meant editing tests for code that did not change.
    for (const p of [
      'app/practice/details/BranchDetailsForm.tsx',
      'app/practice/details/BranchBankingForm.tsx',
      'app/practice/pos/devices/DeviceAdminView.tsx',
      'app/practice/pos/devices/actions.ts',
    ]) {
      expect(existsSync(resolve(ROOT, p)), p).toBe(true);
    }
    expect(existsSync(resolve(ROOT, 'app/brand/branch/[practiceId]/BranchDetailsForm.tsx'))).toBe(false);
    expect(existsSync(resolve(ROOT, 'app/brand/branch/[practiceId]/BranchBankingForm.tsx'))).toBe(false);
  });

  it('imports them from there rather than carrying copies', () => {
    expect(PAGE).toMatch(/import BranchDetailsForm from '\.\.\/details\/BranchDetailsForm'/);
    expect(PAGE).toMatch(/import BranchBankingForm from '\.\.\/details\/BranchBankingForm'/);
    expect(PAGE).toMatch(/import DeviceAdminView from '\.\.\/pos\/devices\/DeviceAdminView'/);
  });

  it('still saves through the EXISTING actions — no new write path', () => {
    expect(PAGE).toMatch(/import \{ updateBranchDetails, updateBranchBanking \} from '@\/app\/brand\/actions'/);
    expect(PAGE).toMatch(/saveAction=\{updateBranchDetails\}/);
    expect(PAGE).toMatch(/saveAction=\{updateBranchBanking\}/);
    // And the six device/PIN actions, from their own module.
    expect(PAGE).toMatch(/from '\.\.\/pos\/devices\/actions'/);
    for (const fn of [
      'generateDeviceRegistrationCode', 'revokeDevice', 'setTillPin',
      'generateTillPinValue', 'listDevices', 'relabelDevice',
    ]) {
      expect(PAGE).toMatch(new RegExp(`\\b${fn}\\b`));
    }
  });

  it('the banking form still posts the same tuple to the same action (regression)', () => {
    const FORM = read('app/practice/details/BranchBankingForm.tsx');
    expect(FORM).toMatch(/import type \{ UpdateBranchBankingInput \} from '@\/app\/brand\/actions'/);
    for (const field of ['bankName', 'bankAccountNumber', 'branchCode', 'accountHolder', 'accountType']) {
      expect(FORM).toContain(`${field}:`);
    }
    expect(FORM).toMatch(/await saveAction\(\{/);
    expect(FORM).not.toMatch(/createClient|fetch\(/);
  });

  it('both save actions keep their original guard and revalidate the new route', () => {
    const ACTIONS = read('app/brand/actions.ts');
    const bodyOf = (name: string) => {
      const from = ACTIONS.indexOf(`export async function ${name}`);
      expect(from).toBeGreaterThan(0);
      const end = ACTIONS.indexOf('\n}\n', from);
      return ACTIONS.slice(from, end);
    };
    for (const name of ['updateBranchDetails', 'updateBranchBanking']) {
      const body = bodyOf(name);
      expect(body).toMatch(/guardBrandAdminOfPractice\(input\.practiceId\)/);
      expect(body).toMatch(/revalidatePath\('\/practice\/settings'\)/);
      // The old path is still revalidated — it still exists, as the redirect
      // that keeps every inbound link and bookmark working.
      expect(body).toMatch(/revalidatePath\('\/practice\/details'\)/);
      expect(body).not.toMatch(/revalidatePath\(`\/brand\/branch\//);
    }
  });
});

// ─── Gating — three sections, two authorities, neither loosened ───────────

describe('each section keeps its OWN gate', () => {
  it('delegates every visibility decision to the shared helper', () => {
    // Not re-derived here. The nav reads the same module, which is what makes
    // "a visible Settings item always has a section behind it" true rather
    // than coincidental.
    expect(PAGE).toMatch(/from '\.\/settingsSections'/);
    expect(PAGE).toMatch(/canSeeAnySettingsSection\(authority\)/);
    expect(PAGE).toMatch(/canSeeSettingsSection\('details',\s*authority\)/);
    expect(PAGE).toMatch(/canSeeSettingsSection\('banking',\s*authority\)/);
    expect(PAGE).toMatch(/canSeeSettingsSection\('till',\s*authority\)/);
  });

  it('resolves authority rather than assuming it', () => {
    expect(PAGE).toMatch(/resolvePracticeShellAuthority\(/);
    expect(PAGE).toMatch(/const authority = \{ isBrandAdmin, canManageTill \}/);
  });

  it('refuses the page outright when no section is visible', () => {
    expect(PAGE).toMatch(/if \(!canSeeAnySettingsSection\(authority\)\) notFound\(\)/);
  });

  it('does NOT accept can_manage_practice as a substitute for brand-admin', () => {
    // can_manage_practice is read, but only as an INPUT to canManageTill.
    // A page-wide `if (!canManageTill) notFound()` would let a plain manager
    // through to the details and banking forms.
    expect(PAGE).not.toMatch(/if \(!canManageTill\) notFound/);
    expect(PAGE).not.toMatch(/canManagePractice \|\| isBrandAdmin/);
    expect(PAGE).not.toMatch(/showDetails\s*=\s*true/);
    expect(PAGE).not.toMatch(/showBanking\s*=\s*true/);
  });

  it('sections are OMITTED rather than rendered disabled', () => {
    // Rendering the details/banking forms read-only would disclose the
    // practice's address and account number to a viewer /practice/details
    // used to refuse outright. Each form is inside its own && guard.
    expect(PAGE).toMatch(/\{showDetails && \(/);
    expect(PAGE).toMatch(/\{showBanking && \(/);
    expect(PAGE).toMatch(/\{showTill && devices !== null && \(/);
    expect(PAGE).not.toMatch(/disabled=\{!showDetails\}|disabled=\{!showBanking\}/);
  });

  it('leaves the till section’s own server guard as the authority', () => {
    // listDevices() runs guardTillManager itself. The page calls it only when
    // the section is visible, and treats a refusal as "no section" rather
    // than rendering an empty device list.
    //
    // RE-DERIVED, not relaxed: the three section reads now share one
    // Promise.all, so the call is no longer individually awaited and the old
    // literal (`showTill ? await listDevices(practiceId) : null`) cannot
    // match. The property it protected is unchanged and is asserted in three
    // parts instead of one:
    //
    //   1. listDevices is still reached ONLY through the showTill ternary —
    //      there is no second, ungated call site.
    //   2. the false arm still yields null (as a resolved promise, since it
    //      sits in a wave), so a hidden section still produces `devices ===
    //      null` rather than an empty array.
    //   3. a refusal is still treated as "no section".
    expect(PAGE).toMatch(/showTill \? listDevices\(practiceId\) : Promise\.resolve\(null\)/);
    // Exactly one call site, and it is the gated one.
    expect(PAGE.match(/listDevices\(/g) ?? []).toHaveLength(1);
    expect(PAGE).toMatch(/devicesResult && !devicesResult\.error/);
  });

  it('does not await the till read ahead of the page authority gate', () => {
    // The wave the till read now lives in must start AFTER the gate. If it
    // ever moved above `canSeeAnySettingsSection`, a caller entitled to no
    // section at all would have their device list read before being refused.
    const gateIdx = PAGE.indexOf('if (!canSeeAnySettingsSection(authority)) notFound()');
    const waveIdx = PAGE.indexOf('await Promise.all([');
    expect(gateIdx).toBeGreaterThan(0);
    expect(waveIdx).toBeGreaterThan(gateIdx);
  });

  it('fails closed on a practice that does not resolve', () => {
    expect(PAGE).toMatch(/if \(!practice\) notFound\(\)/);
  });

  it('keeps the same auth + role gate as every other practice screen', () => {
    expect(PAGE).toMatch(/requireConfirmedUser\(\{ next: '\/practice\/settings' \}\)/);
    expect(PAGE).toMatch(/profile\?\.role !== 'practice_admin' && profile\?\.role !== 'practice_staff'/);
  });

  it('reads the practice with service-role only AFTER the gate', () => {
    // A brand-admin-only caller has no practice_members row for RLS to key
    // off, so the read must be elevated — but only once authorized.
    const gateIdx = PAGE.indexOf('if (!canSeeAnySettingsSection(authority)) notFound()');
    const svcIdx  = PAGE.indexOf('const s = svc()');
    expect(gateIdx).toBeGreaterThan(0);
    expect(svcIdx).toBeGreaterThan(gateIdx);
  });

  it('carries the practice scope so a brand-admin with N branches edits the right one', () => {
    expect(PAGE).toMatch(/params\.practiceId/);
    expect(PAGE).toMatch(/practiceId=\{practiceId\}/);
  });
});

// ─── Navigation ───────────────────────────────────────────────────────────

describe('navigation — inherits the shell, hand-rolls nothing', () => {
  it('renders PracticeShell rather than its own nav or back-header', () => {
    expect(PAGE).toMatch(/<PracticeShell/);
    expect(PAGE).not.toMatch(/← Back to dashboard/);
    expect(PAGE).not.toMatch(/← Back to my practices/);
  });

  it('the in-page jump list comes from the same helper as the sections', () => {
    // So it can never offer an anchor for a section that is not on the page.
    expect(PAGE).toMatch(/visibleSettingsSections\(authority\)/);
    expect(PAGE).toMatch(/sections\.map\(\(sec\) =>/);
    expect(PAGE).toMatch(/href=\{`#\$\{sec\.anchor\}`\}/);
    // Suppressed at one section, where it would link to the thing below it.
    expect(PAGE).toMatch(/sections\.length > 1 &&/);
  });

  it('the shared link source points Settings here, gated by the same helper', () => {
    expect(LINKS).toMatch(/canSeeAnySettingsSection\(\{ isBrandAdmin, canManageTill \}\)/);
    expect(LINKS).toMatch(/href: `\/practice\/settings\$\{scopeOf\(practiceId\)\}`/);
    expect(LINKS).not.toMatch(/\/brand\/branch\//);
  });
});
