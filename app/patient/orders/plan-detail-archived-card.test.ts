import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Regression: a completed plan's card still resolves after archiving ──
//
// A card can be archived once it stops backing an active plan — including
// cards that a COMPLETED plan collected from. The plan-detail / receipt
// screen resolves the card THIS plan collected from by matching its bound
// peach_registration_id → payment_methods.token. If that query filtered
// `archived_at IS NULL` (as the management/new-plan surfaces correctly do),
// an archived historical card would resolve to nothing and the receipt would
// render a blank brand/last-four.
//
// So the plan-detail card query must NOT filter archived — it needs the full
// card set (archived included) to resolve a historical plan's own card. This
// pin fails loudly if a future "consistency" pass adds the filter here.

const PLAN_DETAIL = readFileSync(
  resolve(process.cwd(), 'app/patient/orders/[planId]/page.tsx'),
  'utf8',
).replace(/\r\n/g, '\n');

describe('plan detail — historical card resolution survives archiving', () => {
  it('does NOT filter archived_at on the plan-detail card query', () => {
    // The only payment_methods query on this screen resolves the plan's own
    // card; it must see archived rows too.
    expect(PLAN_DETAIL).not.toContain("archived_at");
  });

  it('resolves the card by the plan\'s bound token (peach_registration_id), not just the default', () => {
    expect(PLAN_DETAIL).toMatch(/from\('payment_methods'\)/);
    expect(PLAN_DETAIL).toContain('token');
    // Bound-card resolution: match a card whose token is the plan's registration id.
    expect(PLAN_DETAIL).toMatch(/c\.token === rawPlan\.peach_registration_id/);
  });
});
