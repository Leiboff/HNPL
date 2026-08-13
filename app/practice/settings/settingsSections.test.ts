import { describe, it, expect } from 'vitest';
import {
  visibleSettingsSections,
  canSeeSettingsSection,
  canSeeAnySettingsSection,
  SETTINGS_LABEL,
  type SettingsAuthority,
} from './settingsSections';

// ─── Which Settings sections may this viewer see? ─────────────────────────
//
// Folding three screens into one tab is only safe if their three authorities
// survive the fold. This is where that is proved, because it is the one place
// both the page and the nav ask the question — an async server component
// cannot be rendered in a unit test, and a nav item that appears for a page
// that will refuse you is the bug the shared source exists to prevent.
//
// The four viewers below are the real ones from the roster:
//
//   brand-admin        practice_group_members row for the practice's group.
//                      canManageTill is TRUE for them too, because
//                      resolvePracticeShellAuthority defines it as
//                      can_manage_practice OR isBrandAdmin.
//   practice manager   can_manage_practice, not a brand-admin.
//   reception admin    an active member with neither flag.
//   provider           same shape as reception here — role does not grant
//                      either flag.

const brandAdmin:      SettingsAuthority = { isBrandAdmin: true,  canManageTill: true  };
const practiceManager: SettingsAuthority = { isBrandAdmin: false, canManageTill: true  };
const receptionAdmin:  SettingsAuthority = { isBrandAdmin: false, canManageTill: false };

describe('a brand-admin sees all three sections', () => {
  it('details, banking and till, in render order', () => {
    expect(visibleSettingsSections(brandAdmin).map((s) => s.key))
      .toEqual(['details', 'banking', 'till']);
  });

  it('each section carries the anchor the page renders as an id', () => {
    for (const s of visibleSettingsSections(brandAdmin)) {
      expect(s.anchor).toBe(s.key);
      expect(s.title.length).toBeGreaterThan(0);
    }
  });
});

describe('a practice manager who is NOT a brand-admin sees the till only', () => {
  it('gets the till section', () => {
    expect(visibleSettingsSections(practiceManager).map((s) => s.key)).toEqual(['till']);
  });

  it('does NOT get details or banking', () => {
    // guardBrandAdminOfPractice is what both save actions enforce, and
    // /practice/details answered a non-brand-admin with notFound(). Folding
    // the screens together must not hand this viewer the practice's address
    // and bank account number.
    expect(canSeeSettingsSection('details', practiceManager)).toBe(false);
    expect(canSeeSettingsSection('banking', practiceManager)).toBe(false);
  });

  it('still gets the Settings tab, because one section is enough', () => {
    expect(canSeeAnySettingsSection(practiceManager)).toBe(true);
  });
});

describe('a viewer with neither authority sees no Settings at all', () => {
  it('has no visible sections', () => {
    expect(visibleSettingsSections(receptionAdmin)).toEqual([]);
  });

  it('gets no Settings tab — which is also the page’s own notFound() condition', () => {
    // The same helper decides both, so the nav cannot advertise a page that
    // will refuse the click.
    expect(canSeeAnySettingsSection(receptionAdmin)).toBe(false);
  });

  it('is refused every section individually', () => {
    for (const key of ['details', 'banking', 'till'] as const) {
      expect(canSeeSettingsSection(key, receptionAdmin)).toBe(false);
    }
  });
});

describe('the two authorities stay separate', () => {
  it('details and banking track isBrandAdmin, nothing else', () => {
    expect(canSeeSettingsSection('details', { isBrandAdmin: true, canManageTill: false })).toBe(true);
    expect(canSeeSettingsSection('banking', { isBrandAdmin: true, canManageTill: false })).toBe(true);
    expect(canSeeSettingsSection('details', { isBrandAdmin: false, canManageTill: true })).toBe(false);
  });

  it('the till tracks canManageTill, nothing else', () => {
    expect(canSeeSettingsSection('till', { isBrandAdmin: false, canManageTill: true })).toBe(true);
    // An isBrandAdmin=true, canManageTill=false pair cannot occur in
    // production (the resolver derives one from the other), but the section
    // must key on its OWN flag rather than inferring from the other — that
    // inference is what would silently widen the gate if the resolver's
    // definition ever changed.
    expect(canSeeSettingsSection('till', { isBrandAdmin: true, canManageTill: false })).toBe(false);
  });

  it('the section list is order-stable as sections drop out', () => {
    // The till stays last whether or not the two above it are present, so a
    // manager's one section does not move around under them.
    expect(visibleSettingsSections(brandAdmin).at(-1)!.key).toBe('till');
    expect(visibleSettingsSections(practiceManager).at(-1)!.key).toBe('till');
  });

  it('returns a fresh array each call — no shared mutable state', () => {
    const a = visibleSettingsSections(brandAdmin);
    a.pop();
    expect(visibleSettingsSections(brandAdmin)).toHaveLength(3);
  });
});

describe('the label', () => {
  it('is owned here, so the nav and its tests cannot disagree about it', () => {
    expect(SETTINGS_LABEL).toBe('Settings');
  });
});
