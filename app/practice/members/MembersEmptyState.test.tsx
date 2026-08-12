import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MembersView from './MembersView';

// ─── Part 4: Admin-staff empty state + the "Last manager" explainer ────────
//
// Reported: the "ADMIN STAFF" heading rendered with nothing underneath, and
// the "Last manager" tag on a provider row had no explanation.
//
// Root cause of the blank section: the empty-state condition was
// `!meAsMember && activeAdmins.length === 0` — it required the viewer NOT to
// be a member of the practice at all (only true for a brand-admin acting on
// a branch). A practice's own manager whose role is 'provider' (a solo
// practitioner — the common case) therefore never saw it.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock('./AddMemberForm', () => ({
  default: () => <div data-testid="add-member-form-stub" />,
}));
vi.mock('./SelfAsProviderCard', () => ({
  default: () => <div data-testid="self-as-provider-stub" />,
}));

type Row = Parameters<typeof MembersView>[0]['members'][number];

function member(over: Partial<Row> & { id: string }): Row {
  return {
    user_id:             over.user_id ?? `user-${over.id}`,
    role:                over.role ?? 'provider',
    active:              over.active ?? true,
    can_manage_practice: over.can_manage_practice ?? false,
    can_create_bills:    over.can_create_bills ?? false,
    profile:             over.profile ?? { first_name: 'Ada', last_name: 'Mokoena', email: 'ada@example.com' },
    // `over` last so callers win; it carries `id`, so no explicit id here.
    ...over,
  } as Row;
}

function renderView(members: Row[], currentUserId: string, isManager = true) {
  render(
    <MembersView
      members={members}
      currentUserId={currentUserId}
      isManager={isManager}
      practiceName="Test Practice"
    />,
  );
}

describe('Admin staff empty state', () => {
  it('THE REPORTED BUG: a provider-role manager viewing their own practice sees an empty state, not a bare heading', () => {
    // Solo practitioner: the only member, role='provider', holds manage
    // rights. Under the old condition meAsMember was truthy, so the message
    // was suppressed and the section rendered completely blank.
    renderView(
      [member({ id: 'm1', user_id: 'me', role: 'provider', can_manage_practice: true })],
      'me',
    );
    expect(screen.getByText('Admin staff')).toBeTruthy();
    expect(screen.getByTestId('admin-staff-empty')).toBeTruthy();
    expect(screen.getByText(/No admin staff added yet/i)).toBeTruthy();
  });

  it('offers a way to add one, reusing the existing add-member flow', () => {
    renderView(
      [member({ id: 'm1', user_id: 'me', role: 'provider', can_manage_practice: true })],
      'me',
    );
    fireEvent.click(screen.getByTestId('admin-staff-empty-add'));
    expect(screen.getByTestId('add-member-form-stub')).toBeTruthy();
  });

  // ─── Part 1: the two add-buttons must be visually distinguishable ──────
  //
  // Both entry points are deliberately kept — the header one is the
  // persistent action, the empty-state one is the call-to-action for
  // someone who just read "No admin staff added yet". They were reported as
  // an accidental duplicate because they were visually IDENTICAL primary
  // buttons stacked close together.
  // The header now carries TWO actions, because adding a practitioner and
  // inviting someone to a dashboard login are genuinely different things: a
  // practitioner needs no email and gets no login, so "+ Add practitioner" is
  // the primary and everyday action, and "+ Invite team member" — the flow
  // this file is about — is the deliberate secondary one. The label moved from
  // "+ Add team member" for exactly that reason: with two actions present,
  // "team member" alone no longer said which.
  it('the primary header action stays primary and the empty-state one is lower-emphasis', () => {
    renderView(
      [member({ id: 'm1', user_id: 'me', role: 'provider', can_manage_practice: true })],
      'me',
    );
    const primary = screen.getByTestId('add-provider-toggle');
    const invite  = screen.getByRole('button', { name: '+ Invite team member' });
    const empty   = screen.getByTestId('admin-staff-empty-add');

    // Three distinct elements.
    expect(primary).not.toBe(invite);
    expect(invite).not.toBe(empty);

    // Primary = the brand gradient; the other two are bordered/white.
    expect(primary.getAttribute('style') ?? '').toMatch(/linear-gradient/);
    expect(empty.getAttribute('style') ?? '').not.toMatch(/linear-gradient/);
    expect(empty.className).toMatch(/border/);
    expect(empty.className).toMatch(/bg-white/);
    expect(empty.className).not.toMatch(/text-white/);

    // Reworded so it reads as part of the empty-state sentence rather than
    // a second copy of the header action. This is the original point of this
    // test and it still holds: the two are never the same words.
    expect(empty.textContent).toBe('Add your first admin staff member');
    expect(empty.textContent).not.toBe(invite.textContent);
  });

  it('both entry points perform the same action', () => {
    renderView(
      [member({ id: 'm1', user_id: 'me', role: 'provider', can_manage_practice: true })],
      'me',
    );
    // Empty-state path.
    fireEvent.click(screen.getByTestId('admin-staff-empty-add'));
    expect(screen.getByTestId('add-member-form-stub')).toBeTruthy();
  });

  it('REGRESSION: with admin staff present only the header button exists — no orphaned empty-state button', () => {
    renderView(
      [
        member({ id: 'm1', user_id: 'me', role: 'provider', can_manage_practice: true }),
        member({ id: 'm2', user_id: 'u2', role: 'admin',
                 profile: { first_name: 'Thabo', last_name: 'Nkosi', email: 'thabo@example.com' } }),
      ],
      'me',
    );
    expect(screen.getByRole('button', { name: '+ Invite team member' })).toBeTruthy();
    expect(screen.queryByTestId('admin-staff-empty-add')).toBeNull();
    expect(screen.queryByText('Add your first admin staff member')).toBeNull();
  });

  it('a non-manager viewer gets the explanation but no add action', () => {
    renderView(
      [member({ id: 'm1', user_id: 'me', role: 'provider' })],
      'me',
      false,
    );
    expect(screen.getByTestId('admin-staff-empty')).toBeTruthy();
    expect(screen.queryByTestId('admin-staff-empty-add')).toBeNull();
  });

  it('REGRESSION: with admin staff present the list renders and no empty state appears', () => {
    renderView(
      [
        member({ id: 'm1', user_id: 'me',  role: 'provider', can_manage_practice: true }),
        member({ id: 'm2', user_id: 'u2',  role: 'admin', profile: { first_name: 'Thabo', last_name: 'Nkosi', email: 'thabo@example.com' } }),
      ],
      'me',
    );
    expect(screen.getByText('Thabo Nkosi')).toBeTruthy();
    expect(screen.queryByTestId('admin-staff-empty')).toBeNull();
  });

  it('REGRESSION: the viewer\'s OWN admin card counts as content (no false empty state)', () => {
    renderView(
      [member({ id: 'm1', user_id: 'me', role: 'admin', can_manage_practice: true })],
      'me',
    );
    expect(screen.queryByTestId('admin-staff-empty')).toBeNull();
  });
});

