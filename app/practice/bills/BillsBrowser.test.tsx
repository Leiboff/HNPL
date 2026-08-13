import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import BillsBrowser from './BillsBrowser';
import type { PlanSummary } from '../billHelpers';

// ─── The Bills tab's filter + search ──────────────────────────────────────
//
// Two controls, because the Bills tab answers one question: "where is that
// bill". What state is it in, and what was the patient's name or the
// reference I wrote on it.
//
// The table itself is ../BillsTable — the same component the dashboard card
// renders — so the row markup is not tested again here. What IS tested is
// that the filtering agrees with the chip each row displays, since lifecycle
// status is DERIVED (lib/bills/lifecycle.ts) rather than stored, and a filter
// that re-derived it differently would quietly disagree with the list.

const YEAR_AWAY = new Date(Date.now() + 365 * 864e5).toISOString();
const YEAR_AGO  = new Date(Date.now() - 365 * 864e5).toISOString();

function plan(over: Partial<PlanSummary> & { id: string }): PlanSummary {
  return {
    total_amount:       1000,
    status:             'pending_acceptance',
    created_at:         '2026-03-01T10:00:00Z',
    invoice_number:     null,
    practice_reference: null,
    provider_member_id: null,
    patient:            { first_name: 'Nomsa', last_name: 'Dlamini' },
    provider_member:    null,
    payouts:            null,
    invitations:        null,
    ...over,
  };
}

// One plan per lifecycle state, each reaching it the way the real data does.
const SENT = plan({
  id: 'p-sent', invoice_number: 'INV-001', practice_reference: 'FILE-42',
  patient: { first_name: 'Nomsa', last_name: 'Dlamini' },
  invitations: { viewed_at: null, accepted_at: null, expires_at: YEAR_AWAY },
});
const VIEWED = plan({
  id: 'p-viewed', invoice_number: 'INV-002',
  patient: { first_name: 'Thabo', last_name: 'Mokoena' },
  invitations: { viewed_at: '2026-03-02T09:00:00Z', accepted_at: null, expires_at: YEAR_AWAY },
});
const PAID = plan({
  id: 'p-paid', status: 'active', invoice_number: 'INV-003',
  patient: { first_name: 'Ayesha', last_name: 'Patel' },
});
const EXPIRED = plan({
  id: 'p-expired', invoice_number: 'INV-004',
  patient: { first_name: 'Johan', last_name: 'Venter' },
  invitations: { viewed_at: null, accepted_at: null, expires_at: YEAR_AGO },
});

const ALL = [SENT, VIEWED, PAID, EXPIRED];

const renderBrowser = (plans: PlanSummary[] = ALL) =>
  render(<BillsBrowser plans={plans} feePercent={6} specialtyMap={{}} />);

const visibleRowIds = () =>
  screen.getAllByTestId(/^bill-toggle:/).map((el) => el.getAttribute('data-testid')!.split(':')[1]);

// ─── The whole list, unfiltered ───────────────────────────────────────────

describe('with no filters', () => {
  it('renders every bill through the shared table', () => {
    renderBrowser();
    expect(screen.getByTestId('bills-browser')).toBeTruthy();
    // BillsTable's own testids — proof it is the shared component rendering,
    // not a second table built here.
    expect(screen.getByTestId('bills-desktop')).toBeTruthy();
    expect(screen.getByTestId('bills-mobile')).toBeTruthy();
    expect(visibleRowIds().sort()).toEqual(['p-expired', 'p-paid', 'p-sent', 'p-viewed']);
  });

  it('states the total without a "of N" comparison', () => {
    renderBrowser();
    expect(screen.getByTestId('bills-count').textContent).toBe('4 bills');
  });

  it('offers no Clear button until something is filtered', () => {
    renderBrowser();
    expect(screen.queryByTestId('bills-clear')).toBeNull();
  });
});

// ─── Status filter ────────────────────────────────────────────────────────

describe('filtering by status', () => {
  it.each([
    ['sent',    'p-sent'],
    ['viewed',  'p-viewed'],
    ['paid',    'p-paid'],
    ['expired', 'p-expired'],
  ])('%s shows only that bill', (status, id) => {
    renderBrowser();
    fireEvent.change(screen.getByTestId('bills-status-filter'), { target: { value: status } });
    expect(visibleRowIds()).toEqual([id]);
  });

  it('agrees with the chip the row itself renders', () => {
    // The point of deriving status here rather than filtering on a column:
    // the filter and the chip must be the same answer. If they diverged,
    // selecting "Paid" would show a row labelled something else.
    renderBrowser();
    fireEvent.change(screen.getByTestId('bills-status-filter'), { target: { value: 'paid' } });
    expect(screen.getAllByTestId('bill-status:paid').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('bill-status:sent')).toBeNull();
  });

  it('labels each option from the shared lifecycle helper, with a count', () => {
    renderBrowser();
    const opts = Array.from(
      screen.getByTestId('bills-status-filter').querySelectorAll('option'),
    ).map((o) => o.textContent);
    expect(opts).toEqual(['All statuses', 'Sent (1)', 'Viewed (1)', 'Paid (1)', 'Expired (1)']);
  });

  it('narrows the count line', () => {
    renderBrowser();
    fireEvent.change(screen.getByTestId('bills-status-filter'), { target: { value: 'paid' } });
    expect(screen.getByTestId('bills-count').textContent).toBe('1 of 4 bills');
  });
});

