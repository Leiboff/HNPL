import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import BillForm from './bills/new/BillForm';
import CounterSessionForm from './pos/CounterSessionForm';
import { VALID_SA_ID } from '@/lib/testing/saIdFixtures';
import type { CreateBillResult } from './bills/new/actions';
import type { ProviderOption } from './bills/new/page';

// ─── Delivery is a choice; identity is not ───────────────────────────────
//
// Both issuing surfaces now ask the same question in the same order: WHO is
// this bill for (the SA ID, always), then HOW does it reach them (QR by
// default, email as the alternative). This file drives the two forms and
// asserts they behave the same way, because "shared capture" is only true
// if the screens in front of the two different humans agree.
//
// CLIENT-SIDE VALIDATION POSTURE: validated on BOTH, matching the server.
//   The dashboard already validated client-side; the till validated only on
//   the server, which is why its own test suite could type a Luhn-invalid
//   ID for months without anything noticing. With a patient standing at a
//   counter, a mistyped digit is cheapest to catch before the request goes
//   out. The server check is unchanged and remains authoritative — see
//   billIdentityRouting.test.ts, which posts straight past the UI.

vi.mock('./bills/new/BillWaitingPanel', () => ({ default: () => <div /> }));
vi.mock('qrcode', () => ({ default: { toDataURL: async () => 'data:image/png;base64,AAA' } }));

const PROVIDERS: ProviderOption[] = [{ memberId: 'mem-1', name: 'Ada Mokoena' }];

afterEach(cleanup);

function dashboard() {
  // Typed argument: vi.fn(async () => …) infers an EMPTY args tuple, so
  // mock.calls[0][0] fails to typecheck even though it exists at runtime.
  const createBill = vi.fn(async (_data: Record<string, unknown>) => ({ error: null } as CreateBillResult));
  render(
    <BillForm feePercent={5} providers={PROVIDERS} practiceId="practice-1" maximumBillAmount={30000} createBill={createBill as never} />,
  );
  return createBill;
}

function till() {
  const issue = vi.fn(async (_data: Record<string, unknown>) => ({
    error: null, token: 'a'.repeat(64), expiresAt: new Date(Date.now() + 120000).toISOString(), planId: 'plan-1',
  }));
  render(
    <CounterSessionForm
      providers={PROVIDERS}
      maximumBillAmount={30000}
      issueCounterSession={issue as never}
      expireCounterSession={vi.fn(async () => ({ error: null }))}
      getCounterSessionStage={vi.fn(async () => ({ error: null, stage: 'created' as const }))}
      acknowledgeCounterSession={vi.fn(async () => ({ error: null }))}
    />,
  );
  return issue;
}

describe('QR is the default on both surfaces', () => {
  it('the dashboard opens on QR, with no email field asked for', () => {
    dashboard();
    expect(screen.getByTestId('bill-delivery-toggle')).toBeTruthy();
    // The address is not a field until it is the delivery method. Asking
    // for one under QR would be asking for an input we will not use.
    expect(screen.queryByLabelText(/Patient email/i)).toBeNull();
  });

  it('the till opens on QR too, and its button still says so', () => {
    till();
    expect(screen.getByTestId('pos-delivery-toggle')).toBeTruthy();
    expect(screen.queryByTestId('pos-email-input')).toBeNull();
    expect(screen.getByText('Generate QR')).toBeTruthy();
  });
});

