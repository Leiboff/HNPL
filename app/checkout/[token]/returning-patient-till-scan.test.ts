import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── The returning patient at a counter ───────────────────────────────────
//
// A patient who already has a BetterNow account scans a till QR. Before this,
// BOTH doors were closed:
//
//   signed in   /checkout/[token] compared plans.patient_id (NULL, because a
//               till bill has no owner) against their user id, failed, and
//               redirected to /patient?reason=invitation_not_yours — a message
//               that is not merely unhelpful but false.
//   signed out  the anonymous form ran, they typed their email, the
//               discriminator refused (then reject-organic-collision, now
//               require-login — audit A-03 widened it, see below), and the
//               /login?next= pointed at a confirm page that cannot render an
//               unbound plan. They landed on /patient/orders with the bill
//               nowhere in sight, at the counter, mid-transaction.
//
// An email-issued bill never hits either, because createBill stamps
// plans.patient_id at creation when the account already exists. That
// difference is the whole diagnosis, and the regression tests below exist to
// keep the email path exactly as it was.

const ROOT   = resolve(process.cwd());
const read   = (p: string) => stripComments(readFileSync(resolve(ROOT, p), 'utf8'));

const PAGE    = read('app/checkout/[token]/page.tsx');
const ACTIONS = read('app/checkout/[token]/actions.ts');
const CLAIM   = read('lib/checkout/claimSessionPlan.ts');
const PAYCOMP = read('app/patient/payment-complete/page.tsx');
const BILLS   = read('app/practice/bills/new/actions.ts');
const POS     = read('app/practice/pos/actions.ts');