// ─── Search ───────────────────────────────────────────────────────────────

describe('searching', () => {
  it('finds a bill by the patient name as the table displays it', () => {
    // patientDisplay renders "Nomsa D." — searching the full surname would
    // find nothing, so the haystack must be the DISPLAYED string.
    renderBrowser();
    fireEvent.change(screen.getByTestId('bills-search'), { target: { value: 'nomsa' } });
    expect(visibleRowIds()).toEqual(['p-sent']);
  });

  it('finds a bill by invoice number', () => {
    renderBrowser();
    fireEvent.change(screen.getByTestId('bills-search'), { target: { value: 'INV-003' } });
    expect(visibleRowIds()).toEqual(['p-paid']);
  });

  it("finds a bill by the practice's OWN reference", () => {
    // The one a practice will actually reach for when reconciling against
    // their own records — it is the string they typed.
    renderBrowser();
    fireEvent.change(screen.getByTestId('bills-search'), { target: { value: 'file-42' } });
    expect(visibleRowIds()).toEqual(['p-sent']);
  });

  it('is case-insensitive and ignores surrounding whitespace', () => {
    renderBrowser();
    fireEvent.change(screen.getByTestId('bills-search'), { target: { value: '  THABO  ' } });
    expect(visibleRowIds()).toEqual(['p-viewed']);
  });

  it('combines with the status filter rather than replacing it', () => {
    renderBrowser();
    fireEvent.change(screen.getByTestId('bills-search'), { target: { value: 'INV-00' } });
    fireEvent.change(screen.getByTestId('bills-status-filter'), { target: { value: 'viewed' } });
    expect(visibleRowIds()).toEqual(['p-viewed']);
  });

  it('clears both at once', () => {
    renderBrowser();
    fireEvent.change(screen.getByTestId('bills-search'), { target: { value: 'nomsa' } });
    fireEvent.change(screen.getByTestId('bills-status-filter'), { target: { value: 'sent' } });
    fireEvent.click(screen.getByTestId('bills-clear'));
    expect(visibleRowIds().sort()).toEqual(['p-expired', 'p-paid', 'p-sent', 'p-viewed']);
    expect(screen.getByTestId('bills-count').textContent).toBe('4 bills');
  });
});

// ─── Two different kinds of nothing ───────────────────────────────────────

describe('empty states', () => {
  it('says "no bills yet" when the practice has none', () => {
    renderBrowser([]);
    expect(screen.getByTestId('bills-empty')).toBeTruthy();
    expect(screen.queryByTestId('bills-no-matches')).toBeNull();
    expect(screen.queryByTestId('bills-desktop')).toBeNull();
  });

  it('says "no matches" when the filters exclude everything', () => {
    // Distinct from the above on purpose: telling a practice with 400 bills
    // that they have none is the kind of thing that generates a support call.
    renderBrowser();
    fireEvent.change(screen.getByTestId('bills-search'), { target: { value: 'zzzz' } });
    expect(screen.getByTestId('bills-no-matches')).toBeTruthy();
    expect(screen.queryByTestId('bills-empty')).toBeNull();
    expect(screen.getByTestId('bills-count').textContent).toBe('0 of 4 bills');
  });

  it('keeps the controls usable in the no-matches state', () => {
    // A dead end with no way back would mean reloading the page.
    renderBrowser();
    fireEvent.change(screen.getByTestId('bills-search'), { target: { value: 'zzzz' } });
    expect(screen.getByTestId('bills-search')).toBeTruthy();
    fireEvent.click(screen.getByTestId('bills-clear'));
    expect(screen.getByTestId('bills-desktop')).toBeTruthy();
  });

  it('uses singular wording for one bill', () => {
    renderBrowser([PAID]);
    expect(screen.getByTestId('bills-count').textContent).toBe('1 bill');
  });
});

// ─── What this deliberately does NOT have ─────────────────────────────────

describe('kept minimal on purpose', () => {
  it('has no date range, provider select, or column sorting', () => {
    // Those live on the dashboard for the chart's sake. Duplicating them here
    // would give the same rows two filter bars with different semantics.
    const { container } = renderBrowser();
    expect(container.querySelectorAll('input[type="date"]').length).toBe(0);
    // Exactly two controls: the search box and the status select.
    expect(container.querySelectorAll('select').length).toBe(1);
    expect(container.querySelectorAll('input').length).toBe(1);
  });
});
