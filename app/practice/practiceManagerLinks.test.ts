import { describe, it, expect } from 'vitest';
import {
  getPracticeManagerLinks,
  getBrandExitLink,
  ALL_PRACTICES_LABEL,
} from './practiceManagerLinks';

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
    // Points into the shell's own tree now — /brand/branch/{id} used to
    // host the settings while also being a multi-branch performance view;
    // it pivots into the practice dashboard and the settings moved to
    // /practice/details. Gate unchanged (isBrandAdmin && practiceId).
    expect(links).toEqual([{ href: '/practice/details?practiceId=p1', label: 'Practice details' }]);
  });

  it('no link anywhere still points at the retired /brand/branch settings route', () => {
    for (const ctx of [
      { practiceId: 'p1', canManageTill: true, isBrandAdmin: true },
      { practiceId: 'p1', isBrandAdmin: true },
    ]) {
      for (const l of getPracticeManagerLinks(ctx)) {
        expect(l.href).not.toMatch(/^\/brand\/branch\//);
      }
    }
  });

  it('returns both, Till devices first, when both are true', () => {
    const links = getPracticeManagerLinks({ practiceId: 'p1', canManageTill: true, isBrandAdmin: true });
    expect(links).toEqual([
      { href: '/practice/pos/devices?practiceId=p1', label: 'Till devices' },
      { href: '/practice/details?practiceId=p1',     label: 'Practice details' },
    ]);
  });

  it('omits Practice details without a practiceId even if isBrandAdmin is true (no ?practiceId=undefined)', () => {
    const links = getPracticeManagerLinks({ canManageTill: true, isBrandAdmin: true });
    expect(links).toEqual([{ href: '/practice/pos/devices', label: 'Till devices' }]);
  });

  it('Till devices link has no ?practiceId= suffix when practiceId is omitted', () => {
    const links = getPracticeManagerLinks({ canManageTill: true });
    expect(links).toEqual([{ href: '/practice/pos/devices', label: 'Till devices' }]);
  });
});

// ─── getBrandExitLink — the way back out of a single practice ──────────
//
// A brand-admin who clicks into a branch now lands in that practice's
// ordinary dashboard. Without this they're stranded there with no signal
// they're wearing a brand-admin hat.

describe('getBrandExitLink', () => {
  it('links to /brand for a brand-admin with 2+ practices in the brand', () => {
    expect(getBrandExitLink({ isBrandAdmin: true, brandPracticeCount: 2 }))
      .toEqual({ href: '/brand', label: ALL_PRACTICES_LABEL });
  });

  it('THE SOLO-OWNER CASE: brand-admin of a 1-practice brand gets nothing', () => {
    // Post-0062 every solo owner is auto-brand-admin of a silently
    // created 1-practice brand, and /brand redirects n=1 straight back to
    // /practice — so gating on isBrandAdmin alone would give a solo
    // practitioner a link that bounces and says "practices" plural about
    // their single practice.
    expect(getBrandExitLink({ isBrandAdmin: true, brandPracticeCount: 1 })).toBeNull();
  });

  it("a practice's own staff get nothing, whatever the brand's size", () => {
    expect(getBrandExitLink({ isBrandAdmin: false, brandPracticeCount: 7 })).toBeNull();
    expect(getBrandExitLink({ isBrandAdmin: false, canManageTill: true, brandPracticeCount: 7 })).toBeNull();
  });

  it('defaults to nothing when neither field is supplied', () => {
    expect(getBrandExitLink({})).toBeNull();
  });

  it('does not depend on practiceId — it leaves the practice scope entirely', () => {
    expect(getBrandExitLink({ isBrandAdmin: true, brandPracticeCount: 3, practiceId: 'p1' })?.href)
      .toBe('/brand');
  });
});
