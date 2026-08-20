import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Phase 5 — webhook push format + defaulted parity (source pins) ─────────
//
// The failure PUSH was flagged in the audit as "double-divides / understates
// 100×". That is a FALSE ALARM: this file's formatRandCents takes RANDS
// (unlike the same-named helper in dunningNotifications, which takes cents),
// so `formatRandCents(attemptedAmountCents / 100)` is the CORRECT cents→rands
// conversion. These pins lock the correct behaviour so nobody "fixes" it.

const ROOT = resolve(process.cwd());
const SRC = readFileSync(
  resolve(ROOT, 'app/api/payments/peach/webhook/route.ts'),
  'utf8',
);

describe('webhook push — rand formatting is correct (not a bug)', () => {
  it('formatRandCents in this file takes RANDS', () => {
    expect(SRC).toMatch(/function formatRandCents\(rands: number\)/);
    // Body divides nothing — it formats the rands it is given.
    expect(SRC).toMatch(/rands\.toFixed\(2\)/);
  });

  it('the failure push converts cents→rands with / 100 (correct)', () => {
    expect(SRC).toMatch(/formatRandCents\(attemptedAmountCents \/ 100\)/);
    // A guard comment warns against "fixing" the /100 away.
    expect(SRC).toMatch(/Do NOT[\s\S]{0,40}fix[\s\S]{0,40}\/100|takes RANDS/i);
  });
});

describe('webhook push — parity on the defaulted (terminal) attempt', () => {
  it('has an isTerminal branch that conveys the freeze', () => {
    // Renamed from `capReached` when the ladder gained a second terminal
    // signal (the next-instalment due-date boundary, alongside the fee
    // cap) — see lib/payments/dunning.ts. The push copy is keyed off
    // "is this attempt terminal", not specifically "was the fee cap hit".
    expect(SRC).toMatch(/isTerminal\s*\?\s*'Account frozen/);
    expect(SRC).toMatch(/frozen from new plans until you settle/i);
  });

  it('tags the terminal push distinctly as defaulted', () => {
    expect(SRC).toMatch(/payment:\$\{payment\.id\}:defaulted/);
  });
});
