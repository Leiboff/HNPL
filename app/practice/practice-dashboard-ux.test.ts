import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Practice-dashboard UX review — source-level pins ─────────────────────
//
// Part 2 (server half): the bill flow must never hand a raw provider or
// database error string to the client. The reported leak was the email
// provider's own payload rendered to a receptionist verbatim:
//   Resend 422: {"statusCode":422,"name":"validation_error",...}
// The behavioural half (nothing raw reaches the DOM) lives in
// bills/new/BillFormValidation.test.tsx; this half pins the SOURCE, because
// the leak was a data-flow shape — `error: emailResult.error` — that a
// rendering test can only catch once someone happens to trigger it.
//
// Part 5: the login cue.

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');
}

const BILL_ACTIONS = read('app/practice/bills/new/actions.ts');
const RESEND       = read('lib/email/resend.ts');
const LOGIN        = read('app/(auth)/login/page.tsx');

describe('Part 2 — createBill never returns a raw provider/DB error to the client', () => {
  it('emailDelivery.error is a curated constant, never the provider result', () => {
    // Both send sites (existing patient + new invitation).
    const assignments = BILL_ACTIONS.match(/error:\s*emailResult\.ok \? undefined : [A-Za-z_.]+/g) ?? [];
    expect(assignments).toHaveLength(2);
    for (const a of assignments) {
      expect(a).toContain('EMAIL_FAILED_MESSAGE');
      expect(a).not.toContain('emailResult.error');
    }
  });

  it('the user-facing email copy is plain language with no provider name or JSON', () => {
    const msg = BILL_ACTIONS.match(/const EMAIL_FAILED_MESSAGE\s*=\s*([\s\S]*?);/)?.[1] ?? '';
    // The literal escapes its apostrophe (couldn\'t) inside a single-quoted
    // string, so allow the backslash rather than matching the rendered form.
    expect(msg).toMatch(/couldn\\?'t send this bill by email/i);
    expect(msg).toMatch(/check the address/i);
    expect(msg).not.toMatch(/resend|statusCode|422/i);
  });

  it('no Supabase error .message is interpolated into a returned user-facing error', () => {
    // The three DB failure paths (application / plan / invitation inserts)
    // each used to return `Failed to create X: ${err.message}`.
    expect(BILL_ACTIONS).not.toMatch(/return \{ error: `Failed to create [^`]*\$\{[^}]*\.message\}/);
    expect(BILL_ACTIONS).not.toMatch(/error: `[^`]*\$\{(appError|planError|inviteError)\.message\}/);
  });

  it('the raw provider/DB text is still logged server-side — diagnosis is not lost', () => {
    expect(BILL_ACTIONS).toMatch(/console\.error\('\[createBill\][^']*email failed', emailResult\.error\)/);
    expect(BILL_ACTIONS).toMatch(/console\.error\('\[createBill\][^']*', appError\.message\)/);
    expect(BILL_ACTIONS).toMatch(/console\.error\('\[createBill\][^']*', planError\.message\)/);
  });

  it('the resend lib still returns detailed errors — we translate at the boundary, not by blinding the lib', () => {
    // Deliberately unchanged: the detail is what makes the server log useful.
    expect(RESEND).toMatch(/Resend \$\{res\.status\}/);
  });
});

describe('Part 5 — the login password form never reads as patients-only', () => {
  // ─── What changed, and what did NOT ──────────────────────────────────
  //
  // This block originally pinned two captions: "For patients" under the
  // Google button, and "For patients and practices" above the password
  // form. Both were removed in the auth redesign as product copy.
  //
  // The CONCERN they existed for is not removed, and is what this block
  // now guards: practice staff must never be told, or led to infer, that
  // the password form is not for them. The redesign satisfies that by
  // claiming no audience at all rather than by listing both — a form
  // labelled "Email address" is as true for a practice as for a patient.
  //
  // So the assertions below flip from "names both audiences" to "scopes
  // itself to neither". If someone reintroduces a patients-only caption
  // on this page, that is the actual regression, and it fails here.

  it('renders a cue above the fields that scopes them to no audience', () => {
    expect(LOGIN).toMatch(/data-testid="password-audience-cue"/);
    // Never narrowed to patients — the original bug.
    const cue = LOGIN.slice(
      LOGIN.indexOf('data-testid="password-audience-cue"'),
      LOGIN.indexOf('<form onSubmit={handleSubmit}'),
    );
    expect(cue).not.toMatch(/for patients/i);
    expect(cue).not.toMatch(/patients only/i);
  });

  it('the cue sits above the password form, not buried below it', () => {
    const cueIdx  = LOGIN.indexOf('password-audience-cue');
    const formIdx = LOGIN.indexOf('<form onSubmit={handleSubmit}');
    expect(cueIdx).toBeGreaterThan(-1);
    expect(formIdx).toBeGreaterThan(-1);
    expect(cueIdx).toBeLessThan(formIdx);
  });

  it('no audience caption anywhere on the page re-narrows a shared path', () => {
    // The Google block keeps its testid; what it must not regrow is a
    // caption telling one audience the page is not theirs.
    expect(LOGIN).toMatch(/data-testid="login-google-block"/);
    expect(LOGIN).not.toMatch(/For patients/);
  });

  it('passkey and Google options are untouched', () => {
    expect(LOGIN).toMatch(/<ContinueWithGoogleButton\b/);
    expect(LOGIN).toMatch(/Sign in with a passkey/);
  });
});
