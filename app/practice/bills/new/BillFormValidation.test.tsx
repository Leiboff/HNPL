import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import BillForm from './BillForm';
import type { CreateBillResult, CreateBillSummary } from './actions';
// ProviderOption is declared by the page (BillForm imports it from there too).
import type { ProviderOption } from './page';
import { VALID_SA_ID } from '@/lib/testing/saIdFixtures';

// The success panel mounts BillWaitingPanel, which opens a Supabase Realtime
// subscription. Stubbed out: this file is about validation feedback and the
// panel's navigation affordances, and its live-status behaviour is covered by
// its own suite.
vi.mock('./BillWaitingPanel', () => ({
  default: () => <div data-testid="bill-waiting-panel-stub" />,
}));

// ─── Bill form: validation feedback (Part 1) + result-screen exits (Part 3) ──
//
// The reported bug: an amount outside the configured range made "Send bill to patient"
// do NOTHING — no message, no field highlight, and (verified in the network
// log) zero requests. Two causes, both fixed and both pinned here:
//
//   1. handleSubmit opened with a bare `if (!validAmount) return;` that set
//      no state at all.
//   2. The submit button was ALSO disabled on the same condition, so the
//      click dispatched no event whatsoever — nothing could even reach (1).
//
// Every assertion reads the rendered DOM, and each invalid case asserts the
// server action was NOT called, which is the testable form of "zero requests
// fired".

const PROVIDERS: ProviderOption[] = [
  { memberId: 'mem-1', name: 'Ada Mokoena' },
];

function setup(
  createBill?: (data: unknown) => Promise<CreateBillResult>,
  maximumBillAmount = 30000,
) {
  const spy = vi.fn(createBill ?? (async () => ({ error: null } as CreateBillResult)));
  render(
    <BillForm
      feePercent={5}
      providers={PROVIDERS}
      practiceId="practice-1"
      maximumBillAmount={maximumBillAmount}
      createBill={spy as never}
    />,
  );
  return {
    createBill: spy,
    email:  () => screen.getByLabelText(/Patient email/i) as HTMLInputElement,
    saId:   () => screen.getByTestId('bill-said-input') as HTMLInputElement,
    amount: () => screen.getByLabelText(/Bill amount/i) as HTMLInputElement,
    submit: () => screen.getByTestId('submit-bill'),
    chooseEmail: () => fireEvent.click(screen.getByTestId('delivery-email')),
  };
}

/**
 * Fill everything the form needs EXCEPT the field under test.
 *
 * Since the delivery toggle landed, the address is only a field when email
 * is the delivery method — QR is the default — so anything about the email
 * has to select it first. The SA ID is required either way: it is the
 * customer key, not a delivery detail.
 */
function fillIdentity(f: ReturnType<typeof setup>, opts: { email?: boolean } = {}) {
  fireEvent.change(f.saId(), { target: { value: VALID_SA_ID } });
  if (opts.email) {
    f.chooseEmail();
    fireEvent.change(f.email(), { target: { value: 'patient@example.com' } });
  }
}

