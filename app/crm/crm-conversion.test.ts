import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── CRM conversion wiring — end-to-end source pins ───────────────────
//
// The conversion flow spans four files. This test pins the load-bearing
// contract between them so any single-file refactor that drops a call
// site breaks the pin instead of silently disconnecting the pipeline.
//
//   markSigned (crm/leads/actions.ts)
//     → randomBytes(32).toString('hex') → practice_invitations INSERT
//     → returns /signup/practice?token=… URL
//
//   /signup/practice page (client)
//     → reads window.location ?token= on mount
//     → calls getPracticeInvitationByToken (server RPC)
//     → prefills email + practice_name + contact + phone + specialty
//     → locks email (readOnly)
//
//   createPractice action
//     → accepts inviteToken input
//     → after practice row is created, calls accept_practice_invitation RPC
//
//   Auto-onboarded trigger (0069)
//     → covered by crm-migrations.test.ts

const ROOT = resolve(process.cwd());
function read(p: string): string { return readFileSync(resolve(ROOT, p), 'utf8'); }

describe('markSigned — creates a practice_invitation + returns signup URL', () => {
  const SRC = read('app/crm/leads/actions.ts');

  it('mints a 32-byte hex token', () => {
    expect(SRC).toMatch(/randomBytes\s*\(\s*32\s*\)\s*\.toString\s*\(\s*['"]hex['"]\s*\)/);
  });

  it('inserts into practice_invitations with the linked lead_id', () => {
    expect(SRC).toMatch(/from\s*\(\s*['"]practice_invitations['"]\s*\)/);
    expect(SRC).toMatch(/lead_id/);
  });

  it('advances the lead stage to "signed" after invite creation', () => {
    expect(SRC).toMatch(/stage:\s*['"]signed['"]/);
  });

  it('returns a /signup/practice?token=… URL', () => {
    expect(SRC).toMatch(/\/signup\/practice\?token=/);
  });

  it('is idempotent — reuses an active existing invite instead of double-inserting', () => {
    expect(SRC).toMatch(/existing/);
    expect(SRC).toMatch(/\.is\s*\(\s*['"]accepted_at['"]\s*,\s*null\s*\)/);
    expect(SRC).toMatch(/expires_at/);
  });
});

describe('/signup/practice — accepts ?token= and pre-fills', () => {
  const PAGE     = read('app/signup/practice/page.tsx');
  const ACTIONS  = read('app/signup/practice/actions.ts');

  it('page.tsx imports getPracticeInvitationByToken', () => {
    expect(PAGE).toMatch(/getPracticeInvitationByToken/);
  });

  it('page.tsx reads token from window.location.search on mount', () => {
    expect(PAGE).toMatch(/window\.location\.search/);
    expect(PAGE).toMatch(/URLSearchParams/);
    expect(PAGE).toMatch(/get\s*\(\s*['"]token['"]\s*\)/);
  });

  it('page.tsx sets emailLocked when a valid invite pre-fills', () => {
    expect(PAGE).toMatch(/setEmailLocked\s*\(\s*true\s*\)/);
    expect(PAGE).toMatch(/readOnly\s*=\s*\{\s*emailLocked\s*\}/);
  });

  it('page.tsx threads inviteToken through to createPractice', () => {
    expect(PAGE).toMatch(/inviteToken:\s*inviteToken/);
  });

  it('actions.ts exposes CreatePracticeInput.inviteToken as optional', () => {
    expect(ACTIONS).toMatch(/inviteToken\?:\s*string/);
  });

  it('actions.ts calls accept_practice_invitation after practice creation', () => {
    expect(ACTIONS).toMatch(/\.rpc\s*\(\s*['"]accept_practice_invitation['"]/);
    expect(ACTIONS).toMatch(/p_practice_id:\s*practiceId/);
  });

  it('actions.ts exports getPracticeInvitationByToken that calls the SECURITY DEFINER RPC', () => {
    expect(ACTIONS).toMatch(/export\s+async\s+function\s+getPracticeInvitationByToken/);
    expect(ACTIONS).toMatch(/\.rpc\s*\(\s*['"]get_practice_invitation_by_token['"]/);
  });
});
