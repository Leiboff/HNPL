import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── /practice/details — the new practice settings page ────────────────
//
// Replaces the settings half of /brand/branch/[practiceId], which was
// simultaneously a multi-branch PERFORMANCE view and the de-facto
// settings page. For a single practice that meant opening "Practice
// details" and getting a revenue rollup restating their own dashboard, a
// second Team roster, and no practice nav at all — the route sits under
// /brand/**, outside the shell's tree.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const PAGE  = read('app/practice/details/page.tsx');
const LINKS = read('app/practice/practiceManagerLinks.ts');

describe('contents — details + banking ONLY', () => {
  it('renders the details and banking forms', () => {
    expect(PAGE).toMatch(/<BranchDetailsForm/);
    expect(PAGE).toMatch(/<BranchBankingForm/);
  });

  it('has NO revenue or performance rollup', () => {
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
    // It doesn't even read the roster.
    expect(PAGE).not.toMatch(/from\('practice_members'\)[\s\S]{0,200}hpcsa_number/);
  });

  it('has NO by-doctor breakdown', () => {
    expect(PAGE).not.toMatch(/By doctor/);
    expect(PAGE).not.toMatch(/doctorRows/);
    expect(PAGE).not.toMatch(/byProvider/);
  });

  it('keeps the read-only status + commission line (set by BetterNow)', () => {
    expect(PAGE).toMatch(/Commission: \{Number\(practice\.fee_percent/);
    expect(PAGE).toMatch(/Status and commission are set by BetterNow/);
  });
});

describe('the forms were MOVED, not rewritten', () => {
  it('the two form components now live beside this page and nowhere else', () => {
    expect(existsSync(resolve(ROOT, 'app/practice/details/BranchDetailsForm.tsx'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'app/practice/details/BranchBankingForm.tsx'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'app/brand/branch/[practiceId]/BranchDetailsForm.tsx'))).toBe(false);
    expect(existsSync(resolve(ROOT, 'app/brand/branch/[practiceId]/BranchBankingForm.tsx'))).toBe(false);
  });

  it('still saves through the EXISTING brand actions — no new write path', () => {
    expect(PAGE).toMatch(/import \{ updateBranchDetails, updateBranchBanking \} from '@\/app\/brand\/actions'/);
    expect(PAGE).toMatch(/saveAction=\{updateBranchDetails\}/);
    expect(PAGE).toMatch(/saveAction=\{updateBranchBanking\}/);
  });

  it('the banking form still posts the same tuple to the same action (regression)', () => {
    const FORM = read('app/practice/details/BranchBankingForm.tsx');
    expect(FORM).toMatch(/import type \{ UpdateBranchBankingInput \} from '@\/app\/brand\/actions'/);
    for (const field of ['bankName', 'bankAccountNumber', 'branchCode', 'accountHolder', 'accountType']) {
      expect(FORM).toContain(`${field}:`);
    }
    // Saves via the injected action, not a hand-rolled fetch/insert.
    expect(FORM).toMatch(/await saveAction\(\{/);
    expect(FORM).not.toMatch(/createClient|fetch\(/);
  });

  it('both save actions still carry their original guard, and now revalidate this route', () => {
    const ACTIONS = read('app/brand/actions.ts');
    // Slice each action from its signature to its closing brace at column
    // 0, so the window is the function body rather than a guessed length.
    const bodyOf = (name: string) => {
      const from = ACTIONS.indexOf(`export async function ${name}`);
      expect(from).toBeGreaterThan(0);
      const end = ACTIONS.indexOf('\n}\n', from);
      return ACTIONS.slice(from, end);
    };
    for (const name of ['updateBranchDetails', 'updateBranchBanking']) {
      const body = bodyOf(name);
      expect(body).toMatch(/guardBrandAdminOfPractice\(input\.practiceId\)/);
      expect(body).toMatch(/revalidatePath\('\/practice\/details'\)/);
      // The retired route is no longer revalidated by these two.
      expect(body).not.toMatch(/revalidatePath\(`\/brand\/branch\//);
    }
  });
});

describe('gating — matches what already guards this content, and does not loosen it', () => {
  it('gates on brand-admin authority, resolved not assumed', () => {
    // The two save actions are guarded by guardBrandAdminOfPractice — an
    // active practice_group_members row for the practice's group, NOT
    // can_manage_practice. Viewing is gated on exactly that.
    expect(PAGE).toMatch(/resolvePracticeShellAuthority\(/);
    expect(PAGE).toMatch(/if \(!isBrandAdmin\) notFound\(\)/);
  });

  it('does NOT accept can_manage_practice as a substitute for brand-admin', () => {
    // can_manage_practice is read, but only as an INPUT to canManageTill.
    expect(PAGE).not.toMatch(/if \(!canManageTill\) notFound/);
    expect(PAGE).not.toMatch(/isBrandAdmin \|\|/);
    expect(PAGE).not.toMatch(/canManagePractice \|\| isBrandAdmin/);
  });

  it('fails closed on a practice that does not resolve', () => {
    expect(PAGE).toMatch(/if \(!practice\) notFound\(\)/);
  });

  it('keeps the same auth + role gate as every other practice screen', () => {
    expect(PAGE).toMatch(/requireConfirmedUser\(\{ next: '\/practice\/details' \}\)/);
    expect(PAGE).toMatch(/profile\?\.role !== 'practice_admin' && profile\?\.role !== 'practice_staff'/);
  });

  it('reads the practice with service-role only AFTER the gate', () => {
    // A brand-admin-only caller has no practice_members row for RLS to
    // key off (0061 widened practices but is_practice_member never was),
    // so the read must be elevated — but only once authorized.
    const gateIdx = PAGE.indexOf('if (!isBrandAdmin) notFound()');
    const svcIdx  = PAGE.indexOf('const s = svc()');
    expect(gateIdx).toBeGreaterThan(0);
    expect(svcIdx).toBeGreaterThan(gateIdx);
  });
});

describe('navigation — inherits the shell, hand-rolls nothing', () => {
  it('renders PracticeShell rather than its own nav or back-header', () => {
    expect(PAGE).toMatch(/<PracticeShell/);
    expect(PAGE).not.toMatch(/← Back to dashboard/);
    expect(PAGE).not.toMatch(/← Back to my practices/);
    expect(PAGE).not.toMatch(/<nav/);
  });

  it('the shared link source points "Practice details" here, still isBrandAdmin-gated', () => {
    expect(LINKS).toMatch(/if \(isBrandAdmin && practiceId\)/);
    expect(LINKS).toMatch(/href: `\/practice\/details\$\{scopeSuffix\}`, label: 'Practice details'/);
    // Comments stripped first: the file legitimately explains in prose
    // where this link used to point. What must not survive is a real href.
    const code = LINKS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/\/brand\/branch\//);
  });

  it('carries the practice scope so a brand-admin with N branches edits the right one', () => {
    expect(PAGE).toMatch(/params\.practiceId/);
    expect(PAGE).toMatch(/practiceId=\{practiceId\}/);
  });
});
