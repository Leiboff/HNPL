// ─── Which Settings sections may this viewer see? ─────────────────────────
//
// Settings folds THREE previously separate screens into one route, and they
// did not share an authority:
//
//   practice details  ─┐ /practice/details, which notFound()s anyone who is
//   banking           ─┘ not a brand-admin. Both save actions
//                        (app/brand/actions.ts updateBranchDetails /
//                        updateBranchBanking) are guarded by
//                        guardBrandAdminOfPractice — an active
//                        practice_group_members row for the practice's group,
//                        NOT can_manage_practice.
//
//   till devices        /practice/pos/devices, whose every action is guarded
//                       by guardTillManager — per-practice
//                       can_manage_practice OR brand-admin of the group.
//
// Folding them into one tab does NOT fold their gates together. A plain
// practice manager who is not a brand-admin gets the till section and nothing
// else; a brand-admin gets all three. That is the same authority each screen
// enforced on its own, unchanged — this module only decides what to RENDER.
// The server-side write guards are untouched and remain the real boundary.
//
// WHY THIS IS A SHARED PURE MODULE
// ───────────────────────────────
// Two callers have to agree, and would otherwise drift:
//   • the Settings PAGE, deciding which sections to render (and whether to
//     notFound() because there are none)
//   • the NAV, deciding whether the Settings item appears at all
// A nav item that appears when the page will refuse you is the exact class of
// bug the shared link source (../practiceManagerLinks) exists to prevent, so
// the answer is computed once, here, and both read it.
//
// Pure and dependency-free on purpose: ../practiceManagerLinks is imported by
// 'use client' components, so anything it reaches must be safe in a browser
// bundle.

/** Anchor ids, so a deep link lands on the right section. */
export type SettingsSectionKey = 'details' | 'banking' | 'till';

export type SettingsAuthority = {
  /** Active practice_group_members row for the practice's brand. */
  isBrandAdmin:  boolean;
  /** can_manage_practice OR isBrandAdmin — what guardTillManager checks. */
  canManageTill: boolean;
};

export type SettingsSection = {
  key:   SettingsSectionKey;
  /** Nav-within-page label, and the section heading. */
  title: string;
  /** `#`-anchor, matching the id the page renders. */
  anchor: string;
};

/**
 * Declared in RENDER ORDER: who you are, where the money goes, then the
 * hardware. Details before banking because banking's own hint anchors down
 * to it, and the till last because it is the only section a non-brand-admin
 * can reach — putting it last keeps its position stable whether or not the
 * two above it are present.
 */
const SECTIONS: Array<SettingsSection & { visible: (a: SettingsAuthority) => boolean }> = [
  {
    key: 'details', title: 'Practice details', anchor: 'details',
    visible: (a) => a.isBrandAdmin,
  },
  {
    key: 'banking', title: 'Banking', anchor: 'banking',
    visible: (a) => a.isBrandAdmin,
  },
  {
    key: 'till', title: 'Till devices', anchor: 'till',
    visible: (a) => a.canManageTill,
  },
];

/** Sections this viewer may see, in render order. Possibly empty. */
export function visibleSettingsSections(a: SettingsAuthority): SettingsSection[] {
  return SECTIONS.filter((s) => s.visible(a)).map(({ key, title, anchor }) => ({ key, title, anchor }));
}

/** True when a section is visible to this viewer. */
export function canSeeSettingsSection(key: SettingsSectionKey, a: SettingsAuthority): boolean {
  return visibleSettingsSections(a).some((s) => s.key === key);
}

/**
 * The nav gate AND the page's own notFound() condition, so they cannot
 * disagree: the Settings item appears exactly when there is at least one
 * section behind it.
 */
export function canSeeAnySettingsSection(a: SettingsAuthority): boolean {
  return visibleSettingsSections(a).length > 0;
}

/** Label kept in one place — both nav surfaces and their tests read it. */
export const SETTINGS_LABEL = 'Settings';
