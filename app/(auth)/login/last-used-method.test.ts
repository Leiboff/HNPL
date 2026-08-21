import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── "Last used" sign-in highlight — wiring pins ─────────────────────────
//
// Source-level, matching every other test that touches this heavy page
// (see app/google-oauth.test.ts, lib/auth/sessionCap.test.ts, etc.) — real
// behaviour for the underlying storage lives in
// lib/auth/lastSignInMethod.test.ts, which actually round-trips
// localStorage; this file only pins that the three sign-in paths call it
// at the right moments and that the highlight is wired to state.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const codeOf = (p: string) => stripComments(read(p));

const LOGIN  = codeOf('app/(auth)/login/page.tsx');
const GOOGLE = codeOf('app/_components/ContinueWithGoogleButton.tsx');
const PILL   = codeOf('app/_components/LastUsedPill.tsx');

describe('each of the three sign-in paths records its method', () => {
  it('password: recorded WITH the email, after success, before the redirect', () => {
    const submitIdx  = LOGIN.indexOf('async function handleSubmit');
    const recordIdx  = LOGIN.indexOf("setLastSignInMethod('password', email)", submitIdx);
    const redirectIdx = LOGIN.indexOf('window.location.href = nextPath', submitIdx);
    expect(submitIdx).toBeGreaterThan(-1);
    expect(recordIdx).toBeGreaterThan(submitIdx);
    expect(redirectIdx).toBeGreaterThan(recordIdx);
  });

  it('password: recorded only on the success path, not before the signInWithPassword call', () => {
    const submitIdx    = LOGIN.indexOf('async function handleSubmit');
    const signInIdx    = LOGIN.indexOf('signInWithPassword', submitIdx);
    const recordIdx    = LOGIN.indexOf("setLastSignInMethod('password'", submitIdx);
    expect(recordIdx).toBeGreaterThan(signInIdx);
  });

  it('passkey: recorded inside onPasskeySuccess, before the redirect', () => {
    expect(LOGIN).toMatch(/onPasskeySuccess[\s\S]{0,120}nextPath/); // regression guard, unchanged
    const cbIdx      = LOGIN.indexOf('const onPasskeySuccess');
    const recordIdx  = LOGIN.indexOf("setLastSignInMethod('passkey')", cbIdx);
    const redirectIdx = LOGIN.indexOf('window.location.href = nextPath', cbIdx);
    expect(cbIdx).toBeGreaterThan(-1);
    expect(recordIdx).toBeGreaterThan(cbIdx);
    expect(redirectIdx).toBeGreaterThan(recordIdx);
  });

  it('google: passed as onSignInAttempt, not called directly from /login (the button owns the timing)', () => {
    expect(LOGIN).toMatch(/onSignInAttempt=\{\(\)\s*=>\s*setLastSignInMethod\('google'\)\}/);
  });

  it('google: the button calls onSignInAttempt before signInWithOAuth — attempt, not confirmed success', () => {
    // See lib/auth/lastSignInMethod.ts's header: a full-page OAuth redirect
    // has no client-side "it worked" callback, so this one is deliberately
    // recorded on attempt rather than confirmed success like the other two.
    const attemptIdx  = GOOGLE.indexOf('onSignInAttempt?.()');
    const oauthIdx     = GOOGLE.indexOf('signInWithOAuth');
    expect(attemptIdx).toBeGreaterThan(-1);
    expect(oauthIdx).toBeGreaterThan(attemptIdx);
  });
});

describe('the highlight is read once on mount and never re-derived', () => {
  it('reads getLastSignInMethod inside its own useEffect(…, [])', () => {
    expect(LOGIN).toMatch(/useEffect\(\(\) => \{\s*const \{ method, email: savedEmail \} = getLastSignInMethod\(\);[\s\S]{0,300}\}, \[\]\);/);
  });

  it('prefills the email field only for the password method, only when one was saved', () => {
    expect(LOGIN).toMatch(/if \(method === 'password' && savedEmail\) setEmail\(savedEmail\);/);
  });
});

describe('exactly one option is ever highlighted, driven by the same `lastUsed` state', () => {
  it('passkey button', () => {
    expect(LOGIN).toMatch(/lastUsed === 'passkey'[\s\S]{0,40}<LastUsedPill/);
    expect(LOGIN).toMatch(/lastUsed === 'passkey' \? \{ borderColor: '#15A89E'/);
  });

  it('Google button — highlight is a prop, not a local decision inside the shared component', () => {
    expect(LOGIN).toMatch(/highlighted=\{lastUsed === 'google'\}/);
    expect(GOOGLE).toMatch(/highlighted\?\:\s*boolean/);
    expect(GOOGLE).toMatch(/highlighted && <LastUsedPill/);
  });

  it('password block wraps the cue + form, not just one input', () => {
    expect(LOGIN).toMatch(/lastUsed === 'password'[\s\S]{0,40}\?\s*\{\s*border:\s*'1\.5px solid #15A89E'/);
    const wrapIdx = LOGIN.indexOf("lastUsed === 'password'");
    const cueIdx  = LOGIN.indexOf('password-audience-cue');
    const formIdx = LOGIN.indexOf('<form onSubmit={handleSubmit}');
    expect(wrapIdx).toBeGreaterThan(-1);
    expect(cueIdx).toBeGreaterThan(wrapIdx);
    expect(formIdx).toBeGreaterThan(cueIdx);
  });
});

describe('LastUsedPill is one shared component, not three copies', () => {
  it('both call sites import it rather than redefining it', () => {
    expect(LOGIN).toMatch(/import LastUsedPill from ['"]@\/app\/_components\/LastUsedPill['"]/);
    expect(GOOGLE).toMatch(/import LastUsedPill from ['"]\.\/LastUsedPill['"]/);
  });

  it('renders the literal label a visitor reads', () => {
    expect(PILL).toMatch(/Last used/);
  });
});
