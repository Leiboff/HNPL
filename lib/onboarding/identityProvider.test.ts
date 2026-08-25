import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const dhaResolver = vi.fn();
const dnxResolver = vi.fn();

vi.mock('./dhaVerification', () => ({ resolveIdentityRoute: dhaResolver }));
vi.mock('./datanamixVerification', () => ({ resolveDatanamixRoute: dnxResolver }));

const { identityProvider, resolveIdentityRouteForProvider } = await import('./identityProvider');

const ORIGINAL = process.env.IDENTITY_PHOTO_PROVIDER;

beforeEach(() => {
  dhaResolver.mockReset().mockResolvedValue({ kind: 'dha', photoBase64: 'x', outcomeCode: 'MATCH' });
  dnxResolver.mockReset().mockResolvedValue({ kind: 'dha', photoBase64: 'y', outcomeCode: 'DNX_MATCH' });
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.IDENTITY_PHOTO_PROVIDER;
  else process.env.IDENTITY_PHOTO_PROVIDER = ORIGINAL;
});

describe('the default is the AUTHORITATIVE source, never the cheaper one', () => {
  // A missing, empty, or misspelt env var must degrade to the live
  // registry. Defaulting to the bureau copy would mean a config typo
  // silently downgraded every applicant to data up to 90 days stale.
  it.each([
    ['unset',      undefined],
    ['empty',      ''],
    ['misspelt',   'datanamiks'],
    ['wrong case', 'DATANAMIX'],
    ['whitespace', ' datanamix '],
    ['the didit value', 'didit_dha'],
    ['nonsense',   'true'],
  ])('%s resolves to didit_dha', async (_label, value) => {
    if (value === undefined) delete process.env.IDENTITY_PHOTO_PROVIDER;
    else process.env.IDENTITY_PHOTO_PROVIDER = value;

    expect(identityProvider()).toBe('didit_dha');

    const { provider } = await resolveIdentityRouteForProvider('9611075045083', 'user-1');
    expect(provider).toBe('didit_dha');
    expect(dhaResolver).toHaveBeenCalledOnce();
    expect(dnxResolver).not.toHaveBeenCalled();
  });
});

describe('the exact opt-in value selects datanamix', () => {
  it('routes through resolveDatanamixRoute and reports the provider', async () => {
    process.env.IDENTITY_PHOTO_PROVIDER = 'datanamix';

    expect(identityProvider()).toBe('datanamix');

    const { provider, route } = await resolveIdentityRouteForProvider('9611075045083', 'user-1');
    expect(provider).toBe('datanamix');
    expect(route).toMatchObject({ outcomeCode: 'DNX_MATCH' });
    expect(dnxResolver).toHaveBeenCalledWith('9611075045083', 'user-1');
    expect(dhaResolver).not.toHaveBeenCalled();
  });

  it('passes non-approve routes through untouched', async () => {
    process.env.IDENTITY_PHOTO_PROVIDER = 'datanamix';
    dnxResolver.mockResolvedValue({ kind: 'reject', reason: 'dnx_deceased' });

    const { provider, route } = await resolveIdentityRouteForProvider('9611075045083', 'user-1');
    expect(provider).toBe('datanamix');
    expect(route).toEqual({ kind: 'reject', reason: 'dnx_deceased' });
  });

  it('only ever calls ONE provider — never both, never a fallback between them', async () => {
    // A no-match must decline, not silently retry the other registry.
    // Two lookups per applicant would also double the cost.
    process.env.IDENTITY_PHOTO_PROVIDER = 'datanamix';
    dnxResolver.mockResolvedValue({ kind: 'reject', reason: 'dnx_no_match' });

    await resolveIdentityRouteForProvider('9611075045083', 'user-1');
    expect(dnxResolver).toHaveBeenCalledOnce();
    expect(dhaResolver).not.toHaveBeenCalled();
  });
});
