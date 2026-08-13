import { describe, it, expect } from 'vitest';
import {
  getPracticeBaseLinks,
  getPracticeManagerLinks,
  getPracticeNavLinks,
  getBrandExitLink,
  ALL_PRACTICES_LABEL,
} from './practiceManagerLinks';
import { SETTINGS_LABEL } from './settings/settingsSections';

// ─── The single source for BOTH nav surfaces ───────────────────────────
//
// PracticeNav (desktop) and PracticeHeader (mobile) call getPracticeNavLinks
// and nothing else. Testing the pieces directly pins the href/label/order
// shape once; practiceNavParity.test.tsx separately proves both components
// actually consume it identically.

describe('getPracticeBaseLinks — visible to everyone in the practice area', () => {
  it('is Dashboard, Bills, Team — in that order', () => {
    expect(getPracticeBaseLinks({ practiceId: 'p1', teamLabel: 'Team' })).toEqual([
      { href: '/practice?practiceId=p1',         label: 'Dashboard' },
      { href: '/practice/bills?practiceId=p1',   label: 'Bills'     },
      { href: '/practice/members?practiceId=p1', label: 'Team'      },
    ]);
  });

  it('takes the Team label from the caller — the one surface difference', () => {
    // "Manage Practice" on mobile predates all of this and was never the
    // bug the shared source exists to fix. It is a parameter, not a second
    // hand-written list.
    const mobile = getPracticeBaseLinks({ practiceId: 'p1', teamLabel: 'Manage Practice' });
    expect(mobile.map((l) => l.label)).toEqual(['Dashboard', 'Bills', 'Manage Practice']);
    // Only the LABEL differs — the hrefs are identical to desktop's.
    expect(mobile.map((l) => l.href))
      .toEqual(getPracticeBaseLinks({ practiceId: 'p1', teamLabel: 'Team' }).map((l) => l.href));
  });

  it('scopes EVERY base link, which the mobile menu previously did not', () => {
    // The bug this move fixes: PracticeHeader hardcoded '/practice' and
    // '/practice/members' with no ?practiceId=, so a brand-admin viewing one
    // branch on mobile lost their branch scope on those two links.
    for (const l of getPracticeBaseLinks({ practiceId: 'p1', teamLabel: 'Team' })) {
      expect(l.href).toContain('?practiceId=p1');
    }
  });

  it('emits no query string at all without a practiceId — never ?practiceId=undefined', () => {
    expect(getPracticeBaseLinks({ teamLabel: 'Team' })).toEqual([
      { href: '/practice',         label: 'Dashboard' },
      { href: '/practice/bills',   label: 'Bills'     },
      { href: '/practice/members', label: 'Team'      },
    ]);
  });

  it('url-encodes the practice id', () => {
    const [dash] = getPracticeBaseLinks({ practiceId: 'a b&c', teamLabel: 'Team' });
    expect(dash.href).toBe('/practice?practiceId=a%20b%26c');
  });
});