describe('bill amount validation is visible, never a silent no-op', () => {
  it('the submit button is NOT disabled on invalid data — a click must always produce feedback', () => {
    const f = setup();
    fillIdentity(f);
    fireEvent.change(f.amount(), { target: { value: '999999' } });
    // The old form disabled the button here, which is why nothing happened.
    expect((f.submit() as HTMLButtonElement).disabled).toBe(false);
  });

  it.each([
    ['above the maximum',   '30001'],
    ['far above the maximum', '999999'],
    ['below the minimum',   '0.5'],
    ['exactly zero',        '0'],
    ['negative',            '-100'],
  ])('%s (%s) shows an inline error and sends nothing', (_label, value) => {
    const f = setup();
    fillIdentity(f);
    fireEvent.change(f.amount(), { target: { value } });
    fireEvent.click(f.submit());

    const err = screen.getByTestId('amount-error');
    // formatRandLimit uses en-ZA grouping, which is a space (U+00A0), not
    // a comma — \s matches both, so this doesn't hard-code the locale.
    expect(err.textContent).toMatch(/between R1 and R30\s?000/i);
    expect(f.amount().getAttribute('aria-invalid')).toBe('true');
    expect(f.createBill).not.toHaveBeenCalled();
  });

  it('an empty amount reports it as missing rather than out of range', () => {
    const f = setup();
    fillIdentity(f);
    fireEvent.click(f.submit());
    expect(screen.getByTestId('amount-error').textContent).toMatch(/enter a bill amount/i);
    expect(f.createBill).not.toHaveBeenCalled();
  });

  it('uses an admin-configured maximum below the database ceiling', () => {
    const f = setup(undefined, 12000);
    fillIdentity(f);
    fireEvent.change(f.amount(), { target: { value: '12000.01' } });
    fireEvent.click(f.submit());

    expect(screen.getByTestId('amount-error').textContent)
      .toMatch(/between R1 and R12\s?000/i);
    expect(f.amount().max).toBe('12000');
    expect(f.createBill).not.toHaveBeenCalled();
  });

  it('the amount field itself gets a visual error state, not just gray helper text', () => {
    const f = setup();
    fillIdentity(f);
    // Before submitting: the neutral hint, no error styling.
    expect(f.amount().className).toMatch(/border-gray-300/);
    expect(screen.getByText(/Between R1 and R30\s?000/i)).toBeTruthy();

    fireEvent.change(f.amount(), { target: { value: '60000' } });
    fireEvent.click(f.submit());

    expect(f.amount().className).toMatch(/border-red-500/);
  });

  it('editing the amount clears the error so the field stops looking broken mid-typing', () => {
    const f = setup();
    fillIdentity(f);
    fireEvent.change(f.amount(), { target: { value: '60000' } });
    fireEvent.click(f.submit());
    expect(screen.queryByTestId('amount-error')).toBeTruthy();

    fireEvent.change(f.amount(), { target: { value: '600' } });
    expect(screen.queryByTestId('amount-error')).toBeNull();
  });

  it('ADVERSARIAL: rapid repeated clicks on invalid data show the error once, never stacked', () => {
    const f = setup();
    fillIdentity(f);
    fireEvent.change(f.amount(), { target: { value: '60000' } });

    for (let i = 0; i < 6; i++) fireEvent.click(f.submit());

    // Exactly one error node for the field, and one general banner.
    expect(screen.getAllByTestId('amount-error')).toHaveLength(1);
    expect(screen.getAllByText(/fix the highlighted fields/i)).toHaveLength(1);
    expect(f.createBill).not.toHaveBeenCalled();
  });
});

describe('email validation has the same visible treatment (no silent gap)', () => {
  it('an empty email is reported inline and blocks submission', () => {
    const f = setup();
    fillIdentity(f);
    f.chooseEmail();
    fireEvent.change(f.amount(), { target: { value: '600' } });
    fireEvent.click(f.submit());
    expect(screen.getByTestId('email-error').textContent).toMatch(/enter the patient/i);
    expect(f.createBill).not.toHaveBeenCalled();
  });

  it('a malformed email is reported inline and blocks submission', () => {
    const f = setup();
    fillIdentity(f);
    f.chooseEmail();
    fireEvent.change(f.email(), { target: { value: 'not-an-email' } });
    fireEvent.change(f.amount(), { target: { value: '600' } });
    fireEvent.click(f.submit());
    expect(screen.getByTestId('email-error').textContent).toMatch(/valid email address/i);
    expect(f.email().getAttribute('aria-invalid')).toBe('true');
    expect(f.createBill).not.toHaveBeenCalled();
  });
});

describe('valid input still submits (regression) and the preview is untouched', () => {
  it('shows the payout preview as soon as the amount is valid', () => {
    const f = setup();
    fireEvent.change(f.amount(), { target: { value: '1000' } });
    expect(screen.getByText(/Payout preview/i)).toBeTruthy();
    expect(screen.getByText(/Net payout to you/i)).toBeTruthy();
  });

  it('submits the trimmed email and parsed amount through to createBill', async () => {
    const f = setup();
    fillIdentity(f);
    f.chooseEmail();
    fireEvent.change(f.email(), { target: { value: '  patient@example.com  ' } });
    fireEvent.change(f.amount(), { target: { value: '1000' } });
    fireEvent.click(f.submit());

    await waitFor(() => expect(f.createBill).toHaveBeenCalledTimes(1));
    expect(f.createBill.mock.calls[0][0]).toMatchObject({
      patientEmail: 'patient@example.com',
      saIdNumber:   VALID_SA_ID,
      delivery:     'email',
      billAmount:   1000,
      providerMemberId: 'mem-1',
      practiceId:   'practice-1',
    });
  });
});

