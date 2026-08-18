import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── Authority-before-data, second slice ─────────────────────────────────
//
// Companion to ./parallelisation-authority-order.test.ts, which covers the
// five routes whose gate is the same shape (requireConfirmedUser → role →
// scope) and could therefore share one table.
//
// These cannot. /checkout/[token] is anonymous and authorised by a TOKEN
// rather than a session; each practice screen here has a different gate; and
// the layout/page de-duplication is not about ordering within one file at
// all. Forcing them into the sibling's table would have meant weakening it to
// the intersection of five different gates, so they get bespoke assertions.
//
// Everything here reads SOURCE TEXT, for the same reason the sibling does:
// these are async server components composing several helpers, with no single
// fake client to drive.

const ROOT = resolve(process.cwd());
const read = (p: string) => stripComments(readFileSync(resolve(ROOT, p), 'utf8'));

const CHECKOUT = 'app/checkout/[token]/page.tsx';

describe('/checkout/[token] — the token IS the authorisation', () => {
  it('resolves a token before reading anything about the plan', () => {
    // This route has no session gate by design: the token in the URL is proof
    // the visitor controls the invited inbox. That makes the token RPC the
    // gate, and it must clear before any plan data is touched. The plan read
    // and the session read now share a wave — that wave must come SECOND.
    const code = read(CHECKOUT);
    const tokenWave = code.indexOf('await Promise.all([');
    const planRead  = code.indexOf("from('plans')");
    expect(tokenWave).toBeGreaterThan(0);
    expect(planRead).toBeGreaterThan(tokenWave);

    // And the FIRST wave contains only the two token RPCs.
    const firstWave = code.slice(tokenWave, code.indexOf(']);', tokenWave));
    expect(firstWave).toContain('get_invitation_by_token');
    expect(firstWave).toContain('get_checkout_session_by_token');
    expect(firstWave).not.toContain("from('plans')");
    expect(firstWave).not.toContain('auth.getUser()');
  });

  it('refuses before the plan read when NEITHER token resolves', () => {
    // `if (!resolved)` must be acted on before the plan wave, or an
    // invalid / expired / already-used token would still have started a
    // service-role read against the plan it names.
    const code = read(CHECKOUT);
    expect(code.indexOf('if (!resolved)')).toBeGreaterThan(0);
    expect(code.indexOf('if (!resolved)')).toBeLessThan(code.indexOf("from('plans')"));
  });

  it('keeps invitation precedence EXPLICIT now that both RPCs run concurrently', () => {
    // The sequential version expressed precedence implicitly, by only asking
    // the second question when the first had no answer. Running both
    // concurrently removes that, so the branch must state it outright.
    const code = read(CHECKOUT);
    const invBranch  = code.indexOf('if (invRows.length > 0)');
    const sessBranch = code.indexOf('sessionRows.length > 0');
    expect(invBranch).toBeGreaterThan(0);
    expect(invBranch).toBeLessThan(sessBranch);
    expect(code).toMatch(/resolved = \{ kind: 'invitation'/);
  });

  it('preserves both RPC error paths, each still reporting only for itself', () => {
    // An invitation-side failure must still produce the invitation message and
    // must never be able to speak for a session-side one. So the session error
    // is checked INSIDE the else branch — reachable only when the invitation
    // lookup returned no rows, exactly as it was when the calls were serial.
    const code = read(CHECKOUT);
    const invErr  = code.indexOf('if (invRpcErr)');
    const invWin  = code.indexOf('if (invRows.length > 0)');
    const sessErr = code.indexOf('if (sessionRpcErr)');
    expect(invErr).toBeGreaterThan(0);
    expect(invErr).toBeLessThan(invWin);      // invitation error short-circuits
    expect(sessErr).toBeGreaterThan(invWin);  // session error lives in the else
  });

  it('never lets one non-fatal tail read take the other down', () => {
    // The salary_day lookup and the viewed/scanned stamp share a wave. Both
    // are documented as non-fatal INDEPENDENTLY, and Promise.all rejects on
    // the first rejection — so each needs its own catch INSIDE the wave. One
    // shared try/catch around the wave would let a salary-day blip silently
    // suppress the practice-side "Viewed" signal, which is a data loss nobody
    // would see in the rendered output.
    const code = read(CHECKOUT);
    const from = code.indexOf('const [initialSalaryDay]');
    expect(from).toBeGreaterThan(0);
    const arm = code.slice(from, code.indexOf(']);', from));
    expect((arm.match(/try \{/g) ?? []).length).toBe(2);
    expect((arm.match(/catch \(err\)/g) ?? []).length).toBe(2);
  });

  it('still stamps viewed/scanned only AFTER the existing-account redirect', () => {
    // PRE-EXISTING behaviour, pinned here because the stamp moved: a caller
    // who already has an account is redirected to /login and the invitation is
    // never stamped as viewed. Whether that is correct is a separate question
    // (it is reported, not changed) — this asserts the parallelisation did not
    // quietly alter it while the code was being moved.
    const code = read(CHECKOUT);
    const bounce = code.indexOf('if (existingAccount)');
    expect(bounce).toBeGreaterThan(0);
    expect(code.indexOf('supabase.rpc(stampRpc')).toBeGreaterThan(bounce);
  });

  it('builds ONE service-role client, not two', () => {
    // The salary_day lookup used to construct its own, with identical URL, key
    // and options. Deleting duplicate work beats scheduling it.
    expect((read(CHECKOUT).match(/createServiceClient\(/g) ?? []).length).toBe(1);
  });
});

describe('the practice screens keep their gates ahead of their waves', () => {
  it('members: the viewer gate clears before the roster wave starts', () => {
    const code = read('app/practice/members/page.tsx');
    const wave = code.indexOf('await Promise.all([');
    expect(wave).toBeGreaterThan(0);
    for (const gate of [
      'resolvePracticeViewer(',
      "viewer.kind === 'setup'",
      "viewer.kind === 'denied'",
    ]) {
      expect(code.indexOf(gate), gate).toBeGreaterThan(0);
      expect(code.indexOf(gate), gate).toBeLessThan(wave);
    }
    // The service-role escalation is still decided by the resolver's
    // viaBrandAdmin, not by anything inside the wave.
    expect(code.indexOf('viaBrandAdmin ? svc : supabase')).toBeLessThan(wave);
  });

  it('settings: the authority chain stays serial, because it IS a chain', () => {
    // myMembership feeds resolvePracticeShellAuthority, which feeds
    // canSeeAnySettingsSection. Each step needs the previous one's result, so
    // none of them may join a wave — and the wave must start after the last.
    const code = read('app/practice/settings/page.tsx');
    const order = [
      'requireConfirmedUser(',
      "from('profiles')",
      "select('can_manage_practice')",
      'resolvePracticeShellAuthority(',
      'if (!canSeeAnySettingsSection(authority)) notFound()',
      'await Promise.all([',
    ].map((needle) => [needle, code.indexOf(needle)] as const);
    for (const [needle, at] of order) expect(at, needle).toBeGreaterThan(0);
    const positions = order.map(([, at]) => at);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('bills/new: membership resolution precedes the wave; the gate still bounces', () => {
    const code = read('app/practice/bills/new/page.tsx');
    const wave = code.indexOf('await Promise.all([');
    expect(wave).toBeGreaterThan(0);
    // Authority for this page: the membership read and its empty-case bounce.
    expect(code.indexOf("from('practice_members')")).toBeLessThan(wave);
    expect(code.indexOf('if (memberRows.length === 0) redirect')).toBeLessThan(wave);
    // The trading gate is business READINESS, not permission, so it is allowed
    // in the wave — but its refusal must still fire before anything renders.
    const bounce = code.indexOf('if (!gate.ok)');
    expect(bounce).toBeGreaterThan(wave);
    expect(code.indexOf('<PracticeShell')).toBeGreaterThan(bounce);
  });

  it('setup: the redirect order survives, because the second read leads to a WRITE', () => {
    // membership and ownedPractice now resolve together. If `if (membership)`
    // ever stopped coming first, a caller who already has a membership could
    // reach the self-heal INSERT below it.
    const code = read('app/practice/setup/page.tsx');
    const wave       = code.indexOf('await Promise.all([');
    const memberGate = code.indexOf('if (membership)');
    const orphan     = code.indexOf('if (ownedPractice)');
    const insert     = code.indexOf("from('practice_members').insert(");
    expect(wave).toBeGreaterThan(0);
    expect(memberGate).toBeGreaterThan(wave);
    expect(orphan).toBeGreaterThan(memberGate);
    expect(insert).toBeGreaterThan(memberGate);
    // The role gate is still ahead of the wave entirely.
    expect(code.indexOf("profile?.role !== 'practice_admin'")).toBeLessThan(wave);
  });
});
