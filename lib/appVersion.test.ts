import { describe, it, expect } from 'vitest';
import { resolveAppVersion } from './appVersion';

// ─── App version resolution ──────────────────────────────────────────────
//
// The behaviour that matters is the NULL case. Everything else on this
// screen follows the rule "render nothing where the data does not exist",
// and a footer reading "v" or "unknown" or "dev" would be the one place the
// page broke its own rule. So the absence cases are tested first and hardest.

describe('resolveAppVersion — the absence cases', () => {
  it('returns null when neither variable is set', () => {
    expect(resolveAppVersion({})).toBeNull();
  });

  it('returns null when both are empty strings', () => {
    // How a misconfigured pipeline presents itself: the variable exists but
    // holds nothing. "v" alone on the footer is worse than no footer line.
    expect(resolveAppVersion({ npm_package_version: '', VERCEL_GIT_COMMIT_SHA: '' })).toBeNull();
  });

  it('returns null when both are whitespace', () => {
    expect(resolveAppVersion({ npm_package_version: '  ', VERCEL_GIT_COMMIT_SHA: '\t' })).toBeNull();
  });

  it('never returns the strings a placeholder would be', () => {
    // The failure this catches is a future edit adding a fallback.
    for (const env of [{}, { npm_package_version: '' }, { VERCEL_GIT_COMMIT_SHA: '' }]) {
      const out = resolveAppVersion(env);
      expect(out).toBeNull();
      expect(out).not.toBe('undefined');
      expect(out).not.toBe('unknown');
      expect(out).not.toBe('dev');
    }
  });
});

describe('resolveAppVersion — the present cases', () => {
  it('renders version alone when only the package version is set', () => {
    expect(resolveAppVersion({ npm_package_version: '0.1.0' })).toBe('v0.1.0');
  });

  it('shortens a commit SHA to seven characters, as git does', () => {
    expect(resolveAppVersion({ VERCEL_GIT_COMMIT_SHA: 'a1b2c3d4e5f6a7b8c9d0' })).toBe('a1b2c3d');
  });

  it('joins both with a middot when both are set', () => {
    expect(
      resolveAppVersion({ npm_package_version: '0.1.0', VERCEL_GIT_COMMIT_SHA: 'a1b2c3d4e5' }),
    ).toBe('v0.1.0 · a1b2c3d');
  });

  it('trims surrounding whitespace rather than rendering it', () => {
    expect(resolveAppVersion({ npm_package_version: ' 0.2.1 ' })).toBe('v0.2.1');
  });

  it('reads process.env by default without throwing', () => {
    // The real call site passes no argument. The result depends on the
    // environment, so assert only the contract: a non-empty string, or null.
    const out = resolveAppVersion();
    expect(out === null || (typeof out === 'string' && out.length > 0)).toBe(true);
  });
});
