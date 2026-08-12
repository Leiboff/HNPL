import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Bill lifecycle chip wiring (source-text regression) ──────────────────
//
// The single-source-of-truth invariant: every practice-facing surface
// that displays a bill state derives the label through
// `deriveBillLifecycleStatus` (or `billLifecycleChip`). If a refactor
// reintroduces a local mapping, "Sent" / "Viewed" / "Paid" / "Expired"
// could drift between the bills list and the waiting panel — exactly
// the inconsistency the helper was added to prevent.
//
// We also pin that the live waiting panel:
//   • subscribes to BOTH `plans` and `patient_invitations` row changes
//     (the two writes that drive the lifecycle transitions)
//   • has a fallback safety poll (~15s) to recover from a dropped
//     realtime event — without it a backgrounded tab can dead-end on
//     "waiting" while the patient has already paid
//   • cleans up the channel + the poll on unmount

const ROOT = resolve(process.cwd());
function read(p: string): string {
  return readFileSync(resolve(ROOT, p), 'utf8');
}

const BILLS_BLOCK      = read('app/practice/BillsBlock.tsx');
const BILLS_TABLE      = read('app/practice/BillsTable.tsx');
const WAITING_PANEL    = read('app/practice/bills/new/BillWaitingPanel.tsx');
const PAGE_BILLS_QUERY = read('app/practice/page.tsx');

/** Comments stripped — these files DOCUMENT the labels and colours they must
 *  not hard-code, so an absence assertion over the raw text would match prose
 *  rather than code. */
function codeOf(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

describe('the bills surfaces derive the label via the shared helper', () => {
  // The four-column collapse moved row rendering from BillsBlock into the
  // shared BillsTable. BillsBlock still derives the lifecycle for its CSV and
  // PDF exports, so BOTH files must go through the helper — the invariant did
  // not move, it now applies in two places.
  it.each([
    ['BillsBlock', BILLS_BLOCK],
    ['BillsTable', BILLS_TABLE],
  ])('%s imports deriveBillLifecycleStatus from the shared module', (_name, src) => {
    expect(src).toMatch(/from\s+['"]@\/lib\/bills\/lifecycle['"]/);
    expect(src).toMatch(/deriveBillLifecycleStatus/);
    expect(src).toMatch(/billLifecycleChip/);
  });

  it('BillsTable renders the status badge in both the mobile list and desktop table', () => {
    const badges = BILLS_TABLE.match(/<StatusBadge\s+status=\{lifecycleOf\(plan\)\}\s*\/>/g) ?? [];
    expect(badges.length).toBe(2);
  });

  it('BillsBlock still derives the lifecycle for both exports (CSV + PDF)', () => {
    const calls = BILLS_BLOCK.match(/deriveBillLifecycleStatus\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('neither file hard-codes a lifecycle LABEL — the helper owns the vocabulary', () => {
    // Stronger than the old assertion, which only checked that a badge element
    // was present. This is the actual drift the helper exists to prevent: a
    // surface printing its own "Paid" that then diverges from the panel's.
    for (const src of [codeOf(BILLS_BLOCK), codeOf(BILLS_TABLE)]) {
      for (const label of ['Sent', 'Viewed', 'Expired']) {
        expect(src).not.toMatch(new RegExp(`['"\`]${label}['"\`]`));
      }
    }
  });

  it('BillsTable composes its own LAYOUT but takes status colour from the helper', () => {
    const code = codeOf(BILLS_TABLE);
    // The chip's colour classes arrive via cfg.cls rather than being written
    // here, so dominance never forks the palette.
    expect(code).toMatch(/billLifecycleChip\(status\)/);
    expect(code).toMatch(/\$\{cfg\.cls\}/);
    // Size / chip / ring / icon ARE this component's job.
    expect(code).toMatch(/text-sm font-semibold/);
    expect(code).toMatch(/<StatusIcon status=\{status\}\s*\/>/);
  });
});

describe('Bills query pulls in the invitation lifecycle data', () => {
  it('joins patient_invitations(viewed_at, accepted_at, expires_at) on the practice bills query', () => {
    expect(PAGE_BILLS_QUERY).toMatch(
      /invitations:patient_invitations\([\s\S]*?viewed_at[\s\S]*?accepted_at[\s\S]*?expires_at\)/,
    );
  });
});

describe('BillWaitingPanel: realtime subscription + fallback poll + cleanup', () => {
  it('subscribes to UPDATEs on plans filtered by the planId', () => {
    expect(WAITING_PANEL).toMatch(/table:\s*['"]plans['"]/);
    expect(WAITING_PANEL).toMatch(/filter:\s*`id=eq\.\$\{planId\}`/);
    expect(WAITING_PANEL).toMatch(/event:\s*['"]UPDATE['"]/);
  });

  it('subscribes to UPDATEs on patient_invitations when an invitationId is provided', () => {
    expect(WAITING_PANEL).toMatch(/table:\s*['"]patient_invitations['"]/);
    expect(WAITING_PANEL).toMatch(/filter:\s*`id=eq\.\$\{invitationId\}`/);
  });

  it('runs a slow fallback poll while the panel is open (default 15s)', () => {
    expect(WAITING_PANEL).toMatch(/FALLBACK_POLL_MS\s*=\s*15_?000/);
    expect(WAITING_PANEL).toMatch(/setInterval\(\s*poll\s*,\s*FALLBACK_POLL_MS\s*\)/);
  });

  it('cleans up both the realtime channel and the poll interval on unmount', () => {
    expect(WAITING_PANEL).toMatch(/return\s*\(?\s*\)\s*=>\s*\{[\s\S]*?clearInterval[\s\S]*?removeChannel/);
  });

  it('stops observing once the lifecycle reaches a terminal state (paid/expired)', () => {
    // The effect guards on isTerminal — no point holding a channel open
    // for a bill that's already resolved.
    expect(WAITING_PANEL).toMatch(/if\s*\(\s*isTerminal\s*\)\s*return/);
  });

  it('derives the visible state via the shared helper (no local mapping)', () => {
    expect(WAITING_PANEL).toMatch(
      /from\s+['"]@\/lib\/bills\/lifecycle['"]/,
    );
    expect(WAITING_PANEL).toMatch(/deriveBillLifecycleStatus/);
  });
});
