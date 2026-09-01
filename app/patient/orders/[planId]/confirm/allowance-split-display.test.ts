import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';
import { splitInstalmentsWithExcess, MIN_FINANCED_RANDS } from '@/lib/finance';

// ─── The schedule shown is the schedule charged ───────────────────────────
//
// Product decision, 2026-09-02: a bill above the patient's remaining limit is
// no longer refused. The part their limit covers is financed over 2 or 3
// instalments, and the excess is collected up front, on instalment 1.
//
//   "if the allowance is 15k and the bill is 30k, first installment will be
//    20k, then 5k then 5k."
//
// The server-side half of that lives in lib/finance.ts (the arithmetic) and
// claim_credit_for_plan (the decision, under a row lock). This file is about
// the other half, which is not cosmetic: every surface that shows a patient a
// schedule next to a Pay button must show THAT schedule. An equal three-way
// split rendered over a bill that will actually be split 20/5/5 misstates the
// immediate charge by R15,000, and the patient taps agree on the wrong number.
//
// Three surfaces, three different amounts of knowledge, so three answers:
//
//   PORTAL CONFIRM   the patient is signed in, so the headroom is knowable.
//                    It reads it and renders the real split. On a RESUME it
//                    reads the committed rows instead — those are what
//                    payWithSavedCard re-charges.
//   COUNTER FORM     runs before the caller is identified. It cannot know the
//                    headroom (and must not try — a preview keyed on a typed
//                    email would leak other people's credit positions), so it
//                    labels its forecast as one and says the excess rule out
//                    loud.
//   RESUME CAPTURE   reads the COMMITTED instalment rows, so the number next
//                    to the Pay button is the number charged, always.

const ROOT = resolve(process.cwd());
const read = (p: string) => stripComments(readFileSync(resolve(ROOT, p), 'utf8'));

const PAGE    = read('app/patient/orders/[planId]/confirm/page.tsx');
const FORM    = read('app/patient/orders/[planId]/confirm/ConfirmForm.tsx');
const CHECKOUT_FORM = read('app/checkout/[token]/CheckoutForm.tsx');
const CHECKOUT_PAGE = read('app/checkout/[token]/page.tsx');

describe('the worked example the product decision was stated with', () => {
  it('a R30,000 bill on a R15,000 allowance splits 20,000 / 5,000 / 5,000', () => {
    // Restated here, in the file about DISPLAY, because this is the number a
    // patient will see and the reason the display had to change at all.
    const split = splitInstalmentsWithExcess(30000, 3, 15000);
    expect(split.instalments).toEqual([20000, 5000, 5000]);
    expect(split.financed).toBe(15000);
    expect(split.excess).toBe(15000);
  });

  it('and a bill within the allowance is untouched by any of this', () => {
    const split = splitInstalmentsWithExcess(9000, 3, 15000);
    expect(split.instalments).toEqual([3000, 3000, 3000]);
    expect(split.excess).toBe(0);
  });
});

