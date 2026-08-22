import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── What we tell someone whose bill we can't match to them ───────────────
//
// This surface is read by a patient standing at a counter, mid-payment,
// with a receptionist beside them. Before this it did not exist: the page
// redirected to /patient?reason=invitation_not_yours and /patient reads
// only `welcome` from its searchParams, so the reason was discarded and the
// patient got no explanation at all.
//
// Two properties matter and neither is about wording:
//   1. The message appears HERE, not one navigation away.
//   2. It is TRUE for the specific situation, which needs four buckets —
//      a catch-all would tell the largest group (accounts with no SA ID at
//      all, ~56 of them after the duplicate cleanup) to "check the ID
//      number on the bill", sending reception to inspect a correct bill.
//
// Comments are stripped: the page's own prose discusses the redirect it
// replaced, and an absence assertion would otherwise trip on the history.

const ROOT = resolve(process.cwd());
const read = (p: string) => stripComments(readFileSync(resolve(ROOT, p), 'utf8'));

const PAGE    = read('app/checkout/[token]/page.tsx');
const COPYSRC = read('app/checkout/[token]/_lib/billMatchCopy.ts');
const CLAIM   = read('lib/checkout/claimSessionPlan.ts');
const PATIENT = read('app/patient/page.tsx');

/** The card's copy table, as source text. */
const COPY   = COPYSRC.slice(COPYSRC.indexOf('export const BILL_MATCH_COPY'), COPYSRC.indexOf('export function billMatchFailureFor'));
/** The reason → bucket mapper, as source text. */
const MAPPER = COPYSRC.slice(COPYSRC.indexOf('export function billMatchFailureFor'));

