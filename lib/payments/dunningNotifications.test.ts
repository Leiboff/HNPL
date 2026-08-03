import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DUNNING_FEE_CENTS } from './dunning';

// ─── Tests — dunning notifications NEVER throw ──────────────────────────────
//
// The cron + webhook + self-settle action all rely on these functions
// being safe to await without try/catch. The brief: "All sends use the
// existing bounded-fetch + try/catch senders; a notification failure
// must never block or crash the cron or the settle action (log and
// continue)."
//
// Tests:
//   • each helper resolves to undefined even when the sender throws
//   • each helper resolves to undefined when the recipient lookup
//     returns nothing (race with row deletion / missing patient)
//   • Day-0 SMS fires only when consecutiveFailedAttemptsBefore === 0
//   • non-Day-0 SMS does NOT fire even with a phone on file
//   • SMS body contains no http:// or https:// (anti-smishing)

const sendEmailSpy = vi.fn();
const sendSmsSpy   = vi.fn();

vi.mock('@/lib/email/resend', () => ({
  sendEmail: (...args: unknown[]) => sendEmailSpy(...args),
}));
vi.mock('@/lib/sms/smsportal', () => ({
  sendSms: (...args: unknown[]) => sendSmsSpy(...args),
}));

import {
  notifyAttemptFailed,
  notifyRecoverySucceeded,
  notifyDefaulted,
} from './dunningNotifications';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeSvcReturning(payment: any, practice: { name: string } | null) {
  return {
    from(table: string) {
      const builder = {
        select() { return builder; },
        eq() { return builder; },
        maybeSingle: async () => {
          if (table === 'payments')  return { data: payment };
          if (table === 'practices') return { data: practice };
          return { data: null };
        },
      };
      return builder;
    },
  };
}

beforeEach(() => {
  sendEmailSpy.mockReset();
  sendSmsSpy.mockReset();
  sendEmailSpy.mockResolvedValue({ ok: true, id: 'em_1' });
  sendSmsSpy.mockResolvedValue({ ok: true });
});

