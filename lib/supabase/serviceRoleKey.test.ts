import { describe, it, expect } from 'vitest';
import {
  classifyServiceKey,
  isUsableServiceKey,
  serviceKeyProblem,
  type ServiceKeyKind,
} from './serviceRoleKey';

// ─── The check that should have existed before two reports ─────────────
//
// A client built with a non-service-role key does not fail loudly against
// `profiles`; it fails silently, because of the shape of this schema's RLS:
// SELECT and UPDATE are `id = auth.uid()` so they return ZERO ROWS with no
// error, and 0030 dropped the client-facing INSERT policy so only the
// insert refuses out loud. The result reads exactly like "the profile row
// is missing", which is where two rounds of investigation went.

/** Build an unsigned JWT with the given claims — the shape, not a secret. */
function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.signature-not-checked`;
}

describe('classifyServiceKey', () => {
  it('recognises a legacy service_role JWT', () => {
    expect(classifyServiceKey(jwt({ iss: 'supabase', role: 'service_role' }))).toBe('service_role');
  });

  it('recognises the ANON JWT — the browser key pasted into the wrong variable', () => {
    expect(classifyServiceKey(jwt({ iss: 'supabase', role: 'anon' }))).toBe('anon');
  });

  it('recognises the new key formats', () => {
    expect(classifyServiceKey('sb_secret_abc123')).toBe('secret');
    expect(classifyServiceKey('sb_publishable_abc123')).toBe('publishable');
  });

  it('treats absence as absence', () => {
    expect(classifyServiceKey(undefined)).toBe('missing');
    expect(classifyServiceKey(null)).toBe('missing');
    expect(classifyServiceKey('')).toBe('missing');
    expect(classifyServiceKey('   ')).toBe('missing');
  });

  it('does not guess about shapes it cannot read', () => {
    expect(classifyServiceKey('not-a-key')).toBe('unknown');
    // A truncated JWT — three segments are required.
    expect(classifyServiceKey('eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoi')).toBe('unknown');
    // Valid JWT, no role claim.
    expect(classifyServiceKey(jwt({ iss: 'supabase' }))).toBe('unknown');
    // Valid JWT, unexpected role.
    expect(classifyServiceKey(jwt({ role: 'authenticated' }))).toBe('unknown');
  });

  it('survives a payload that is not JSON, or not an object', () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64').replace(/=+$/, '');
    expect(classifyServiceKey(`x.${b64('{not json')}.y`)).toBe('unknown');
    expect(classifyServiceKey(`x.${b64('"a string"')}.y`)).toBe('unknown');
    expect(classifyServiceKey(`x.${b64('null')}.y`)).toBe('unknown');
  });

  it('tolerates surrounding whitespace — a pasted env var often has it', () => {
    expect(classifyServiceKey(`  ${jwt({ role: 'service_role' })}  `)).toBe('service_role');
    expect(classifyServiceKey('  sb_secret_abc  ')).toBe('secret');
  });
});

describe('isUsableServiceKey', () => {
  it('only the two kinds that bypass RLS are usable', () => {
    const usable: ServiceKeyKind[] = ['service_role', 'secret'];
    const unusable: ServiceKeyKind[] = ['missing', 'anon', 'publishable', 'unknown'];
    for (const kind of usable)   expect(isUsableServiceKey(kind), kind).toBe(true);
    for (const kind of unusable) expect(isUsableServiceKey(kind), kind).toBe(false);
  });
});

describe('serviceKeyProblem', () => {
  it('says nothing when the key is right', () => {
    expect(serviceKeyProblem('service_role')).toBeNull();
    expect(serviceKeyProblem('secret')).toBeNull();
  });

  it('names the anon-key mix-up and where to get the right one', () => {
    const msg = serviceKeyProblem('anon')!;
    expect(msg).toMatch(/ANON key/);
    expect(msg).toMatch(/cannot bypass RLS/);
    expect(msg).toMatch(/42501/);
    expect(msg).toMatch(/Project Settings/);
  });

  it('has a sentence for every unusable kind — silence is the bug', () => {
    for (const kind of ['missing', 'anon', 'publishable', 'unknown'] as ServiceKeyKind[]) {
      expect(serviceKeyProblem(kind), kind).toBeTruthy();
    }
  });

  it('never echoes key material — it is given a KIND, not the key', () => {
    // The function's only input is the classification, so there is nothing
    // for it to leak. Pinned because a future "helpful" version that takes
    // the key and prints a prefix would be a credential in a log.
    const src = String(serviceKeyProblem);
    expect(src).not.toMatch(/slice|substring|substr/);
  });
});
