'use client';

import type { TradingGateResult } from '@/lib/practice/tradingGate';

// ─── CreateBillButton ────────────────────────────────────────────────────────
//
// Single render path for every "Create a bill" entry point on the practice
// surface. The trading gate (lib/practice/tradingGate.ts) is the source of
// truth — when it returns ok=false, the button is disabled, carries the
// gate's actionable message as title text, and aria-disabled so screen
// readers announce it. Three visual variants cover the existing layout:
//
//   primary  — top-right of the dashboard heading row. Gradient-filled.
//   subtle   — inline "+ New bill" link in the recent-bills card header.
//              Text-only treatment in teal.
//   cta      — gradient button in the empty-state of the bills card.
//
// Adding a new entry point? Use this component, not a hand-rolled <a> to
// /practice/bills/new. A source-text regression test
// (app/practice/create-bill-entries.test.ts) bans hardcoded
// /practice/bills/new hrefs outside this component + the page guard, so a
// future copy-paste can't silently re-introduce an ungated link.

const VARIANT_CLASSES: Record<Variant, { base: string; gated: string }> = {
  primary: {
    base: 'shrink-0 rounded-lg px-4 py-2 sm:px-5 sm:py-2.5 text-sm font-semibold text-white focus:outline-none focus:ring-2 focus:ring-[#15A89E] focus:ring-offset-2 transition-all hover:shadow-lg',
    gated: 'opacity-50 cursor-not-allowed hover:shadow-none',
  },
  subtle: {
    base: 'text-sm font-medium text-[#15A89E] hover:text-[#13294B] transition-colors',
    gated: 'text-gray-400 cursor-not-allowed hover:text-gray-400',
  },
  cta: {
    base: 'mt-5 inline-block rounded-lg px-5 py-2.5 text-sm font-semibold text-white transition-all hover:shadow-lg',
    gated: 'opacity-50 cursor-not-allowed hover:shadow-none',
  },
};

const GRADIENT_BG = 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)';

type Variant = 'primary' | 'subtle' | 'cta';

type Props = {
  gate:     TradingGateResult;
  variant:  Variant;
  /** Display text. Defaults match the legacy hardcoded labels per variant. */
  label?:   string;
  /**
   * The practice this CTA is scoped to. Forwarded onto
   * /practice/bills/new as ?practiceId= so a brand-admin with N≥2
   * branches gets a bill form scoped to the branch they were viewing
   * (not their oldest membership). Solo callers (N=1) can omit — the
   * new-bill page falls back to the caller's only membership.
   */
  practiceId?: string;
};

export default function CreateBillButton({ gate, variant, label, practiceId }: Props) {
  const text = label ?? (variant === 'subtle' ? '+ New bill' : '+ Create a bill');
  const v    = VARIANT_CLASSES[variant];
  const usesGradient = variant !== 'subtle';
  const href = practiceId
    ? `/practice/bills/new?practiceId=${encodeURIComponent(practiceId)}`
    : '/practice/bills/new';

  if (gate.ok) {
    return (
      <a
        href={href}
        className={v.base}
        style={usesGradient ? { background: GRADIENT_BG } : undefined}
        data-testid={`create-bill-${variant}`}
      >
        {text}
      </a>
    );
  }

  return (
    <button
      type="button"
      disabled
      aria-disabled
      title={gate.message}
      className={`${v.base} ${v.gated}`}
      style={usesGradient ? { background: GRADIENT_BG } : undefined}
      data-testid={`create-bill-${variant}-disabled`}
    >
      {text}
    </button>
  );
}