describe('portal confirm — reads the headroom and renders the real split', () => {
  it('the page reads approved_credit_limit and the outstanding exposure', () => {
    expect(PAGE).toMatch(/\.select\('salary_day, approved_credit_limit'\)/);
    expect(PAGE).toMatch(/import \{ outstandingExposure \} from '@\/lib\/underwriting\/creditLimit'/);
    // Excluding THIS plan, or a resume would count its own rows against the
    // limit and understate the headroom.
    expect(PAGE).toMatch(/outstandingExposure\(supabase, user\.id, \{ excludePlanId: planId \}\)/);
  });

  it('a patient with NO approved limit is shown zero headroom, not infinite', () => {
    // The fallback that matters. `availableRands = 0` renders the
    // below-minimum notice; leaving it null would render a full schedule and
    // a live Pay button for a claim that refuses with no_limit.
    expect(PAGE).toMatch(/availableRands = 0/);
  });

  it('an unreadable exposure degrades to display-only, never to a gate', () => {
    // We cannot say what the split will be, so we say nothing and let the
    // claim (which re-derives under the lock) be the authority. A page that
    // refused here would turn a transient read failure into a lost payment.
    expect(PAGE).toMatch(/if \(exposure\.ok\) \{/);
    expect(PAGE).toMatch(/let availableRands:\s+number \| null\s+= null/);
  });

  it('a RESUME reads the committed rows rather than recomputing', () => {
    // payWithSavedCard re-charges the amount ON THE ROW, so a recomputation
    // here could disagree with what is charged — and on a resume it would,
    // because the row already carries the excess.
    expect(PAGE).toMatch(/if \(resumeMode\) \{[\s\S]{0,400}from\('payments'\)/);
    expect(PAGE).toMatch(/\.eq\('kind', 'instalment'\)/);
    expect(PAGE).toMatch(/committedInstalments = amounts/);
    // And no headroom read on that branch — nothing would use it.
    const resumeBranch = PAGE.slice(PAGE.indexOf('if (resumeMode) {'), PAGE.indexOf('} else {', PAGE.indexOf('if (resumeMode) {')));
    expect(resumeBranch).not.toMatch(/outstandingExposure/);
  });

  it('both values reach the form', () => {
    expect(PAGE).toMatch(/availableRands=\{availableRands\}/);
    expect(PAGE).toMatch(/committedInstalments=\{committedInstalments\}/);
  });
});

describe('ConfirmForm — the committed rows win, then the split, then the fallback', () => {
  it('uses splitInstalmentsWithExcess, not the equal split', () => {
    expect(FORM).toMatch(/import \{ splitInstalmentsWithExcess, calculatePaymentDates, MIN_FINANCED_RANDS \} from '@\/lib\/finance'/);
    expect(FORM).not.toMatch(/\bsplitInstalments\(/);
  });

  it('prefers the committed amounts when they are present and the right length', () => {
    // The length check is not pedantry: a plan_type changed between
    // acceptance and resume would otherwise render N rows against M amounts.
    expect(FORM).toMatch(
      /committedInstalments && committedInstalments\.length === planType\s*\?\s*committedInstalments\s*:\s*split\.instalments/,
    );
  });

  it('falls back to fully-financed only when the headroom is unknown', () => {
    // `availableRands ?? totalAmount` — an unknown headroom renders the
    // pre-allowance shape, which is what this surface always showed. It is a
    // fallback now rather than the rule.
    expect(FORM).toMatch(/availableRands \?\? totalAmount/);
  });

  it('explains the excess where the schedule is, not in a footnote', () => {
    expect(FORM).toMatch(/const excessRands =\s*!resumeMode && split && split\.excess > 0 \? split\.excess : 0/);
    expect(FORM).toMatch(/\{excessRands > 0 && \(/);
    expect(FORM).toMatch(/is collected today with your first instalment/);
    // Both halves of the arithmetic are named — what the limit covers and
    // what it does not — so the larger first instalment is accounted for.
    expect(FORM).toMatch(/formatRand\(split!\.financed\)/);
    expect(FORM).toMatch(/formatRand\(excessRands\)/);
  });

  it('does NOT explain it on a resume, where the amounts are simply what they are', () => {
    expect(FORM).toMatch(/!resumeMode && split && split\.excess > 0/);
  });

  it('refuses BEFORE the tap when there is too little headroom to finance anything', () => {
    // The claim answers `below_minimum` here. Rendering a schedule and a live
    // Pay button for a request that cannot succeed is the failure mode this
    // whole file is about, one step further along.
    expect(FORM).toMatch(/const belowMinimum =\s*!resumeMode && availableRands !== null && availableRands < MIN_FINANCED_RANDS/);
    expect(FORM).toMatch(/&& !belowMinimum;/);
    expect(FORM).toMatch(/\{belowMinimum && \(/);
    expect(FORM).toMatch(/enough of your limit left to split this bill/);
  });

  it('the minimum is the shared constant, not a literal', () => {
    expect(MIN_FINANCED_RANDS).toBe(300);
    expect(FORM).not.toMatch(/availableRands < 300/);
  });

  it('the agreement sentence quotes the FIRST row of the rendered schedule', () => {
    // Whatever the schedule ends up being, the sentence the patient agrees to
    // is keyed on it — so the excess cannot be shown in the table and omitted
    // from the consent.
    expect(FORM).toMatch(/charged immediately for the first instalment of\{' '\}\s*<span className="font-semibold">\{formatRand\(schedule\[0\]\.amount\)\}<\/span>/);
  });
});

describe('counter checkout — a forecast, labelled, with the rule stated', () => {
  it('says the excess rule out loud on the plan picker', () => {
    expect(CHECKOUT_FORM).toMatch(/If your bill is more than the limit you have left/);
    expect(CHECKOUT_FORM).toMatch(/collected with your first payment/);
  });

  it('hedges the handoff figure rather than asserting it', () => {
    expect(CHECKOUT_FORM).toMatch(/your first instalment \(around\{' '\}/);
  });

  it('does not attempt to read a headroom it has no account for', () => {
    // Deliberate. This form runs before the caller is identified, and a
    // preview keyed on a typed email would report another person's credit
    // position to whoever typed it.
    expect(CHECKOUT_FORM).not.toMatch(/approved_credit_limit|outstandingExposure|availableRands/);
  });

  it('the authoritative amounts come from the COMMITTED rows on the pay surface', () => {
    // ResumeCapture, which mounts the widget. This is what makes the hedge
    // above acceptable rather than a way of never showing the real number.
    expect(CHECKOUT_PAGE).toMatch(/const scheduleAmounts = rows2\.map\(\(r\) => Number\(r\.amount\)\)/);
    expect(CHECKOUT_PAGE).toMatch(/scheduleAmounts=\{scheduleAmounts\}/);
    expect(CHECKOUT_PAGE).toMatch(/firstInstalmentAmount=\{firstInstalmentAmount\}/);
  });
});
