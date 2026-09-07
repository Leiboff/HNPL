import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ACTIONS = readFileSync('lib/onboarding/actions.ts', 'utf8');

function functionBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  if (start === -1) throw new Error(`Could not find ${declaration}`);

  const open = source.indexOf('{', start);
  let depth = 0;
  for (let cursor = open; cursor < source.length; cursor += 1) {
    if (source[cursor] === '{') depth += 1;
    if (source[cursor] === '}') depth -= 1;
    if (depth === 0) return source.slice(open + 1, cursor);
  }

  throw new Error(`Could not find the end of ${declaration}`);
}

describe('Experian boundary — adversarial source checks', () => {
  it('the stored SA ID is used only as a verification signal and is never logged or persisted', () => {
    const runCreditCheck = functionBody(
      ACTIONS,
      'export async function runCreditCheck()',
    );

    // The current affordability boundary does not need the identifier itself:
    // it receives only proof that an ID and liveness result are present. Keep
    // this assertion about the security boundary rather than the formatting of
    // the assignment that produces it.
    expect(runCreditCheck).toMatch(
      /identityVerified:\s*!!loaded\.profile\.sa_id_number\s*&&\s*!!loaded\.profile\.liveness_verified_at/,
    );

    // A future bureau integration may deliberately decrypt at its adapter
    // boundary. Until that exists, onboarding must neither materialise the
    // plaintext nor send the stored ciphertext to an observable or durable
    // sink from this action.
    expect(runCreditCheck).not.toMatch(/\bdecryptId\s*\(/);
    expect(runCreditCheck).not.toMatch(/console\.\w+\([\s\S]*?sa_id_number/);
    expect(runCreditCheck).not.toMatch(/\.update\(\{[\s\S]*?sa_id_number/);
  });
});
