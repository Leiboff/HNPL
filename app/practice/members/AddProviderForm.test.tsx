import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AddProviderForm, { type AddProviderDraft } from './AddProviderForm';

// ─── Adding a practitioner, from the manager's side ─────────────────────
//
// The point of the feature is that this is a four-field form with no email in
// it. These tests are mostly about what the manager is NOT asked for.

/** The form's own submit signature, so the success and error mocks share a type. */
type SubmitFn = (draft: AddProviderDraft) => Promise<{ error: string | null }>;

function setup(onSubmit: ReturnType<typeof vi.fn<SubmitFn>> = vi.fn<SubmitFn>(async () => ({ error: null }))) {
  const user = userEvent.setup();
  render(<AddProviderForm onSubmit={onSubmit} onCancel={vi.fn()} />);
  return { user, onSubmit };
}

async function fill(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('First name'), 'Naledi');
  await user.type(screen.getByLabelText('Last name'),  'Khumalo');
  await user.selectOptions(screen.getByLabelText('Specialty'), 'Dentistry');
  await user.type(screen.getByLabelText('HPCSA number'), 'MP0123456');
}

describe('the roster form asks for four things', () => {
  it('name, specialty and HPCSA — and no email field exists', () => {
    setup();
    expect(screen.getByLabelText('First name')).toBeTruthy();
    expect(screen.getByLabelText('Last name')).toBeTruthy();
    expect(screen.getByLabelText('Specialty')).toBeTruthy();
    expect(screen.getByLabelText('HPCSA number')).toBeTruthy();

    // The thing that makes this the login-less path.
    expect(screen.queryByLabelText(/email/i)).toBeNull();
    expect(document.querySelector('input[type="email"]')).toBeNull();
  });

  it('says plainly that no login is created, and that one can be granted later', () => {
    setup();
    const note = screen.getByTestId('add-provider-no-login-note').textContent ?? '';
    expect(note).toMatch(/No email address/i);
    expect(note).toMatch(/don't get a login|don’t get a login/);
    expect(note).toMatch(/later/);
  });

  it('offers the shared specialty list, not a free-text field', () => {
    setup();
    const select = screen.getByLabelText('Specialty') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(select.options.length).toBeGreaterThan(1);
  });

  it('submits exactly the four fields', async () => {
    const { user, onSubmit } = setup();
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Add practitioner' }));

    const expected: AddProviderDraft = {
      firstName: 'Naledi', lastName: 'Khumalo',
      specialty: 'Dentistry', hpcsaNumber: 'MP0123456',
    };
    expect(onSubmit).toHaveBeenCalledWith(expected);
    // No fifth key smuggled in.
    const [draft] = onSubmit.mock.calls[0] ?? [];
    expect(Object.keys(draft ?? {})).toHaveLength(4);
  });
});

describe('the form guards its own inputs', () => {
  it('the submit button is disabled until all four are present', async () => {
    const { user } = setup();
    const submit = screen.getByRole('button', { name: 'Add practitioner' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByLabelText('First name'), 'Naledi');
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    await fill(user);
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });

  it('HPCSA is required here — there is no later chance to collect it', async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText('First name'), 'Naledi');
    await user.type(screen.getByLabelText('Last name'),  'Khumalo');
    await user.selectOptions(screen.getByLabelText('Specialty'), 'Dentistry');
    // Everything but HPCSA.
    expect((screen.getByRole('button', { name: 'Add practitioner' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('surfaces a server error and keeps what was typed', async () => {
    const onSubmit = vi.fn<SubmitFn>(async () => ({
      error: 'Naledi Khumalo is already on this practice\'s roster.',
    }));
    const { user } = setup(onSubmit);
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Add practitioner' }));

    expect(screen.getByTestId('add-provider-error').textContent).toMatch(/already on this practice/);
    // Not cleared — the manager may only need to change the surname.
    expect((screen.getByLabelText('First name') as HTMLInputElement).value).toBe('Naledi');
  });

  it('clears the form after a successful add, ready for the next practitioner', async () => {
    const { user } = setup();
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Add practitioner' }));
    expect((screen.getByLabelText('First name') as HTMLInputElement).value).toBe('');
  });
});