describe('getPracticeManagerLinks — Settings, and nothing else', () => {
  it('returns no links when the viewer can see no Settings section', () => {
    expect(getPracticeManagerLinks({ practiceId: 'p1' })).toEqual([]);
  });

  it('shows Settings to a plain manager — the till section is theirs', () => {
    // canManageTill alone is enough: guardTillManager accepts
    // can_manage_practice, so there is a section behind the item.
    expect(getPracticeManagerLinks({ practiceId: 'p1', canManageTill: true })).toEqual([
      { href: '/practice/settings?practiceId=p1', label: SETTINGS_LABEL },
    ]);
  });

  it('shows Settings to a brand-admin — details and banking are theirs', () => {
    expect(getPracticeManagerLinks({ practiceId: 'p1', isBrandAdmin: true })).toEqual([
      { href: '/practice/settings?practiceId=p1', label: SETTINGS_LABEL },
    ]);
  });

  it('shows it ONCE when both apply, not twice', () => {
    expect(getPracticeManagerLinks({ practiceId: 'p1', canManageTill: true, isBrandAdmin: true }))
      .toEqual([{ href: '/practice/settings?practiceId=p1', label: SETTINGS_LABEL }]);
  });

  it('no longer emits Till devices or Practice details as separate entries', () => {
    // They are SECTIONS of Settings now. Their routes still resolve as
    // redirects, so nothing that linked to them breaks — but the nav must
    // not offer them as peers of Dashboard and Team any more.
    const links = getPracticeManagerLinks({ practiceId: 'p1', canManageTill: true, isBrandAdmin: true });
    expect(links.map((l) => l.label)).not.toContain('Till devices');
    expect(links.map((l) => l.label)).not.toContain('Practice details');
    for (const l of links) {
      expect(l.href).not.toMatch(/\/practice\/pos\/devices/);
      expect(l.href).not.toMatch(/\/practice\/details/);
    }
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

  it('still offers Settings without a practiceId, unscoped', () => {
    // Unlike the old "Practice details" entry, which was dropped entirely
    // without an id: the Settings page has the same first-membership
    // fallback every other /practice/** screen has, so an unscoped link
    // resolves rather than dead-ending.
    expect(getPracticeManagerLinks({ canManageTill: true })).toEqual([
      { href: '/practice/settings', label: SETTINGS_LABEL },
    ]);
  });
});

describe('getPracticeNavLinks — the whole nav, in order', () => {
  it('is Dashboard · Bills · Team · Settings for a manager', () => {
    expect(
      getPracticeNavLinks({ practiceId: 'p1', canManageTill: true, teamLabel: 'Team' })
        .map((l) => l.label),
    ).toEqual(['Dashboard', 'Bills', 'Team', SETTINGS_LABEL]);
  });

  it('drops Settings for someone with no section behind it', () => {
    expect(
      getPracticeNavLinks({ practiceId: 'p1', teamLabel: 'Team' }).map((l) => l.label),
    ).toEqual(['Dashboard', 'Bills', 'Team']);
  });

  it('puts the brand exit link ABOVE everything', () => {
    // It exits upward to the brand view rather than being a peer of the tabs.
    expect(
      getPracticeNavLinks({
        practiceId: 'p1', isBrandAdmin: true, canManageTill: true,
        brandPracticeCount: 3, teamLabel: 'Team',
      }).map((l) => l.label),
    ).toEqual([ALL_PRACTICES_LABEL, 'Dashboard', 'Bills', 'Team', SETTINGS_LABEL]);
  });

  it('does NOT include Payouts — there is no route behind it yet', () => {
    // A nav entry pointing at nothing is worse than a missing one. This
    // fails the day the route lands, which is when the entry should appear.
    for (const ctx of [
      { practiceId: 'p1', teamLabel: 'Team' },
      { practiceId: 'p1', canManageTill: true, isBrandAdmin: true, brandPracticeCount: 3, teamLabel: 'Team' },
    ]) {
      const links = getPracticeNavLinks(ctx);
      expect(links.map((l) => l.label)).not.toContain('Payouts');
      for (const l of links) expect(l.href).not.toMatch(/\/practice\/payouts/);
    }
  });

  it('never emits a duplicate href', () => {
    const links = getPracticeNavLinks({
      practiceId: 'p1', isBrandAdmin: true, canManageTill: true,
      brandPracticeCount: 3, teamLabel: 'Team',
    });
    expect(new Set(links.map((l) => l.href)).size).toBe(links.length);
  });
});

// ─── getBrandExitLink — the way back out of a single practice ──────────
//
// A brand-admin who clicks into a branch lands in that practice's ordinary
// dashboard. Without this they're stranded there with no signal they're
// wearing a brand-admin hat. Gating unchanged by the restructure.

describe('getBrandExitLink', () => {
  it('links to /brand for a brand-admin with 2+ practices in the brand', () => {
    expect(getBrandExitLink({ isBrandAdmin: true, brandPracticeCount: 2 }))
      .toEqual({ href: '/brand', label: ALL_PRACTICES_LABEL });
  });

  it('THE SOLO-OWNER CASE: brand-admin of a 1-practice brand gets nothing', () => {
    // Post-0062 every solo owner is auto-brand-admin of a silently created
    // 1-practice brand, and /brand redirects n=1 straight back to /practice
    // — so gating on isBrandAdmin alone would give a solo practitioner a
    // link that bounces and says "practices" plural about their single one.
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
