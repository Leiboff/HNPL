import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import PracticeSetupChecklist from './PracticeSetupChecklist';
import {
  buildSetupChecklist,
  type SetupChecklistFacts,
  type SetupChecklistAuthority,
} from '@/lib/practice/setupChecklist';

// ─── Tests — the checklist card ───────────────────────────────────────────
//
// The derivation is tested in lib/practice/setupChecklist.test.ts. What is
// tested HERE is what a practice owner actually gets on the screen:
//   • the card is ABSENT when setup is finished — not collapsed, not a stub
//   • the outstanding items carry the right link, with the practice scoped on
//   • exactly ONE action is emphasised, so there is one obvious next thing
//   • an item the viewer cannot action says who to ask, and offers no link
//
// Built through the real buildSetupChecklist rather than a hand-written
// checklist object, so a change to the derivation cannot leave these passing
// against a shape the product no longer produces.

const NOTHING: SetupChecklistFacts = {
  status:                'pending',
  phone:                 null,
  addressLine1:          null,
  latitude:              null,
  longitude:             null,
  bankingResolved:       false,
  activeProviderCount:   0,
  activeTillDeviceCount: 0,
  hasTillPin:            false,
};

const DONE: SetupChecklistFacts = {
  status:                'approved',
  phone:                 '011 555 0100',
  addressLine1:          '12 Rivonia Road, Sandton',
  latitude:              -26.1076,
  longitude:             28.0567,
  bankingResolved:       true,
  activeProviderCount:   1,
  activeTillDeviceCount: 1,
  hasTillPin:            true,
};

const FULL_RIGHTS: SetupChecklistAuthority = {
  canEditDetails: true, canManageTeam: true, canManageTill: true,
};

function renderCard(
  over: Partial<SetupChecklistFacts> = {},
  auth: SetupChecklistAuthority = FULL_RIGHTS,
) {
  const checklist = buildSetupChecklist({ ...NOTHING, ...over }, auth);
  return render(<PracticeSetupChecklist checklist={checklist} practiceId="prac-1" />);
}

// ─── Brand-new practice ───────────────────────────────────────────────────

describe('a brand-new practice', () => {
  it('renders the card with all four items and 0 of 4', () => {
    renderCard();
    expect(screen.getByTestId('practice-setup-checklist')).toBeTruthy();
    expect(screen.getByTestId('setup-progress').textContent).toBe('0 of 4 done');
    for (const key of ['banking', 'provider', 'details', 'till']) {
      expect(screen.getByTestId(`setup-item:${key}`)).toBeTruthy();
      expect(screen.getByTestId(`setup-item:${key}`).getAttribute('data-state')).toBe('todo');
    }
  });

  it('links each item to the exact screen, carrying the practice id', () => {
    renderCard();
    const href = (key: string) =>
      screen.getByTestId(`setup-item-action:${key}`).getAttribute('href');

    expect(href('banking')).toBe('/practice/details?practiceId=prac-1#banking');
    expect(href('provider')).toBe('/practice/members?practiceId=prac-1');
    expect(href('details')).toBe('/practice/details?practiceId=prac-1');
    expect(href('till')).toBe('/practice/pos/devices?practiceId=prac-1');
  });

  it('emphasises exactly ONE action — the first outstanding item', () => {
    // Four equally-loud buttons is the pile of sidebar links again. The
    // emphasised one is the answer to "what do I do next".
    renderCard();
    const filled = ['banking', 'provider', 'details', 'till'].filter((k) =>
      (screen.getByTestId(`setup-item-action:${k}`).getAttribute('class') ?? '')
        .includes('text-white'),
    );
    expect(filled).toEqual(['banking']);
  });

  it('tells the practice WHY each outstanding item matters', () => {
    renderCard();
    expect(screen.getByTestId('setup-item-why:banking').textContent)
      .toMatch(/so we can pay you/i);
    expect(screen.getByTestId('setup-item-why:provider').textContent)
      .toMatch(/who treated the patient/i);
    expect(screen.getByTestId('setup-item-why:details').textContent)
      .toMatch(/patients can find you/i);
    expect(screen.getByTestId('setup-item-why:till').textContent)
      .toMatch(/without borrowing your login/i);
  });

  it('says the practice is still being checked over, without making it a task', () => {
    renderCard();
    expect(screen.getByTestId('setup-awaiting-approval').textContent)
      .toMatch(/one working day/i);
    // It is a statement, not a fifth item.
    expect(screen.getByTestId('setup-progress').textContent).toBe('0 of 4 done');
  });

  it('does not mention approval once the practice is approved', () => {
    renderCard({ status: 'approved' });
    expect(screen.queryByTestId('setup-awaiting-approval')).toBeNull();
  });
});

// ─── Partially complete ───────────────────────────────────────────────────

