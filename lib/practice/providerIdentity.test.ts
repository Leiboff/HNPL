import { describe, it, expect } from 'vitest';
import {
  providerMemberName,
  hasLogin,
  PROVIDER_MEMBER_SELECT,
  type ProviderMemberRef,
} from './providerIdentity';

// ─── Where a practitioner's name lives ────────────────────────────────────
//
// After 0091 the name is on profiles OR on the membership's own columns, never
// both. After 0094 every "who treated this patient" surface resolves through
// this one function, so a bug here renders a blank practitioner everywhere at
// once — which reads to a practice as lost data rather than as a display bug.

const withLogin: ProviderMemberRef = {
  id: 'mem-1', user_id: 'u-1',
  provider_first_name: null, provider_last_name: null,
  specialty: 'Dentistry',
  profiles: { first_name: 'Naledi', last_name: 'Dlamini' },
};

const rosterOnly: ProviderMemberRef = {
  id: 'mem-2', user_id: null,
  provider_first_name: 'Zanele', provider_last_name: 'Mthembu',
  specialty: 'Optometry',
  profiles: null,
};

describe('providerMemberName', () => {
  it('reads a login-having practitioner\'s name from profiles', () => {
    expect(providerMemberName(withLogin)).toBe('Naledi Dlamini');
  });

  it('reads a roster-only practitioner\'s name from the membership', () => {
    expect(providerMemberName(rosterOnly)).toBe('Zanele Mthembu');
  });

  it('handles the embed arriving as a single-element array', () => {
    // PostgREST returns an object or an array depending on how it infers the
    // relation; both shapes reach this code in practice.
    expect(providerMemberName({
      ...withLogin,
      profiles: [{ first_name: 'Naledi', last_name: 'Dlamini' }],
    })).toBe('Naledi Dlamini');
  });

  it('falls back to the roster columns when the profile embed is empty', () => {
    // A membership WITH a login whose profile the caller cannot read (RLS) —
    // better to show whatever name is on the row than nothing at all.
    expect(providerMemberName({
      ...rosterOnly, user_id: 'u-9', profiles: [],
    })).toBe('Zanele Mthembu');
  });

  it('returns — rather than an empty string when nothing is recorded', () => {
    // An empty cell reads as a layout bug; a dash reads as "not recorded",
    // and only the second is true.
    expect(providerMemberName({
      id: 'm', user_id: null,
      provider_first_name: null, provider_last_name: null, profiles: null,
    })).toBe('—');
    expect(providerMemberName(null)).toBe('—');
    expect(providerMemberName(undefined)).toBe('—');
  });

  it('does not emit a stray space when only one name part exists', () => {
    expect(providerMemberName({
      id: 'm', user_id: null,
      provider_first_name: 'Zanele', provider_last_name: null, profiles: null,
    })).toBe('Zanele');
  });
});

describe('hasLogin', () => {
  it('distinguishes a roster entry from a signed-up practitioner', () => {
    expect(hasLogin(withLogin)).toBe(true);
    expect(hasLogin(rosterOnly)).toBe(false);
  });
});

describe('PROVIDER_MEMBER_SELECT', () => {
  it('selects every field the resolver actually reads', () => {
    // The select list and the resolver are a pair; if a caller narrows the
    // select, the fallback silently stops working.
    for (const field of [
      'id', 'user_id', 'provider_first_name', 'provider_last_name',
      'specialty', 'profiles(first_name, last_name)',
    ]) {
      expect(PROVIDER_MEMBER_SELECT).toContain(field);
    }
  });
});