// ─── Part 3: a way back to the dashboard from the result screen ────────────

const BASE_SUMMARY: CreateBillSummary = {
  gross: 1000, fee: 50, net: 950,
  patientName: 'patient@example.com',
  invoiceNumber: 'INV-0001',
  planId: 'plan-1',
};

function renderResult(summary: CreateBillSummary) {
  const createBill = vi.fn(async () => ({ error: null, summary } as CreateBillResult));
  render(
    <BillForm feePercent={5} providers={PROVIDERS} practiceId="practice-1" maximumBillAmount={30000} createBill={createBill as never} />,
  );
  fireEvent.change(screen.getByTestId('bill-said-input'), { target: { value: VALID_SA_ID } });
  fireEvent.click(screen.getByTestId('delivery-email'));
  fireEvent.change(screen.getByLabelText(/Patient email/i), { target: { value: 'patient@example.com' } });
  fireEvent.change(screen.getByLabelText(/Bill amount/i), { target: { value: '1000' } });
  fireEvent.click(screen.getByTestId('submit-bill'));
  return waitFor(() => screen.getByTestId('back-to-dashboard'));
}

describe('bill result screen offers a one-click route back to the dashboard', () => {
  it('SUCCESS variant: back-to-dashboard is present and practice-scoped', async () => {
    await renderResult({ ...BASE_SUMMARY, invitation: {
      email: 'patient@example.com', expiresAt: '2030-01-01T00:00:00Z',
      invitationId: 'inv-1', emailDelivery: { sent: true, to: 'patient@example.com' },
    } });
    expect(screen.getByTestId('back-to-dashboard').getAttribute('href')).toBe('/practice?practiceId=practice-1');
    // The existing action still works.
    expect(screen.getByTestId('create-another-bill')).toBeTruthy();
  });

  it('EMAIL-FAILURE variant: back-to-dashboard is present there too', async () => {
    await renderResult({ ...BASE_SUMMARY, invitation: {
      email: 'patient@example.com', expiresAt: '2030-01-01T00:00:00Z',
      invitationId: 'inv-1',
      emailDelivery: { sent: false, to: 'patient@example.com', error: 'We couldn\'t send this bill by email. Please check the address and try again.' },
    } });
    expect(screen.getByTestId('back-to-dashboard').getAttribute('href')).toBe('/practice?practiceId=practice-1');
    expect(screen.getByTestId('create-another-bill')).toBeTruthy();
  });

  it('"Create another bill" returns to an empty form with no leftover errors', async () => {
    await renderResult(BASE_SUMMARY);
    fireEvent.click(screen.getByTestId('create-another-bill'));
    await waitFor(() => expect(screen.getByTestId('submit-bill')).toBeTruthy());
    expect((screen.getByLabelText(/Bill amount/i) as HTMLInputElement).value).toBe('');
    expect(screen.queryByTestId('amount-error')).toBeNull();
    expect(screen.queryByText(/fix the highlighted fields/i)).toBeNull();
  });
});

// ─── Part 2 (client half): the failure callout shows plain language only ───

describe('email-failure callout renders plain language and no raw provider text', () => {
  it('keeps the reference, payout figures and re-send guidance, with zero provider/JSON leakage', async () => {
    await renderResult({ ...BASE_SUMMARY, invitation: {
      email: 'patient@example.com', expiresAt: '2030-01-01T00:00:00Z',
      invitationId: 'inv-1',
      emailDelivery: { sent: false, to: 'patient@example.com', error: 'We couldn\'t send this bill by email. Please check the address and try again.' },
    } });

    const screenText = document.body.textContent ?? '';
    // The GOOD parts of this screen survive.
    expect(screenText).toContain('INV-0001');           // bill reference
    expect(screenText).toMatch(/R1,000\.00/);            // gross
    expect(screenText).toMatch(/R950\.00/);              // net to practice
    expect(screenText).toMatch(/check the address and re-send/i);

    // ADVERSARIAL: no raw provider error anywhere in the rendered DOM,
    // including any title/tooltip attribute or collapsed details section.
    expect(screenText).not.toMatch(/Resend/i);
    expect(screenText).not.toMatch(/statusCode|validation_error/i);
    expect(document.body.innerHTML).not.toMatch(/Resend \d|statusCode/i);
  });
});
