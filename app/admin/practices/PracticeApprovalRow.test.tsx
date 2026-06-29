import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PracticeApprovalRow, { type PracticeRow } from './PracticeApprovalRow';

// ─── Kebab actions menu — status-driven items ────────────────────────────────
//
// The card's actions menu must offer DIFFERENT options per practice
// status. This is purely UI; the server actions still enforce admin
// authorization server-side. We assert the menu surfaces by opening
// it and checking which items are rendered.

function makeRow(overrides: Partial<PracticeRow> = {}): PracticeRow {
  return {
    id:                            'p1',
    name:                          'Test Practice',
    specialty:                     'Dentistry',
    status:                        'pending',
    practice_registration_number:  null,
    hpcsa_number:                  null,
    email:                         'p@example.com',
    phone:                         null,
    address_line1:                 null,
    address_line2:                 null,
    suburb:                        null,
    city:                          'Cape Town',
    practice_province:             null,
    postal_code:                   null,
    bank_name:                     null,
    bank_account_number:           null,
    branch_code:                   null,
    created_at:                    '2026-06-14T00:00:00Z',
    approved_at:                   null,
    approved_by:                   null,
    ...overrides,
  };
}

function renderRow(rowOverrides: Partial<PracticeRow> = {}) {
  const approve = vi.fn(async () => ({ error: null }));
  const suspend = vi.fn(async () => ({ error: null }));
  render(
    <PracticeApprovalRow
      practice={makeRow(rowOverrides)}
      providerCount={0}
      memberHpcsas={[]}
      brand={null}
      approvePractice={approve}
      suspendPractice={suspend}
    />,
  );
  return { approve, suspend };
}

describe('PracticeApprovalRow kebab — status drives menu items', () => {
  it('pending → menu offers "View detail" and "Approve"', () => {
    renderRow({ status: 'pending' });
    fireEvent.click(screen.getByTestId('row-kebab-p1'));
    const menu = screen.getByTestId('row-menu-p1');
    expect(menu.textContent).toMatch(/View detail/);
    expect(menu.textContent).toMatch(/Approve/);
    expect(menu.textContent).not.toMatch(/Suspend/);
    expect(menu.textContent).not.toMatch(/Reactivate/);
  });

  it('approved → menu offers "View detail" and "Suspend" (no Approve)', () => {
    renderRow({ status: 'approved' });
    fireEvent.click(screen.getByTestId('row-kebab-p1'));
    const menu = screen.getByTestId('row-menu-p1');
    expect(menu.textContent).toMatch(/View detail/);
    expect(menu.textContent).toMatch(/Suspend/);
    expect(menu.textContent).not.toMatch(/\bApprove\b/);
    expect(menu.textContent).not.toMatch(/Reactivate/);
  });

  it('suspended → menu offers "View detail" and "Reactivate" (no Suspend)', () => {
    renderRow({ status: 'suspended' });
    fireEvent.click(screen.getByTestId('row-kebab-p1'));
    const menu = screen.getByTestId('row-menu-p1');
    expect(menu.textContent).toMatch(/View detail/);
    expect(menu.textContent).toMatch(/Reactivate/);
    expect(menu.textContent).not.toMatch(/Suspend/);
  });

  it('inactive → kebab is disabled because no status transition applies', () => {
    renderRow({ status: 'inactive' });
    const kebab = screen.getByTestId('row-kebab-p1') as HTMLButtonElement;
    expect(kebab.disabled).toBe(true);
  });

  it('clicking Approve fires the approvePractice action with the row id', async () => {
    const { approve } = renderRow({ status: 'pending' });
    fireEvent.click(screen.getByTestId('row-kebab-p1'));
    fireEvent.click(screen.getByTestId('row-action-approve-p1'));
    // Allow the microtask queue to drain so the server-action wrapper resolves.
    await new Promise((r) => setTimeout(r, 0));
    expect(approve).toHaveBeenCalledWith('p1');
  });

  it('clicking Suspend fires the suspendPractice action with the row id', async () => {
    const { suspend } = renderRow({ status: 'approved' });
    fireEvent.click(screen.getByTestId('row-kebab-p1'));
    fireEvent.click(screen.getByTestId('row-action-suspend-p1'));
    await new Promise((r) => setTimeout(r, 0));
    expect(suspend).toHaveBeenCalledWith('p1');
  });
});

describe('PracticeApprovalRow — links to detail', () => {
  it('row header + "View detail" link both point at /admin/practices/[id]', () => {
    renderRow({ id: 'p1' });
    const detailLinks = screen.getAllByRole('link').filter(
      (a) => a.getAttribute('href') === '/admin/practices/p1',
    );
    // The card body link + the explicit "View detail" link in the action bar.
    expect(detailLinks.length).toBeGreaterThanOrEqual(2);
  });
});
