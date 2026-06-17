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
const WAITING_PANEL    = read('app/practice/bills/new/BillWaitingPanel.tsx');
const PAGE_BILLS_QUERY = read('app/practice/page.tsx');

describe('BillsBlock derives the label via the shared helper', () => {
  it('imports deriveBillLifecycleStatus from the shared module', () => {
    expect(BILLS_BLOCK).toMatch(
      /from\s+['"]@\/lib\/bills\/lifecycle['"]/,
    );
    expect(BILLS_BLOCK).toMatch(/deriveBillLifecycleStatus/);
    expect(BILLS_BLOCK).toMatch(/billLifecycleChip/);
  });

  it('renders the lifecycle chip in both the mobile list and desktop table', () => {
    // Count usages — at least one each. Helper calls > 1 because
    // each row computes lifecycle individually.
    const calls = BILLS_BLOCK.match(/deriveBillLifecycleStatus\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(BILLS_BLOCK).toMatch(/<LifecycleBadge\s+status=\{lifecycle\}\s*\/>/);
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