describe('partially complete — banking and details done', () => {
  const partial = {
    bankingResolved: true,
    phone:           '021 555 0199',
    addressLine1:    '4 Long Street, Cape Town',
    latitude:        -33.92,
    longitude:       18.42,
  };

  it('marks the done ones done and counts 2 of 4', () => {
    renderCard(partial);
    expect(screen.getByTestId('setup-progress').textContent).toBe('2 of 4 done');
    expect(screen.getByTestId('setup-item:banking').getAttribute('data-state')).toBe('done');
    expect(screen.getByTestId('setup-item:details').getAttribute('data-state')).toBe('done');
    expect(screen.getByTestId('setup-item:provider').getAttribute('data-state')).toBe('todo');
    expect(screen.getByTestId('setup-item:till').getAttribute('data-state')).toBe('todo');
  });

  it('offers no action link on an item that is already done', () => {
    renderCard(partial);
    expect(screen.queryByTestId('setup-item-action:banking')).toBeNull();
    expect(screen.queryByTestId('setup-item-action:details')).toBeNull();
    expect(screen.getByTestId('setup-item-action:provider')).toBeTruthy();
    expect(screen.getByTestId('setup-item-action:till')).toBeTruthy();
  });

  it('moves the emphasis to the first thing still outstanding', () => {
    renderCard(partial);
    const cls = (k: string) =>
      screen.getByTestId(`setup-item-action:${k}`).getAttribute('class') ?? '';
    expect(cls('provider')).toContain('text-white');
    expect(cls('till')).not.toContain('text-white');
  });

  it('marks done items with a shape as well as a colour', () => {
    // Green-vs-grey alone disappears for the commonest colour blindness, and
    // "which of these is finished" is the one thing this card must convey.
    renderCard(partial);
    expect(screen.getByTestId('setup-item-mark-done:banking')).toBeTruthy();
    expect(screen.getByTestId('setup-item-mark-todo:provider')).toBeTruthy();
  });

  it('stops restating the reason once an item is ticked', () => {
    renderCard(partial);
    expect(screen.queryByTestId('setup-item-why:banking')).toBeNull();
    expect(screen.getByTestId('setup-item-why:provider')).toBeTruthy();
  });
});

// ─── The disappearing act ─────────────────────────────────────────────────

describe('fully complete', () => {
  it('renders NOTHING AT ALL — no card, no stub, no heading', () => {
    const { container } = renderCard(DONE);
    expect(screen.queryByTestId('practice-setup-checklist')).toBeNull();
    expect(screen.queryByTestId('setup-progress')).toBeNull();
    // Not merely hidden or collapsed — the component emits no DOM whatsoever.
    expect(container.innerHTML).toBe('');
    expect(screen.queryByText(/finish setting up/i)).toBeNull();
  });

  it('stays absent even while approval is pending', () => {
    const { container } = renderCard({ ...DONE, status: 'pending' });
    expect(container.innerHTML).toBe('');
  });

  it('re-appears if a completed thing is undone — a revoked till device', () => {
    // The behaviour a stored completion flag could not produce.
    const { container } = renderCard({ ...DONE, activeTillDeviceCount: 0 });
    expect(container.innerHTML).not.toBe('');
    expect(screen.getByTestId('setup-progress').textContent).toBe('3 of 4 done');
    expect(screen.getByTestId('setup-item:till').getAttribute('data-state')).toBe('todo');
  });
});

// ─── Half-done till ──────────────────────────────────────────────────────

describe('the till item', () => {
  it('names the missing half when the device is registered but has no PIN', () => {
    renderCard({ activeTillDeviceCount: 1, hasTillPin: false });
    expect(screen.getByTestId('setup-item-hint:till').textContent).toMatch(/needs a PIN/i);
    expect(screen.getByTestId('setup-item:till').getAttribute('data-state')).toBe('todo');
  });

  it('names the missing half when the PIN is set but no device is registered', () => {
    renderCard({ activeTillDeviceCount: 0, hasTillPin: true });
    expect(screen.getByTestId('setup-item-hint:till').textContent)
      .toMatch(/register the computer/i);
  });
});

// ─── Details hint ────────────────────────────────────────────────────────

describe('the address item', () => {
  it('explains when the address exists but could not be placed on the map', () => {
    renderCard({ phone: '031 555 0123', addressLine1: '9 Florida Road', latitude: null });
    expect(screen.getByTestId('setup-item-hint:details').textContent)
      .toMatch(/couldn’t find your address on the map/i);
  });
});

// ─── Authority ───────────────────────────────────────────────────────────

describe('an item the viewer cannot action', () => {
  it('offers no link and names who to ask', () => {
    renderCard({}, { ...FULL_RIGHTS, canEditDetails: false });

    expect(screen.queryByTestId('setup-item-action:banking')).toBeNull();
    expect(screen.getByTestId('setup-item-ask-manager:banking').textContent)
      .toMatch(/ask whoever manages your practice/i);

    // The items they CAN action are untouched.
    expect(screen.getByTestId('setup-item-action:provider')).toBeTruthy();
  });

  it('still counts the item — being unable to do it does not make it done', () => {
    renderCard({}, { canEditDetails: false, canManageTeam: false, canManageTill: false });
    expect(screen.getByTestId('setup-progress').textContent).toBe('0 of 4 done');
    expect(screen.getByTestId('practice-setup-checklist')).toBeTruthy();
  });

  it('emphasises nothing when there is nothing the viewer can click', () => {
    renderCard({}, { canEditDetails: false, canManageTeam: false, canManageTill: false });
    for (const k of ['banking', 'provider', 'details', 'till']) {
      expect(screen.queryByTestId(`setup-item-action:${k}`)).toBeNull();
    }
  });
});
