import { describe, it, expect } from 'vitest';
import { getPracticeManagerLinks } from './practiceManagerLinks';

// ─── getPracticeManagerLinks — the single source for BOTH surfaces ────
//
// PracticeNav (desktop) and PracticeHeader (mobile) both splice this
// function's output onto their own base link list. Testing it directly
// pins the href/label/conditional shape once; practiceNavParity.test.tsx
// separately proves both components actually consume it identically.

describe('getPracticeManagerLinks', () => {
  it('returns no links when neither canManageTill nor isBrandAdmin is set', () => {
    expect(getPracticeManagerLinks({ practiceId: 'p1' })).toEqual([]);
  });

  it('returns only Till devices when canManageTill is true and isBrandAdmin is false', () => {
    const links = getPracticeManagerLinks({ practiceId: 'p1', canManageTill: true });
    expect(links).toEqual([{ href: '/practice/pos/devices?practiceId=p1', label: 'Till devices' }]);
  });

  it('returns only Practice details when isBrandAdmin is true and canManageTill is false', () => {
    const links = getPracticeManagerLinks({ practiceId: 'p1', isBrandAdmin: true });
    expect(links).toEqual([{ href: '/brand/branch/p1', label: 'Practice details' }]);
  });

  it('returns both, Till devices first, when both are true', () => {
    const links = getPracticeManagerLinks({ practiceId: 'p1', canManageTill: true, isBrandAdmin: true });
    expect(links).toEqual([
      { href: '/practice/pos/devices?practiceId=p1', label: 'Till devices' },
      { href: '/brand/branch/p1',                     label: 'Practice details' },
    ]);
  });

  it('omits Practice details without a practiceId even if isBrandAdmin is true (no /brand/branch/undefined)', () => {
    const links = getPracticeManagerLinks({ canManageTill: true, isBrandAdmin: true });
    expect(links).toEqual([{ href: '/practice/pos/devices', label: 'Till devices' }]);
  });

  it('Till devices link has no ?practiceId= suffix when practiceId is omitted', () => {
    const links = getPracticeManagerLinks({ canManageTill: true });
    expect(links).toEqual([{ href: '/practice/pos/devices', label: 'Till devices' }]);
  });
});