describe('"Last manager" tag explains the actual rule', () => {
  // The rule in code: this member holds can_manage_practice AND no OTHER
  // *active* member does. Enforced identically server-side in updateMember
  // and disableMember. Note it keys off the capability, not the role.
  const MEMBERS = [
    member({ id: 'me',   user_id: 'me', role: 'admin' }),
    member({ id: 'doc1', user_id: 'u2', role: 'provider', can_manage_practice: true,
             profile: { first_name: 'Ada', last_name: 'Mokoena', email: 'ada@example.com' } }),
  ];

  it('the tag is shown for the sole manager and the Disable action is absent', () => {
    renderView(MEMBERS, 'me');
    expect(screen.getByTestId('last-manager-tag-doc1')).toBeTruthy();
    // canDisable is false whenever isLastManager — the tag stands in for it.
    expect(screen.queryByText('Disable')).toBeNull();
  });

  it('tapping the tag reveals an explanation matching the real condition', () => {
    renderView(MEMBERS, 'me');
    expect(screen.queryByTestId('last-manager-help-doc1')).toBeNull();

    fireEvent.click(screen.getByTestId('last-manager-tag-doc1'));
    const help = screen.getByTestId('last-manager-help-doc1');
    expect(help.textContent).toMatch(/only active member who can manage/i);
    expect(help.textContent).toMatch(/at least one/i);
    expect(help.textContent).toMatch(/rights to someone else/i);
  });

  it('the same explanation is available on hover, via title, for pointer users', () => {
    renderView(MEMBERS, 'me');
    const tag = screen.getByTestId('last-manager-tag-doc1');
    expect(tag.getAttribute('title')).toMatch(/only active member who can manage/i);
    // And exposed to assistive tech rather than being hover-only.
    expect(tag.getAttribute('aria-label')).toMatch(/Last manager\./);
  });

  it('tapping again collapses it', () => {
    renderView(MEMBERS, 'me');
    fireEvent.click(screen.getByTestId('last-manager-tag-doc1'));
    fireEvent.click(screen.getByTestId('last-manager-tag-doc1'));
    expect(screen.queryByTestId('last-manager-help-doc1')).toBeNull();
  });

  it('no tag when a SECOND active manager exists — the rule genuinely no longer binds', () => {
    renderView(
      [
        member({ id: 'me',   user_id: 'me', role: 'admin', can_manage_practice: true }),
        member({ id: 'doc1', user_id: 'u2', role: 'provider', can_manage_practice: true }),
      ],
      'me',
    );
    expect(screen.queryByTestId('last-manager-tag-doc1')).toBeNull();
  });

  it('an INACTIVE second manager does not count — the tag still shows', () => {
    renderView(
      [
        member({ id: 'me',   user_id: 'me', role: 'admin' }),
        member({ id: 'doc1', user_id: 'u2', role: 'provider', can_manage_practice: true }),
        member({ id: 'old',  user_id: 'u3', role: 'admin', can_manage_practice: true, active: false }),
      ],
      'me',
    );
    expect(screen.getByTestId('last-manager-tag-doc1')).toBeTruthy();
  });
});
