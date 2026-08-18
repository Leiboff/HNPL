import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { ContactEnquiryResult } from './contactAction';

// ─── Behavioural tests — the contact form component ──────────────────
//
// The action is mocked; this file is about what the USER sees and can do:
// that a double tap cannot send twice, that success and failure are both
// visible, and that a failure never reads as a success.

type Input = Record<string, string>;

const calls: Input[] = [];
/** Set to a manual promise to hold the action open mid-flight. */
let gate: { promise: Promise<ContactEnquiryResult>; resolve: (r: ContactEnquiryResult) => void } | null = null;
let nextResult: ContactEnquiryResult = { ok: true };

vi.mock('./contactAction', () => ({
  submitContactEnquiry: (input: Input) => {
    calls.push(input);
    return gate ? gate.promise : Promise.resolve(nextResult);
  },
}));

import ContactForm from './ContactForm';

function openGate() {
  let resolve!: (r: ContactEnquiryResult) => void;
  const promise = new Promise<ContactEnquiryResult>((r) => { resolve = r; });
  gate = { promise, resolve };
  return gate;
}

/** Fill every field so the client has a complete payload to submit. */
function fill(kind: 'patient' | 'practice' = 'patient') {
  fireEvent.click(screen.getByRole('radio', { name: new RegExp(kind, 'i') }));
  fireEvent.change(screen.getByTestId('contact-form-name'),    { target: { value: 'Thandi Mokoena' } });
  fireEvent.change(screen.getByTestId('contact-form-email'),   { target: { value: 'thandi@example.com' } });
  fireEvent.change(screen.getByTestId('contact-form-phone'),   { target: { value: '0821234567' } });
  fireEvent.change(screen.getByTestId('contact-form-message'), { target: { value: 'A question about my plan.' } });
}

beforeEach(() => {
  calls.length = 0;
  gate = null;
  nextResult = { ok: true };
});