describe('the bug was the redirect, not the wording', () => {
  it('the page no longer sends anyone to /patient with a reason code', () => {
    expect(PAGE).not.toMatch(/invitation_not_yours/);
    expect(PAGE).not.toMatch(/redirect\('\/patient\?reason=/);
  });

  it('/patient still reads only `welcome` — which is exactly why the old reason went nowhere', () => {
    // Pinned so the diagnosis stays checkable rather than becoming folklore.
    // If someone later teaches /patient to render reason codes, this test
    // failing is the prompt to reconsider where this message belongs.
    expect(PATIENT).toMatch(/searchParams: Promise<\{ welcome\?: string \}>/);
    expect(PATIENT).not.toMatch(/reason/);
  });

  it('renders in place instead, on the screen the patient is already looking at', () => {
    expect(PAGE).toMatch(
      /failure=\{billMatchFailureFor\(\s*claimRefusal, resolved\.kind, planPatientId !== null, tokenSaIdEncrypted !== null,\s*\)\}/,
    );
  });

  it('the authorization rule is untouched — a non-owner still never reaches the plan', () => {
    const ownerBranch = PAGE.indexOf('if (planPatientId === sessionUser.id)');
    const card        = PAGE.indexOf('<BillMatchCard');
    expect(ownerBranch).toBeGreaterThan(0);
    expect(card).toBeGreaterThan(ownerBranch);
    expect(PAGE).toMatch(/redirect\(confirmPath\)/);
  });
});

describe('every refusal the claim can produce maps to a bucket', () => {
  const REASONS = ['already_bound', 'no_profile_id', 'id_mismatch', 'decrypt_failed', 'write_failed'];

  it('the claim still declares exactly the five refusals this maps', () => {
    // If a sixth is added, this fails and forces a decision about what the
    // person at the counter is told — rather than silently defaulting.
    const union = CLAIM.slice(CLAIM.indexOf("{ claimed: false; reason:"));
    for (const r of REASONS) expect(union).toContain(`'${r}'`);
    const declared = [...union.slice(0, union.indexOf('}')).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect([...declared].sort()).toEqual([...REASONS].sort());
  });

  it('no_profile_id → the bucket that does NOT blame the bill', () => {
    expect(MAPPER).toMatch(/case 'no_profile_id':\s*return 'no_account_id';/);
  });

  it('decrypt_failed and write_failed → our fault, never the patient\'s', () => {
    expect(MAPPER).toMatch(/case 'decrypt_failed':\s*case 'write_failed':\s*return 'our_fault';/);
  });

  it('id_mismatch and already_bound share a bucket — at a counter they are the same event', () => {
    expect(MAPPER).toMatch(/case 'id_mismatch':\s*case 'already_bound':\s*default:\s*return 'id_mismatch';/);
  });
});

describe('the two paths that never consult the claim at all', () => {
  it('an INVITATION token is decided before the claim reason is even read', () => {
    // Reason 7 in the investigation: an emailed bill opened while signed in
    // as somebody else. claimUnboundSessionPlan is gated on
    // `resolved.kind === 'session'`, so it never runs — copy keyed only off
    // the claim outcome would leave this path uncovered.
    expect(MAPPER).toMatch(/if \(tokenKind === 'invitation'\) \{/);
  });

  it('an invitation splits on whether the bill actually reached an account', () => {
    // The re-derivation. Both arms are invitations opened by the wrong
    // signed-in user, but only one of them has another account to send
    // that person to.
    expect(MAPPER).toMatch(/if \(planIsBound\) return 'different_account';/);
    expect(MAPPER).toMatch(/if \(!tokenCarriesId\) return 'unclaimed_invitation';/);
  });

  it('an already-owned SESSION plan skips the claim and still lands somewhere true', () => {
    // Reason 6: the claim block is gated on planPatientId === null, so a
    // session plan owned by someone else leaves claimRefusal null. The
    // default arm catches it.
    expect(PAGE).toMatch(/planPatientId === null && tokenSaIdEncrypted\)/);
    expect(PAGE).toMatch(/let claimRefusal: ClaimOutcome\['reason'\] \| null = null;/);
    expect(MAPPER).toMatch(/default:\s*return 'id_mismatch';/);
  });
});


describe('the copy itself', () => {
  it('has one entry per bucket, and only these five buckets exist', () => {
    const union = COPYSRC.slice(COPYSRC.indexOf('export type BillMatchFailure'), COPYSRC.indexOf('export type BillMatchCopy'));
    const declared = [...union.matchAll(/\|\s*'([a-z_]+)'/g)].map((m) => m[1]);
    expect(declared.sort()).toEqual([
      'different_account', 'id_mismatch', 'no_account_id', 'our_fault', 'unclaimed_invitation',
    ]);
    for (const b of declared) expect(COPY).toContain(`${b}: {`);
  });

  it('every bucket gives a heading, a plain statement, and a NEXT STEP', () => {
    const entries = [...COPY.matchAll(/heading:\s*['"]/g)];
    expect(entries.length).toBe(5);
    expect([...COPY.matchAll(/body:\s*'/g)].length).toBe(5);
    expect([...COPY.matchAll(/next:\s*'/g)].length).toBe(5);
  });

  it('never claims the bill isn\'t theirs — the old message\'s actual lie', () => {
    expect(COPY).not.toMatch(/isn.t yours|not yours|belongs to someone else/i);
  });

  it('the no-ID bucket does NOT send them to add an ID, because that path is a wall', () => {
    // Since 0097 /onboarding/identity refuses an ID another account holds,
    // which is exactly the situation this bucket describes. Offering it
    // would be a corridor with a known dead end at the far side.
    const bucket = COPY.slice(COPY.indexOf('no_account_id: {'), COPY.indexOf('our_fault: {'));
    expect(bucket).not.toMatch(/onboarding|add your ID|add an ID/i);
    expect(bucket).toMatch(/can’t be fixed from your side/);
  });

  it('the bound-elsewhere bucket points at an account that actually exists', () => {
    // Bounded slice: 'unclaimed_invitation' follows this entry and DOES
    // mention an ID number, correctly — an unbounded slice would read the
    // next bucket's copy and draw the opposite conclusion.
    const bucket = COPY.slice(COPY.indexOf('different_account: {'), COPY.indexOf('unclaimed_invitation: {'));
    expect(bucket).toMatch(/sign in with the one the bill was emailed to/i);
  });

  it('the unclaimed-invitation bucket does NOT send them after an account that does not exist', () => {
    // Reaching it means neither the ID nor the address had an account at
    // issuance. "Sign in with the other account" would be a wall.
    const bucket = COPY.slice(COPY.indexOf('unclaimed_invitation: {'));
    expect(bucket).not.toMatch(/sign in with/i);
    expect(bucket).toMatch(/ask reception to re-issue it/i);
  });

  it('the our-fault bucket blames neither the patient nor the practice', () => {
    const bucket = COPY.slice(COPY.indexOf('our_fault: {'), COPY.indexOf('different_account: {'));
    expect(bucket).toMatch(/on our side/);
    expect(bucket).toMatch(/isn’t a problem with the bill or with your account/);
  });

  it('leaks nothing about the other account', () => {
    expect(COPY).not.toMatch(/\$\{/);          // no interpolated email/name
    expect(COPY).not.toMatch(/email:/);
  });

  it('gives everyone a way off the screen', () => {
    const card = PAGE.slice(PAGE.indexOf('function BillMatchCard'));
    expect(card).toMatch(/href="\/patient"/);
  });
});

describe('the shared card shell', () => {
  it('InvalidLinkCard keeps its heading — the extraction changed no existing surface', () => {
    expect(PAGE).toMatch(/<NoticeCard heading="This link is no longer valid">/);
    expect(PAGE).toMatch(/ask your practice to send you a new bill/);
  });

  it('the heading is a prop now, so a second surface cannot inherit a false one', () => {
    expect(PAGE).toMatch(/function NoticeCard\(\{ heading, children \}/);
    expect(PAGE).toMatch(/<h1 [^>]*>\{heading\}<\/h1>/);
  });
});

describe('the deliberate enumeration divergence is written down where it will be found', () => {
  it('the checkout gate explains why it names the situation', () => {
    // Left UNSTRIPPED on purpose: the whole point is that the reasoning
    // lives in a comment beside the code someone would otherwise "fix"
    // for consistency with findExistingAuthUser.
    const raw = readFileSync(resolve(ROOT, 'app/checkout/[token]/actions.ts'), 'utf8');
    expect(raw).toMatch(/DELIBERATELY diverges from findExistingAuthUser/);
    expect(raw).toMatch(/Do not "fix" it for/);
  });

  it('the onboarding gate points at that explanation rather than repeating it', () => {
    // The organic-signup ID-capture path (and its "deliberate divergence"
    // note) moved from saveIdAndSalaryDay (lib/onboarding/actions.ts) to
    // the Didit webhook's handleApproved — see
    // app/api/verification/didit/webhook/route.ts.
    const raw = readFileSync(resolve(ROOT, 'app/api/verification/didit/webhook/route.ts'), 'utf8');
    expect(raw).toMatch(/deliberate divergence from\s*\/\/\s*findExistingAuthUser/);
  });

  it('the within-role uniqueness question is logged where the next person hits it', () => {
    const raw = readFileSync(resolve(ROOT, 'scripts/strip-duplicate-sa-ids.ts'), 'utf8');
    expect(raw).toMatch(/OPEN QUESTION — uniqueness WITHIN role/);
  });
});

describe('nothing else on this route regressed', () => {
  it('no migration was added for a copy change', () => {
    const before = readdirSync(resolve(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql'));
    expect(before.filter((f) => /bill_match|not_yours|copy/i.test(f))).toEqual([]);
  });

  it('the claim, the gates and the propagation helpers are untouched by this change', () => {
    expect(CLAIM).toMatch(/\.is\('patient_id', null\)/);
    expect(CLAIM).toMatch(/reason: 'id_mismatch'/);
    expect(PAGE).toMatch(/claimUnboundSessionPlan\(\{/);
  });
});
