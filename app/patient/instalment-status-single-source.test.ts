import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Single source of truth for instalment lateness ─────────────────────
//
// Phase 1 fix: overdue/late is derived once (lib/patient/instalmentStatus)
// and every surface reads it, so no two screens can disagree. This pins
// that wiring — a surface that goes back to computing late/overdue from a
// raw stored status (or only counting failed/defaulted) fails here.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const SURFACES: Array<[string, string]> = [
  ['home hero + your-plans rows', 'app/patient/page.tsx'],
  ['plans header (overdue count)', 'app/patient/orders/page.tsx'],
  ['plans list (paying-off cards)', 'app/patient/orders/OrdersView.tsx'],
  ['plan detail (schedule rows)', 'app/patient/orders/[planId]/page.tsx'],
  ['account record card', 'app/patient/account/page.tsx'],
];

describe('every status surface consumes the shared derivation', () => {
  it.each(SURFACES)('%s imports deriveInstalmentStatus', (_label, path) => {
    expect(read(path)).toMatch(/deriveInstalmentStatus[\s\S]*from '@\/lib\/patient\/instalmentStatus'/);
  });

  it('the Plans header counts overdue via the derivation, not a raw failed/defaulted test', () => {
    const src = read('app/patient/orders/page.tsx');
    expect(src).toMatch(/deriveInstalmentStatus\([^)]*\)\s*===\s*'overdue'/);
    // The old, contradicting rule must be gone from the overdue count.
    expect(src).not.toMatch(/pmt\.status === 'failed' \|\| pmt\.status === 'defaulted'/);
  });
});
