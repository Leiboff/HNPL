import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BillsTable from './BillsTable';
import { formatRand, formatDate, type PlanSummary } from './billHelpers';
import { calculateFee } from '@/lib/finance';
import { billLifecycleChip, type BillLifecycleStatus } from '@/lib/bills/lifecycle';

// ─── The four-column collapse ─────────────────────────────────────────────
//
// Ten columns became four: WHO / HOW MUCH / STATUS / WHEN. Two things are
// worth guarding beyond "it renders":
//
//   1. Nothing was DELETED from the product — the six fields that left the
//      scan columns must still be reachable, and still correct, behind the
//      per-row disclosure. A collapse that quietly drops the fee is a
//      regression dressed as a simplification.
//
//   2. Status is genuinely the DOMINANT element, not merely present. That is
//      the whole point of the change, so it gets a real assertion rather than
//      a screenshot and a promise — see the dominance describe block.
//
// Note on scoping: the responsive split is CSS-only (`md:hidden` /
// `hidden md:block`), so happy-dom renders BOTH breakpoints and every row
// appears twice. Queries are therefore scoped to one breakpoint container.
// Tests that assert a duplicate on purpose say so.

const FEE_PERCENT = 6;
const SPECIALTY_MAP = { 'mem-1': 'Dentistry', 'mem-roster': 'Optometry' };

function makePlan(over: Partial<PlanSummary> & { id: string }): PlanSummary {
  return {
    total_amount: 1000,
    status: 'pending_acceptance',
    created_at: '2026-08-11T10:00:00.000Z',
    invoice_number: `INV-${over.id}`,
    practice_reference: `REF-${over.id}`,
    provider_member_id: 'mem-1',
    patient: { first_name: 'Thabo', last_name: 'Mokoena' },
    // A practitioner WITH a login: name lives on profiles.
    provider_member: {
      id: 'mem-1', user_id: 'u-1',
      provider_first_name: null, provider_last_name: null,
      specialty: 'Dentistry',
      profiles: { first_name: 'Naledi', last_name: 'Dlamini' },
    },
    payouts:  null,
    invitations: null,
    ...over,
  };
}

// Every rendered lifecycle state. `declined` and `cancelled` are included
// deliberately: they are plans.status INPUTS that both derive to Expired —
// there is no "Declined" label in the vocabulary, and a test that assumed one
// would be asserting a status the app never shows.
const CASES: { label: string; plan: PlanSummary; status: BillLifecycleStatus }[] = [
  {
    label: 'paid (active plan)', status: 'paid',
    plan: makePlan({ id: 'b-paid', status: 'active', total_amount: 2400, payouts: { net_amount: 2256, status: 'paid' } }),
  },
  {
    label: 'sent (pending, never opened)', status: 'sent',
    plan: makePlan({ id: 'b-sent', status: 'pending_acceptance', total_amount: 1500 }),
  },
  {
    label: 'viewed (invitation opened)', status: 'viewed',
    plan: makePlan({
      id: 'b-viewed', status: 'pending_acceptance', total_amount: 980,
      invitations: { viewed_at: '2026-08-10T09:00:00.000Z', accepted_at: null, expires_at: '2099-01-01T00:00:00.000Z' },
    }),
  },
  {
    label: 'expired (link past expiry)', status: 'expired',
    plan: makePlan({
      id: 'b-expired', status: 'pending_acceptance', total_amount: 300,
      invitations: { viewed_at: null, accepted_at: null, expires_at: '2020-01-01T00:00:00.000Z' },
    }),
  },
  {
    label: 'declined plan → Expired (no "Declined" label exists)', status: 'expired',
    plan: makePlan({ id: 'b-declined', status: 'declined', total_amount: 750 }),
  },
  {
    label: 'cancelled plan → Expired', status: 'expired',
    plan: makePlan({ id: 'b-cancelled', status: 'cancelled', total_amount: 640 }),
  },
];

function renderTable(plans: PlanSummary[]) {
  return render(
    <BillsTable plans={plans} feePercent={FEE_PERCENT} specialtyMap={SPECIALTY_MAP} />,
  );
}
const desktop = () => within(screen.getByTestId('bills-desktop'));
const mobile  = () => within(screen.getByTestId('bills-mobile'));