describe('email is reachable on both surfaces', () => {
  it('choosing email on the dashboard reveals the address field and sends delivery=email', async () => {
    const createBill = dashboard();
    fireEvent.change(screen.getByTestId('bill-said-input'), { target: { value: VALID_SA_ID } });
    fireEvent.click(screen.getByTestId('delivery-email'));
    fireEvent.change(screen.getByLabelText(/Patient email/i), { target: { value: 'p@example.com' } });
    fireEvent.change(screen.getByLabelText(/Bill amount/i), { target: { value: '1000' } });
    fireEvent.click(screen.getByTestId('submit-bill'));

    await waitFor(() => expect(createBill).toHaveBeenCalledTimes(1));
    expect(createBill.mock.calls[0][0]).toMatchObject({
      delivery: 'email', patientEmail: 'p@example.com', saIdNumber: VALID_SA_ID,
    });
  });

  it('choosing email on the till does the same, and relabels the button', async () => {
    const issue = till();
    fireEvent.click(screen.getByTestId('pos-delivery-email'));
    expect(screen.getByText('Email the bill')).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Bill amount/i), { target: { value: '1000' } });
    fireEvent.change(screen.getByTestId('pos-said-input'), { target: { value: VALID_SA_ID } });
    fireEvent.change(screen.getByTestId('pos-email-input'), { target: { value: 'p@example.com' } });
    fireEvent.submit(screen.getByTestId('pos-entry-form'));

    await waitFor(() => expect(issue).toHaveBeenCalledTimes(1));
    expect(issue.mock.calls[0][0]).toMatchObject({
      delivery: 'email', patientEmail: 'p@example.com', saIdNumber: VALID_SA_ID,
    });
  });

  it('a QR submit sends delivery=qr and no address, on both', async () => {
    const createBill = dashboard();
    fireEvent.change(screen.getByTestId('bill-said-input'), { target: { value: VALID_SA_ID } });
    fireEvent.change(screen.getByLabelText(/Bill amount/i), { target: { value: '1000' } });
    fireEvent.click(screen.getByTestId('submit-bill'));
    await waitFor(() => expect(createBill).toHaveBeenCalledTimes(1));
    expect(createBill.mock.calls[0][0]).toMatchObject({ delivery: 'qr' });
    expect(createBill.mock.calls[0][0].patientEmail).toBeUndefined();

    cleanup();
    const issue = till();
    fireEvent.change(screen.getByLabelText(/Bill amount/i), { target: { value: '1000' } });
    fireEvent.change(screen.getByTestId('pos-said-input'), { target: { value: VALID_SA_ID } });
    fireEvent.submit(screen.getByTestId('pos-entry-form'));
    await waitFor(() => expect(issue).toHaveBeenCalledTimes(1));
    expect(issue.mock.calls[0][0]).toMatchObject({ delivery: 'qr' });
  });
});

describe('the client-side posture is the same on both surfaces', () => {
  it('the dashboard blocks a checksum-invalid ID before any request', async () => {
    const createBill = dashboard();
    fireEvent.change(screen.getByTestId('bill-said-input'), { target: { value: '9001015800086' } });
    fireEvent.change(screen.getByLabelText(/Bill amount/i), { target: { value: '1000' } });
    fireEvent.click(screen.getByTestId('submit-bill'));

    expect(screen.getByTestId('said-error').textContent).toMatch(/valid 13-digit SA ID/i);
    expect(createBill).not.toHaveBeenCalled();
  });

  it('the till blocks the SAME id before any request — it used not to', async () => {
    // This is the gap that let the till's own suite type a Luhn-invalid
    // fixture indefinitely: there was no client-side check at all.
    const issue = till();
    fireEvent.change(screen.getByLabelText(/Bill amount/i), { target: { value: '1000' } });
    fireEvent.change(screen.getByTestId('pos-said-input'), { target: { value: '9001015800086' } });
    fireEvent.submit(screen.getByTestId('pos-entry-form'));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/valid 13-digit SA ID/i));
    expect(issue).not.toHaveBeenCalled();
  });

  it('the dashboard blocks a missing ID', () => {
    const createBill = dashboard();
    fireEvent.change(screen.getByLabelText(/Bill amount/i), { target: { value: '1000' } });
    fireEvent.click(screen.getByTestId('submit-bill'));
    expect(screen.getByTestId('said-error')).toBeTruthy();
    expect(createBill).not.toHaveBeenCalled();
  });

  it('neither surface asks for an email it will not use', () => {
    dashboard();
    expect(screen.queryByLabelText(/Patient email/i)).toBeNull();
    cleanup();
    till();
    expect(screen.queryByTestId('pos-email-input')).toBeNull();
  });
});

describe('the delivery toggle itself needed no schema change', () => {
  it('no migration exists for delivery or the issuance-time binding', () => {
    // plans/applications already carry patient_id, checkout_sessions
    // .sa_id_number already exists and is NOT NULL, and
    // issued_via_device_id was already nullable — which is what lets a
    // dashboard-issued QR record no device. Still true.
    const dir   = resolve(process.cwd(), 'supabase/migrations');
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql'));
    expect(files.filter((f) => /delivery|qr_/i.test(f))).toEqual([]);
  });

  it('EXACTLY ONE migration adds an SA ID to patient_invitations — 0098', () => {
    // This pin used to assert that NO migration did. That changed on
    // purpose: closing the invitation-ID gap needs the column, because the
    // email path validated the practice's ID and then discarded it. The
    // assertion is kept rather than deleted so a SECOND such column, or one
    // slipped in beside a UI change, still fails here.
    const dir   = resolve(process.cwd(), 'supabase/migrations');
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql'));

    const adders = files.filter((f) =>
      /ALTER TABLE\s+patient_invitations[\s\S]{0,120}sa_id_number/i.test(readFileSync(resolve(dir, f), 'utf8')),
    );
    expect(adders).toEqual(['0098_invitation_sa_id_and_completion_window.sql']);
  });
});