describe('notifyAttemptFailed', () => {
  const samplePayment = {
    id: 'p1',
    plan_id: 'plan-1',
    patient_id: 'u1',
    plans:   { id: 'plan-1', total_amount: 1000, practice_id: 'practice-1' },
    patient: { email: 'u@example.com', first_name: 'Sam', phone: '+27821234567' },
  };

  it('sends an email always', async () => {
    const svc = makeSvcReturning(samplePayment, { name: 'TestPractice' });
    await notifyAttemptFailed(svc, {
      paymentId: 'p1',
      consecutiveFailedAttemptsBefore: 0,
      feeAppliedCents: 0,
      dunningFeesCentsAfter: 0,
      attemptedAmountCents: 25_000,
      nextAttemptDate: '2026-06-16',
    });
    expect(sendEmailSpy).toHaveBeenCalledTimes(1);
    const [arg] = sendEmailSpy.mock.calls[0] as [{ to: string; subject: string; html: string }];
    expect(arg.to).toBe('u@example.com');
    expect(arg.subject).toMatch(/payment didn't go through/i);
  });

  it('Day-0 (consecutiveFailedAttemptsBefore=0) fires SMS too', async () => {
    const svc = makeSvcReturning(samplePayment, { name: 'TestPractice' });
    await notifyAttemptFailed(svc, {
      paymentId: 'p1',
      consecutiveFailedAttemptsBefore: 0,
      feeAppliedCents: 0,
      dunningFeesCentsAfter: 0,
      attemptedAmountCents: 25_000,
      nextAttemptDate: '2026-06-16',
    });
    expect(sendSmsSpy).toHaveBeenCalledTimes(1);
    const [, body] = sendSmsSpy.mock.calls[0] as [string, string];
    // Anti-smishing: SMS body must NOT contain a URL.
    expect(body).not.toMatch(/https?:\/\//);
  });

  it('non-Day-0 (counter > 0) does NOT fire SMS', async () => {
    const svc = makeSvcReturning(samplePayment, { name: 'TestPractice' });
    await notifyAttemptFailed(svc, {
      paymentId: 'p1',
      consecutiveFailedAttemptsBefore: 1, // second-of-pair fail
      feeAppliedCents: DUNNING_FEE_CENTS,
      dunningFeesCentsAfter: DUNNING_FEE_CENTS,
      attemptedAmountCents: 25_000,
      nextAttemptDate: '2026-06-22',
    });
    expect(sendSmsSpy).not.toHaveBeenCalled();
  });

  it('resolves cleanly when the sender throws (never crashes the webhook)', async () => {
    sendEmailSpy.mockRejectedValue(new Error('Resend down'));
    const svc = makeSvcReturning(samplePayment, { name: 'TestPractice' });
    await expect(notifyAttemptFailed(svc, {
      paymentId: 'p1',
      consecutiveFailedAttemptsBefore: 0,
      feeAppliedCents: 0,
      dunningFeesCentsAfter: 0,
      attemptedAmountCents: 25_000,
      nextAttemptDate: null,
    })).resolves.toBeUndefined();
  });

  it('resolves cleanly when the patient lookup returns nothing', async () => {
    const svc = makeSvcReturning(null, null);
    await expect(notifyAttemptFailed(svc, {
      paymentId: 'p-missing',
      consecutiveFailedAttemptsBefore: 0,
      feeAppliedCents: 0,
      dunningFeesCentsAfter: 0,
      attemptedAmountCents: 25_000,
      nextAttemptDate: null,
    })).resolves.toBeUndefined();
    expect(sendEmailSpy).not.toHaveBeenCalled();
    expect(sendSmsSpy).not.toHaveBeenCalled();
  });

  it('mentions the fee amount in the subject when a fee was applied this attempt', async () => {
    const svc = makeSvcReturning(samplePayment, { name: 'TestPractice' });
    await notifyAttemptFailed(svc, {
      paymentId: 'p1',
      consecutiveFailedAttemptsBefore: 1,
      feeAppliedCents: DUNNING_FEE_CENTS,
      dunningFeesCentsAfter: DUNNING_FEE_CENTS,
      attemptedAmountCents: 25_000,
      nextAttemptDate: '2026-06-22',
    });
    const [arg] = sendEmailSpy.mock.calls[0] as [{ subject: string; html: string }];
    expect(arg.subject).toMatch(/R115\.00/);
    expect(arg.html).toMatch(/default fee was added/i);
  });
});

describe('notifyRecoverySucceeded', () => {
  const payment = {
    id: 'p2',
    plan_id: 'plan-1',
    patient_id: 'u1',
    plans:   { id: 'plan-1', total_amount: 1000, practice_id: 'practice-1' },
    patient: { email: 'u@example.com', first_name: 'Sam', phone: null },
  };

  it('sends a recovery-success email', async () => {
    const svc = makeSvcReturning(payment, { name: 'TestPractice' });
    await notifyRecoverySucceeded(svc, {
      paymentId: 'p2',
      collectedAmountCents: 35_000,
      viaSelfSettle: false,
    });
    expect(sendEmailSpy).toHaveBeenCalledTimes(1);
    expect(sendSmsSpy).not.toHaveBeenCalled();
  });

  it('uses self-settle phrasing when viaSelfSettle:true', async () => {
    const svc = makeSvcReturning(payment, { name: 'TestPractice' });
    await notifyRecoverySucceeded(svc, {
      paymentId: 'p2',
      collectedAmountCents: 35_000,
      viaSelfSettle: true,
    });
    const [arg] = sendEmailSpy.mock.calls[0] as [{ subject: string; html: string }];
    expect(arg.subject).toMatch(/received/i);
  });

  it('never throws on a sender error', async () => {
    sendEmailSpy.mockRejectedValue(new Error('boom'));
    const svc = makeSvcReturning(payment, { name: 'TestPractice' });
    await expect(notifyRecoverySucceeded(svc, {
      paymentId: 'p2', collectedAmountCents: 35_000, viaSelfSettle: false,
    })).resolves.toBeUndefined();
  });
});

describe('notifyDefaulted', () => {
  const payment = {
    id: 'p3',
    plan_id: 'plan-1',
    patient_id: 'u1',
    plans:   { id: 'plan-1', total_amount: 1000, practice_id: 'practice-1' },
    patient: { email: 'u@example.com', first_name: 'Sam', phone: null },
  };

  it('sends a defaulted-instalment email mentioning outstanding balance', async () => {
    const svc = makeSvcReturning(payment, { name: 'TestPractice' });
    await notifyDefaulted(svc, { paymentId: 'p3', outstandingAmountCents: 55_000 });
    expect(sendEmailSpy).toHaveBeenCalledTimes(1);
    const [arg] = sendEmailSpy.mock.calls[0] as [{ html: string }];
    expect(arg.html).toMatch(/R550\.00/);
  });

  it('never throws on a sender error', async () => {
    sendEmailSpy.mockRejectedValue(new Error('boom'));
    const svc = makeSvcReturning(payment, { name: 'TestPractice' });
    await expect(notifyDefaulted(svc, {
      paymentId: 'p3', outstandingAmountCents: 55_000,
    })).resolves.toBeUndefined();
  });
});