describe('the form renders its fields', () => {
  it('has name, email, contact number, message and a patient/practice choice', () => {
    render(<ContactForm />);
    expect(screen.getByTestId('contact-form-name')).toBeTruthy();
    expect(screen.getByTestId('contact-form-email')).toBeTruthy();
    expect(screen.getByTestId('contact-form-phone')).toBeTruthy();
    expect(screen.getByTestId('contact-form-message')).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('neither patient nor practice is preselected', () => {
    // A wrong default would silently mislabel the enquiry, which is worse
    // than not labelling it. The server rejects an unset value.
    render(<ContactForm />);
    for (const r of screen.getAllByRole('radio')) {
      expect((r as HTMLInputElement).checked).toBe(false);
    }
  });

  it('carries a hidden honeypot that a human never sees', () => {
    render(<ContactForm />);
    const pot = screen.getByTestId('contact-form-honeypot') as HTMLInputElement;
    expect(pot.name).toBe('website');
    expect(pot.tabIndex).toBe(-1);
    // Positioned off-screen rather than display:none — naive bots fill
    // anything present in the DOM.
    expect(pot.getAttribute('style')).toMatch(/-9999px/);
  });

  it('asks the message question in the agreed words', () => {
    render(<ContactForm />);
    expect(screen.getByText('What can we help you with?')).toBeTruthy();
  });

  it('marks the contact number optional, and nothing else', () => {
    render(<ContactForm />);
    expect(screen.getAllByText(/optional/i)).toHaveLength(1);
  });
});

describe('double-submit is prevented', () => {
  it('two taps in the SAME TICK produce ONE action call', async () => {
    const g = openGate();
    render(<ContactForm />);
    fill();

    const form = screen.getByTestId('contact-form');
    // Both dispatched before React can re-render the button into its
    // disabled state. This is the case a 10ms-apart test would miss, and it
    // is why usePendingAction's run() holds a synchronous ref.
    await act(async () => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });

    expect(calls).toHaveLength(1);
    await act(async () => { g.resolve({ ok: true }); });
  });

  it('the submit button is disabled while in flight', async () => {
    const g = openGate();
    render(<ContactForm />);
    fill();

    const btn = screen.getByTestId('contact-form-submit') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);

    await act(async () => { fireEvent.submit(screen.getByTestId('contact-form')); });
    expect(btn.disabled).toBe(true);

    await act(async () => { g.resolve({ ok: true }); });
  });

  it('a third tap after the first settles still cannot double-send the first', async () => {
    const g = openGate();
    render(<ContactForm />);
    fill();
    const form = screen.getByTestId('contact-form');

    await act(async () => {
      fireEvent.submit(form);
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(calls).toHaveLength(1);

    await act(async () => { g.resolve({ ok: true }); });
    // Success replaces the form, so there is nothing left to tap.
    expect(screen.queryByTestId('contact-form')).toBeNull();
  });
});

describe('success is confirmed clearly', () => {
  it('replaces the form with a confirmation', async () => {
    render(<ContactForm />);
    fill();
    await act(async () => { fireEvent.submit(screen.getByTestId('contact-form')); });

    await waitFor(() => expect(screen.getByTestId('contact-form-sent')).toBeTruthy());
    expect(screen.queryByTestId('contact-form')).toBeNull();
    // Announced, not just visually present.
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('offers a way back to send another message', async () => {
    render(<ContactForm />);
    fill();
    await act(async () => { fireEvent.submit(screen.getByTestId('contact-form')); });
    await waitFor(() => expect(screen.getByTestId('contact-form-again')).toBeTruthy());

    fireEvent.click(screen.getByTestId('contact-form-again'));
    await waitFor(() => expect(screen.getByTestId('contact-form')).toBeTruthy());
  });

  it('passes the honeypot value through so the server can see it', async () => {
    render(<ContactForm />);
    fill();
    fireEvent.change(screen.getByTestId('contact-form-honeypot'), { target: { value: 'bot-was-here' } });
    await act(async () => { fireEvent.submit(screen.getByTestId('contact-form')); });
    expect(calls[0].website).toBe('bot-was-here');
  });

  it('sends the chosen kind', async () => {
    render(<ContactForm />);
    fill('practice');
    await act(async () => { fireEvent.submit(screen.getByTestId('contact-form')); });
    expect(calls[0].kind).toBe('practice');
  });
});

describe('failure is honest', () => {
  it('shows the server message and does NOT show a confirmation', async () => {
    nextResult = {
      ok: false,
      error: 'send_failed',
      message: 'We could not send your message just now — nothing was sent. Please email us directly at support@betternow.co.za.',
    };
    render(<ContactForm />);
    fill();
    await act(async () => { fireEvent.submit(screen.getByTestId('contact-form')); });

    const err = await waitFor(() => screen.getByTestId('contact-form-error'));
    expect(err.textContent).toMatch(/nothing was sent/i);
    // The critical property: no success anywhere on screen.
    expect(screen.queryByTestId('contact-form-sent')).toBeNull();
    // And the form is still there, still filled, so nothing is lost.
    expect(screen.getByTestId('contact-form')).toBeTruthy();
    expect((screen.getByTestId('contact-form-message') as HTMLTextAreaElement).value)
      .toBe('A question about my plan.');
  });

  it('the error is announced to assistive tech', async () => {
    nextResult = { ok: false, error: 'invalid', field: 'email', message: 'Please enter an email address we can reply to.' };
    render(<ContactForm />);
    fill();
    await act(async () => { fireEvent.submit(screen.getByTestId('contact-form')); });
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  });

  it('marks the rejected field invalid', async () => {
    nextResult = { ok: false, error: 'invalid', field: 'email', message: 'Please enter an email address we can reply to.' };
    render(<ContactForm />);
    fill();
    await act(async () => { fireEvent.submit(screen.getByTestId('contact-form')); });

    await waitFor(() => {
      expect(screen.getByTestId('contact-form-email').getAttribute('aria-invalid')).toBe('true');
    });
    // Only the named field.
    expect(screen.getByTestId('contact-form-name').getAttribute('aria-invalid')).toBeNull();
  });

  it('a rate-limit refusal is shown as its own message, not as success', async () => {
    nextResult = { ok: false, error: 'rate_limited', message: 'That is a few messages in a short time. Please try again a little later.' };
    render(<ContactForm />);
    fill();
    await act(async () => { fireEvent.submit(screen.getByTestId('contact-form')); });

    const err = await waitFor(() => screen.getByTestId('contact-form-error'));
    expect(err.textContent).toMatch(/short time/i);
    expect(screen.queryByTestId('contact-form-sent')).toBeNull();
  });

  it('the button becomes usable again so a retry is possible', async () => {
    nextResult = { ok: false, error: 'send_failed', message: 'nothing was sent' };
    render(<ContactForm />);
    fill();
    await act(async () => { fireEvent.submit(screen.getByTestId('contact-form')); });

    await waitFor(() => {
      expect((screen.getByTestId('contact-form-submit') as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('a stale error is cleared when the user submits again', async () => {
    nextResult = { ok: false, error: 'invalid', field: 'name', message: 'Please tell us your name.' };
    render(<ContactForm />);
    fill();
    await act(async () => { fireEvent.submit(screen.getByTestId('contact-form')); });
    await waitFor(() => expect(screen.getByTestId('contact-form-error')).toBeTruthy());

    nextResult = { ok: true };
    await act(async () => { fireEvent.submit(screen.getByTestId('contact-form')); });
    await waitFor(() => expect(screen.getByTestId('contact-form-sent')).toBeTruthy());
    expect(screen.queryByTestId('contact-form-error')).toBeNull();
  });
});
