// ─── Shared colour tokens for the brand surface ─────────────────────────────
//
// One small palette so the mint/navy/teal used across BrandShell, BrandNav,
// BrandQuickActions, BrandPayoutBlock and the practices list can't drift into
// slightly different hexes per file. Values only — no components here.

export const brand = {
  ink:      '#13294B',
  navy:     '#13294B',
  teal:     '#15A89E',
  tealDeep: '#0C8579',
  mint:     '#E7F6F3',
  mintDeep: '#D3EEE8',
  paper:    '#FBFCFC',
  line:     '#EFF3F4',
  muted:    '#6B7885',
  faint:    '#9AA6B1',
  amber:    '#B87516',
} as const;

export const cardShadow = '0 2px 16px -10px rgba(19,41,75,.22)';