describe('the diagnosis, and what closed it at the source', () => {
  // AMENDMENT. This pair used to assert the asymmetry itself: an emailed
  // bill was born with an owner (from the email lookup) and a till bill was
  // born with none, because an SA ID was not an account. That asymmetry is
  // gone — both surfaces now capture an SA ID and both bind at issuance
  // when it resolves — so pinning "patient_id: null" here would be pinning
  // the bug. What still matters, and is pinned instead, is that BOTH stamp
  // the same resolved value from the same shared capture, and that the
  // till still writes the encrypted ID onto the session so the claim path
  // below keeps working for a genuinely new patient.

  it('BOTH surfaces stamp the owner from the shared identity capture', () => {
    expect(BILLS).toMatch(/patient_id:\s*boundPatientId/);
    const issue = POS.slice(POS.indexOf('export async function issueCounterSession'));
    expect(issue).toMatch(/patient_id:\s*identity\.patientId/);

    for (const src of [BILLS, POS]) {
      expect(src).toMatch(/captureBillIdentity\(\{/);
    }
  });

  it('the till still carries the encrypted ID on the session, so an unbound plan is still claimable', () => {
    // Case A — the ID belonged to nobody at issuance. patient_id stays
    // null, and claimUnboundSessionPlan is what binds it at scan time.
    const issue = POS.slice(POS.indexOf('export async function issueCounterSession'));
    expect(issue).toMatch(/sa_id_number:\s*encryptedSaId/);
    expect(issue).toMatch(/const encryptedSaId = identity\.encryptedSaId/);
  });
});

describe('signed in, scanning a counter QR', () => {
  it('attempts the claim BEFORE the ownership comparison that would bounce them', () => {
    const claim  = PAGE.indexOf('claimUnboundSessionPlan(');
    const bounce = PAGE.indexOf('<BillMatchCard');
    expect(claim).toBeGreaterThan(0);
    expect(bounce).toBeGreaterThan(claim);
  });

  it('only ever claims an UNBOUND plan, and only when the token carries an ID', () => {
    // Widened by 0098. It used to be session-only, because only a counter
    // session carried an SA ID to prove anything with; an emailed bill now
    // carries one too. What did NOT widen is the requirement itself — an
    // unbound plan AND a stored ID, never "somebody is logged in".
    expect(PAGE).toMatch(/if \(sessionUser && planPatientId === null && tokenSaIdEncrypted\)/);
  });

  it('passes the AUTHENTICATED user id, never anything from the request', () => {
    const block = PAGE.slice(PAGE.indexOf('claimUnboundSessionPlan('), PAGE.indexOf('claimUnboundSessionPlan(') + 500);
    expect(block).toMatch(/userId:\s*sessionUser\.id/);
    expect(block).toMatch(/sessionSaIdEncrypted:\s*tokenSaIdEncrypted/);
  });

  it('routes a successful claim through the SAME ownership branch as an email bill', () => {
    // No parallel confirm surface: the claim sets planPatientId and everything
    // downstream is the path an email-issued bill already took.
    expect(PAGE).toMatch(/if \(claim\.claimed\) \{\s*planPatientId = sessionUser\.id;/);
    expect(PAGE).toMatch(/if \(planPatientId === sessionUser\.id\)/);
  });

  it('leaves the bounce in place when the claim is refused', () => {
    const after = PAGE.slice(PAGE.indexOf('claimUnboundSessionPlan('));
    expect(after).toMatch(/<BillMatchCard/);
  });
});

describe('signed out, scanning a counter QR', () => {
  it('still REJECTS the email collision — logging in is the proof, and it only got stricter', () => {
    // The rejection is an account-takeover guard: on a session token the email
    // is client-typed with no proof of inbox control, so reusing a confirmed
    // account would sign a stranger into it. Not relaxed — WIDENED. Audit
    // A-03 found the guard fired only when the plan was bound to somebody
    // ELSE, and a QR bill raised against a returning patient's SA ID is bound
    // to that patient, which was the one shape it let through. The action is
    // now 'require-login' and covers every pre-existing account on this door.
    expect(ACTIONS).toMatch(/decision\.action === 'require-login'/);
    expect(ACTIONS).toMatch(/requireLogin:\s*true/);
  });

  it('sends a SESSION token back to the checkout page, which can now bind', () => {
    // The fork moved into signInRequired() when the three separately-worded
    // refusals were collapsed into one (A-03's enumeration oracle) — the
    // routing rule itself is unchanged.
    const block = ACTIONS.slice(ACTIONS.indexOf('function signInRequired('));
    expect(block).toMatch(/tokenKind === 'session'\s*\?\s*`\/checkout\/\$\{encodeURIComponent\(token\)\}`/);
  });

  it('still sends an INVITATION token to the confirm page — that path was never broken', () => {
    const block = ACTIONS.slice(ACTIONS.indexOf('function signInRequired('));
    expect(block).toMatch(/`\/patient\/orders\/\$\{planId\}\/confirm`/);
  });

  it('the discriminator keeps its invitation-door rules, under a session-door gate', () => {
    // Both original branches survive verbatim and still decide the emailed
    // door. What A-03 added is a gate BEFORE them: on a session token an
    // existing account never reaches the plan-ownership question at all.
    const D = read('app/checkout/[token]/_lib/discriminate.ts');
    expect(D).toMatch(/if \(planPatientId !== null && planPatientId === existing\.id\)/);
    expect(D).toMatch(/if \(existing\.email_confirmed_at\)/);
    expect(D).toMatch(/return \{ action: 'require-login', existingUserId: existing\.id \}/);
    // The gate is above the ownership check, not below it — the ordering IS
    // the fix, since the takeover input passes the ownership check.
    expect(D.indexOf("if (tokenKind === 'session')"))
      .toBeLessThan(D.indexOf('if (planPatientId !== null'));
  });
});

describe('regression: the paths that already worked', () => {
  it('a logged-out INVITATION scan still gets the existing-account lookup', () => {
    expect(PAGE).toMatch(/if \(resolved\.kind === 'invitation'\) \{\s*if \(planPatientId\)/);
    expect(PAGE).toMatch(/findExistingAuthUser\(svcForLookup, resolved\.row\.email\)/);
  });

  it('a logged-out SESSION scan by a FIRST-TIMER still renders the anonymous form', () => {
    // The claim branch is gated on sessionUser, so a logged-out scan cannot
    // enter it, and no email lookup was added for session tokens.
    expect(PAGE).toMatch(/if \(sessionUser && planPatientId === null && tokenSaIdEncrypted\)/);
    const loggedOut = PAGE.slice(PAGE.indexOf('let existingAccount = false;'));
    expect(loggedOut).toMatch(/if \(resolved\.kind === 'invitation'\)/);
    expect(loggedOut).not.toMatch(/findExistingAuthUser\(svcForLookup, resolved\.row\.email\)[\s\S]{0,40}session/);
  });

  it('the anonymous signup form is still never reached by someone with an account', () => {
    // The routing rule this whole flow is built on. The fix routes returning
    // patients to /confirm via the claim, never into CheckoutForm.
    const claimBlock = PAGE.slice(PAGE.indexOf('claimUnboundSessionPlan('), PAGE.indexOf('if (sessionUser) {'));
    expect(claimBlock).not.toMatch(/CheckoutForm/);
  });

  it('the uncaptured-plan resume branch is untouched', () => {
    expect(PAGE).toMatch(/isUncapturedPlan/);
    expect(PAGE).toMatch(/ResumeCapture/);
  });

  it('initiateCheckout still binds patient_id only after phone verification', () => {
    // The deferral is deliberate and stays: nothing in this change binds on
    // the strength of a login alone, and the anonymous path's own bind is
    // still gated on a verified phone for THIS token.
    const initiate = ACTIONS.slice(ACTIONS.indexOf('export async function initiateCheckout'));
    const verify   = initiate.indexOf("error: 'verify_phone_required'");
    const bind     = initiate.indexOf('update({ patient_id: userId })');
    expect(verify).toBeGreaterThan(0);
    expect(bind).toBeGreaterThan(verify);
  });
});

describe('the claim cannot become a way into somebody else\'s plan', () => {
  it('the write carries the unbound guard, so a plan with an owner is immovable', () => {
    expect(CLAIM).toMatch(/update\(\{ patient_id: userId \}\)[\s\S]{0,120}\.is\('patient_id', null\)/);
  });

  it('proves identity by SA ID rather than by the existence of a session', () => {
    expect(CLAIM).toMatch(/sessionId !== profileId/);
    expect(CLAIM).toMatch(/reason: 'id_mismatch'/);
    expect(CLAIM).toMatch(/reason: 'no_profile_id'/);
  });

  it('compares decrypted values, never the stored ciphertexts', () => {
    expect(CLAIM).toMatch(/decryptId\(sessionSaIdEncrypted\)/);
    expect(CLAIM).toMatch(/decryptId\(storedProfileId\)/);
    expect(CLAIM).not.toMatch(/sessionSaIdEncrypted === storedProfileId/);
  });

  it('fails closed on an unreadable identity', () => {
    expect(CLAIM).toMatch(/catch \{[\s\S]{0,200}reason: 'decrypt_failed'/);
  });

  it('runs on the service-role client — an unbound plan is invisible to the patient\'s own', () => {
    const block = PAGE.slice(PAGE.indexOf('claimUnboundSessionPlan('), PAGE.indexOf('claimUnboundSessionPlan(') + 300);
    expect(block).toMatch(/svc:\s*svcForLookup/);
  });
});

describe('the session still reaches a terminal stage through this route', () => {
  it('the saved-card return now completes the counter session', () => {
    // This route became reachable for a counter session the moment a returning
    // patient could claim one: they pay from /confirm with a stored card and
    // land HERE, not on /checkout/[token]/complete where the equivalent write
    // already lived. Without it the plan goes active while the session sits at
    // 'scanned' — and expire_stale_checkout_session will not touch a plan that
    // has left the pending statuses, so it would freeze open permanently.
    expect(PAYCOMP).toMatch(/from\('checkout_sessions'\)[\s\S]{0,160}update\(\{ stage: 'completed' \}\)/);
    expect(PAYCOMP).toMatch(/\.eq\('plan_id', plan\.id\)[\s\S]{0,60}\.neq\('stage', 'completed'\)/);
  });

  it('completes only AFTER activation, so a failed activation cannot report success', () => {
    const activate = PAYCOMP.indexOf('activateFirstInstalment(svc');
    const stage    = PAYCOMP.indexOf("update({ stage: 'completed' })");
    expect(activate).toBeGreaterThan(0);
    expect(stage).toBeGreaterThan(activate);
  });

  it('uses .neq rather than the open-stages guard, so a retry after a decline still completes', () => {
    // Deliberately the completion route's weaker predicate: a session left at
    // 'payment_failed' by an earlier attempt must be able to reach 'completed'.
    const block = PAYCOMP.slice(PAYCOMP.indexOf("from('checkout_sessions')"));
    expect(block).not.toMatch(/\.in\('stage'/);
  });

  it('abandonment is still closed from the TILL side, not from the phone', () => {
    // Unchanged by this work and re-asserted because the claim adds a way to
    // leave the flow: "Start next patient" force-expires, and the countdown
    // fires the lazy fail-safe at zero.
    const FORM = read('app/practice/pos/CounterSessionForm.tsx');
    expect(FORM).toMatch(/expireCounterSession\(issued\.token, \{ force: true \}\)/);
    expect(FORM).toMatch(/expireCounterSession\(issued\.token, \{ force: false \}\)/);
  });

  it('the decline and payment_failed propagations still fire on a claimed plan', () => {
    // Both key off plan_id, which the claim does not change — it sets an owner
    // on the same plan the session already points at.
    const CLOSER = read('lib/checkout/declineCheckoutSessions.ts');
    expect(CLOSER).toMatch(/\.eq\('plan_id', planId\)/);
    expect(CLAIM).not.toMatch(/from\('checkout_sessions'\)/);
  });
});