// ══════════════════════════════════════════════════════════════════════════
describe('four columns, and only four', () => {
  it('the desktop header is exactly Patient / Amount / Status / Date', () => {
    renderTable([CASES[0].plan]);
    const headers = desktop().getAllByRole('columnheader').map((th) => th.textContent?.trim());
    // The trailing header is the disclosure affordance, labelled for screen
    // readers only — it carries no data.
    expect(headers).toEqual(['Patient', 'Amount', 'Status', 'Date', 'Details']);
  });

  it('a collapsed row shows four data cells plus the affordance', () => {
    renderTable([CASES[0].plan]);
    const cells = desktop().getAllByRole('cell');
    expect(cells).toHaveLength(5);
  });

  it('the six moved fields are absent until the row is expanded', () => {
    renderTable([CASES[0].plan]);
    // Reference, provider, specialty, fee, net payout, payout status.
    expect(screen.queryByText('INV-b-paid')).toBeNull();
    expect(screen.queryByText(/REF-b-paid/)).toBeNull();
    expect(screen.queryByText('Naledi Dlamini')).toBeNull();
    expect(screen.queryByText('Dentistry')).toBeNull();
    expect(screen.queryByTestId('bill-detail:b-paid')).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('renders all four columns across every real status', () => {
  it.each(CASES)('$label', ({ plan, status }) => {
    renderTable([plan]);
    const d = desktop();

    // WHO — the existing initial-only helper, not a new format.
    expect(d.getByTestId(`bill-patient:${plan.id}`).textContent).toBe('Thabo M.');
    // HOW MUCH
    expect(d.getByTestId(`bill-amount:${plan.id}`).textContent)
      .toBe(formatRand(Number(plan.total_amount)));
    // STATUS — label comes from the shared helper, so this cannot drift.
    expect(d.getByTestId(`bill-status:${status}`).textContent)
      .toContain(billLifecycleChip(status).label);
    // WHEN
    expect(d.getByTestId(`bill-date:${plan.id}`).textContent)
      .toBe(formatDate(plan.created_at));
  });

  it('covers all four labels in the vocabulary and invents none', () => {
    renderTable(CASES.map((c) => c.plan));
    const rendered = new Set(
      desktop().getAllByTestId(/^bill-status:/).map((el) => el.getAttribute('data-status')),
    );
    expect(rendered).toEqual(new Set(['paid', 'sent', 'viewed', 'expired']));
    expect(screen.queryByText('Declined')).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('status is the DOMINANT element, not just present', () => {
  // happy-dom loads no Tailwind stylesheet, so getComputedStyle would report
  // the same empty values for every cell — a computed-style assertion here
  // would be theatre. What IS meaningful is the class contract, ranked on an
  // ordering defined in THIS test rather than read back from the component,
  // so the assertion is an independent judgement and not a tautology.
  const SIZE   = { 'text-xs': 1, 'text-sm': 2, 'text-base': 3 } as const;
  const WEIGHT = { 'font-normal': 1, 'font-medium': 2, 'font-semibold': 3, 'font-bold': 4 } as const;

  const tierOf = (cls: string) => {
    const parts = cls.split(/\s+/);
    const rank = (map: Record<string, number>) =>
      Math.max(0, ...Object.entries(map).filter(([k]) => parts.includes(k)).map(([, v]) => v));
    return { size: rank(SIZE), weight: rank(WEIGHT) };
  };

  it('outranks every other cell on type weight, and ties the largest size', () => {
    renderTable([CASES[0].plan]);
    const d = desktop();
    const status = tierOf(d.getByTestId('bill-status:paid').className);
    const others = ['bill-patient:b-paid', 'bill-amount:b-paid', 'bill-date:b-paid']
      .map((t) => tierOf(d.getByTestId(t).className));

    expect(status.weight).toBeGreaterThan(0);
    for (const o of others) {
      expect(status.weight).toBeGreaterThan(o.weight);
      expect(status.size).toBeGreaterThanOrEqual(o.size);
    }
  });

  it('is the only cell carrying a chip (background + ring + radius)', () => {
    renderTable([CASES[0].plan]);
    const d = desktop();
    const badge = d.getByTestId('bill-status:paid').className;
    expect(badge).toMatch(/rounded-full/);
    expect(badge).toMatch(/ring-1/);
    expect(badge).toMatch(/bg-/);
    for (const t of ['bill-patient:b-paid', 'bill-amount:b-paid', 'bill-date:b-paid']) {
      expect(d.getByTestId(t).className).not.toMatch(/rounded-full|ring-1/);
    }
  });

  it('carries an ICON so colour is never the only signal', () => {
    // A reader who cannot separate green from grey still gets a distinct
    // glyph per state. This is the accessibility half of "dominant".
    renderTable(CASES.map((c) => c.plan));
    const d = desktop();
    const glyphs = (['paid', 'sent', 'viewed', 'expired'] as const).map((s) => {
      // getAll, not get: three of the six cases derive to Expired, so that
      // badge legitimately appears more than once in this render.
      const svg = d.getAllByTestId(`bill-status:${s}`)[0].querySelector('svg');
      expect(svg).not.toBeNull();
      return svg!.innerHTML;
    });
    // ...and the glyph DIFFERS between states, rather than one shared dot.
    expect(new Set(glyphs).size).toBe(4);
  });

  it('the status meaning is reachable as text for assistive tech', () => {
    renderTable([CASES[0].plan]);
    expect(desktop().getByTestId('bill-status:paid').getAttribute('aria-label'))
      .toBe(billLifecycleChip('paid').hint);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('the disclosure surfaces the six moved fields correctly', () => {
  it('expanding a row reveals reference, provider, specialty, fee, net and payout', async () => {
    const user = userEvent.setup();
    const plan = CASES[0].plan;                   // active, payout paid
    renderTable([plan]);

    const toggle = desktop().getByTestId('bill-toggle:b-paid');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    const { fee, net } = calculateFee(Number(plan.total_amount), FEE_PERCENT);
    const detail = desktop().getByTestId('bill-detail:b-paid');

    expect(detail.textContent).toContain('INV-b-paid');
    expect(detail.textContent).toContain('REF-b-paid');
    expect(detail.textContent).toContain('Naledi Dlamini');
    expect(detail.textContent).toContain('Dentistry');
    expect(detail.textContent).toContain(`−${formatRand(fee)}`);
    expect(detail.textContent).toContain(formatRand(net));
    expect(detail.textContent).toContain('Paid out');
  });

  it('collapses again on a second click', async () => {
    const user = userEvent.setup();
    renderTable([CASES[0].plan]);
    const toggle = desktop().getByTestId('bill-toggle:b-paid');
    await user.click(toggle);
    expect(desktop().getByTestId('bill-detail:b-paid')).toBeTruthy();
    await user.click(toggle);
    expect(desktop().queryByTestId('bill-detail:b-paid')).toBeNull();
  });

  it('expanding one row does not collapse another', async () => {
    const user = userEvent.setup();
    renderTable([CASES[0].plan, CASES[1].plan]);
    await user.click(desktop().getByTestId('bill-toggle:b-paid'));
    await user.click(desktop().getByTestId('bill-toggle:b-sent'));
    expect(desktop().getByTestId('bill-detail:b-paid')).toBeTruthy();
    expect(desktop().getByTestId('bill-detail:b-sent')).toBeTruthy();
  });

  it('an unaccepted bill reports the payout leg honestly', async () => {
    const user = userEvent.setup();
    renderTable([CASES[1].plan]);          // pending_acceptance, no payout row
    await user.click(desktop().getByTestId('bill-toggle:b-sent'));
    expect(desktop().getByTestId('bill-detail-payout:b-sent').textContent)
      .toContain('Not yet accepted');
  });

  it('distinguishes a FAILED payout from a queued one', async () => {
    // The ten-column table printed "Pending" for processing AND failed,
    // separating them by colour alone. The detail view names them.
    const user = userEvent.setup();
    const failed = makePlan({
      id: 'b-failed', status: 'active', total_amount: 1200,
      payouts: { net_amount: 1128, status: 'failed' },
    });
    renderTable([failed]);
    await user.click(desktop().getByTestId('bill-toggle:b-failed'));
    expect(desktop().getByTestId('bill-detail-payout:b-failed').textContent).toContain('Failed');
  });

  it('a ROSTER-ONLY practitioner (no login) still shows their name', async () => {
    // The whole point of 0094: this practitioner has no profiles row, so their
    // name comes from the membership's own columns. Before the repoint they
    // could not be attached to a bill at all; a blank here would mean the
    // fallback silently didn't fire.
    const user = userEvent.setup();
    renderTable([makePlan({
      id: 'b-roster', status: 'active', total_amount: 900,
      provider_member_id: 'mem-roster',
      provider_member: {
        id: 'mem-roster', user_id: null,
        provider_first_name: 'Zanele', provider_last_name: 'Mthembu',
        specialty: 'Optometry', profiles: null,
      },
    })]);
    await user.click(desktop().getByTestId('bill-toggle:b-roster'));
    expect(desktop().getByTestId('bill-detail-provider:b-roster').textContent)
      .toContain('Zanele Mthembu');
    expect(desktop().getByTestId('bill-detail-specialty:b-roster').textContent)
      .toContain('Optometry');
  });

  it('a bill with no provider degrades to — rather than breaking', async () => {
    const user = userEvent.setup();
    const noProvider = makePlan({
      id: 'b-noprov', status: 'active', total_amount: 500,
      provider_member_id: null, provider_member: null, practice_reference: null,
    });
    renderTable([noProvider]);
    await user.click(desktop().getByTestId('bill-toggle:b-noprov'));
    expect(desktop().getByTestId('bill-detail-provider:b-noprov').textContent).toContain('—');
    expect(desktop().getByTestId('bill-detail-specialty:b-noprov').textContent).toContain('—');
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('formatting comes from the app-wide helpers, with no new logic', () => {
  it('money renders through formatRand, including the thousands separator', () => {
    renderTable([makePlan({ id: 'b-big', status: 'active', total_amount: 12345.5 })]);
    const cell = desktop().getByTestId('bill-amount:b-big').textContent;
    expect(cell).toBe('R12,345.50');
    expect(cell).toBe(formatRand(12345.5));
  });

  it('dates render through formatDate', () => {
    renderTable([CASES[0].plan]);
    expect(desktop().getByTestId('bill-date:b-paid').textContent)
      .toBe(formatDate('2026-08-11T10:00:00.000Z'));
  });

  it('the fee split comes from calculateFee, not a local percentage', async () => {
    const user = userEvent.setup();
    renderTable([CASES[0].plan]);
    await user.click(desktop().getByTestId('bill-toggle:b-paid'));
    const { fee, net } = calculateFee(2400, FEE_PERCENT);
    expect(desktop().getByTestId('bill-detail-fee:b-paid').textContent).toContain(formatRand(fee));
    expect(desktop().getByTestId('bill-detail-net:b-paid').textContent).toContain(formatRand(net));
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('mobile keeps the same hierarchy and the same information', () => {
  it('the mobile card exposes its own disclosure with the moved fields', async () => {
    const user = userEvent.setup();
    renderTable([CASES[0].plan]);
    const toggle = mobile().getByTestId('bill-toggle-mobile:b-paid');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(mobile().getByTestId('bill-detail:b-paid').textContent).toContain('Naledi Dlamini');
  });

  it('mobile shows the status badge with the same dominance treatment', () => {
    renderTable([CASES[0].plan]);
    const badge = mobile().getByTestId('bill-status:paid');
    expect(badge.className).toMatch(/text-sm font-semibold/);
    expect(badge.className).toMatch(/rounded-full/);
    expect(badge.querySelector('svg')).not.toBeNull();
  });

  it('both breakpoints render the same row, so neither can silently drift', () => {
    // Deliberately unscoped: the CSS-only split means one row yields one
    // badge per breakpoint. If a future edit renders the badge in only one,
    // this catches it.
    renderTable([CASES[0].plan]);
    expect(screen.getAllByTestId('bill-status:paid')).toHaveLength(2);
  });
});
