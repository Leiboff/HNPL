import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Guard: the phone save path validates SERVER-SIDE ───────────────────
//
// The client blocks an invalid save, but the server action is the real
// gate. updateProfile is an inline 'use server' action in page.tsx (not
// exported), so this is a source-text pin: it must normalise via the
// shared validator, reject on failure, and never write the raw input.
// Any refactor that drops the server check trips this.

function read(p: string): string {
  return readFileSync(resolve(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');
}

const PAGE = read('app/patient/profile/page.tsx');

describe('profile phone save — server-side validation', () => {
  it('imports the shared SA-phone normaliser (never an inline regex)', () => {
    expect(PAGE).toMatch(/import\s*\{[^}]*normalizePhoneZA[^}]*\}\s*from\s*['"]@\/lib\/validation['"]/);
  });

  it('updateProfile normalises the phone and rejects an invalid one', () => {
    const start = PAGE.indexOf('async function updateProfile');
    expect(start).toBeGreaterThan(-1);
    const body = PAGE.slice(start, start + 900);
    expect(body).toContain('normalizePhoneZA(');
    // A normalisation miss returns an error rather than writing.
    expect(body).toMatch(/if\s*\(\s*!phone\s*\)\s*return\s*\{\s*error:/);
    // The DB write uses the validated `phone`, not the raw request field.
    expect(body).toContain('.update({ phone })');
    expect(body).not.toContain('.update({ phone: data.phone })');
  });
});
