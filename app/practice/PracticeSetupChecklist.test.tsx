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
//   • the card is ABSENT when the required items are finished — not collapsed,
//     not a stub, and regardless of whether a till was ever set up
//   • the outstanding items carry the right link, with the practice scoped on
//   • exactly ONE action is emphasised, so there is one obvious next thing
//   • the till nudge is visibly and structurally NOT one of the required rows
//   • an item the viewer cannot action says who to ask, and offers no link
//
// Built through the real buildSetupChecklist rather than a hand-written
// checklist object, so a change to the derivation cannot leave these passing
// against a shape the product no longer produces.

const NOTHING: SetupChecklistFacts = {
  phone:                 null,
  addressLine1:          null,
  latitude:              null,
  longitude:             null,
  bankingResolved:       false,
  hasActiveProvider:   false,
  hasActiveTillDevice: false,
  hasTillPin:            false,
};

/** The three REQUIRED things done, and no till — the card must still vanish. */
const REQUIRED_DONE: SetupChecklistFacts = {
  phone:                 '011 555 0100',
  addressLine1:          '12 Rivonia Road, Sandton',
  latitude:              -26.1076,
  longitude:             28.0567,
  bankingResolved:       true,
  hasActiveProvider:   true,
  hasActiveTillDevice: false,
  hasTillPin:            false,
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
  it('renders the card with three required items and 0 of 3', () => {
    renderCard();
    expect(screen.getByTestId('practice-setup-checklist')).toBeTruthy();
    expect(screen.getByTestId('setup-progress').textContent).toBe('0 of 3 done');
    for (const key of ['banking', 'provider', 'details']) {
      expect(screen.getByTestId(`setup-item:${key}`)).toBeTruthy();
      expect(screen.getByTestId(`setup-item:${key}`).getAttribute('data-state')).toBe('todo');
    }
  });

  it('has no till ROW — the till is not one of the things being counted', () => {
    renderCard();
    expect(screen.queryByTestId('setup-item:till')).toBeNull();
    expect(screen.queryByTestId('setup-item-action:till')).toBeNull();
    expect(screen.queryByTestId('setup-item-mark-todo:till')).toBeNull();
  });

  it('links each item to the exact screen, carrying the practice id', () => {
    renderCard();
    const href = (key: string) =>
      screen.getByTestId(`setup-item-action:${key}`).getAttribute('href');

    expect(href('banking')).toBe('/practice/details?practiceId=prac-1#banking');
    expect(href('provider')).toBe('/practice/members?practiceId=prac-1');
    expect(href('details')).toBe('/practice/details?practiceId=prac-1');
  });

  it('emphasises exactly ONE action — the first outstanding item', () => {
    // A row of equally-loud buttons is the pile of sidebar links again. The
    // emphasised one is the answer to "what do I do next".
    renderCard();
    const filled = ['banking', 'provider', 'details'].filter((k) =>
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
  });

  it('says nothing about approval — the trading-gate panel owns that', () => {
    // Two amber boxes on one page saying "we're reviewing you" in two
    // different sets of words read as two different problems.
    const { container } = renderCard();
    expect(screen.queryByTestId('setup-awaiting-approval')).toBeNull();
    expect(container.textContent).not.toMatch(/approval|working day/i);
  });
});

// ─── The till suggestion ─────────────────────────────────────────────────

describe('the till suggestion', () => {
  it('appears while the required items are outstanding', () => {
    renderCard();
    expect(screen.getByTestId('setup-suggestion:till')).toBeTruthy();
    expect(screen.getByTestId('setup-suggestion-action:till').getAttribute('href'))
      .toBe('/practice/pos/devices?practiceId=prac-1');
  });

  it('is labelled optional, so it never reads as an outstanding task', () => {
    renderCard();
    expect(screen.getByTestId('setup-suggestion-eyebrow:till').textContent)
      .toMatch(/optional/i);
  });

  it('carries no tick circle and no share of the count', () => {
    // Three independent signals separate it from a required row: no state mark,
    // its own tinted strip, and the explicit label above. A reader who cannot
    // see the tint still has the other two.
    renderCard();
    expect(screen.queryByTestId('setup-item-mark-todo:till')).toBeNull();
    expect(screen.queryByTestId('setup-item-mark-done:till')).toBeNull();
    expect(screen.getByTestId('setup-progress').textContent).toBe('0 of 3 done');
  });

  it('sits OUTSIDE the list of required items', () => {
    renderCard();
    const list = screen.getByTestId('practice-setup-checklist').querySelector('ul')!;
    expect(list.querySelector('[data-testid="setup-suggestion:till"]')).toBeNull();
    expect(list.querySelectorAll('li').length).toBe(3);
  });

  it('never takes the emphasised button — that belongs to the next required thing', () => {
    renderCard();
    const cls = screen.getByTestId('setup-suggestion-action:till').getAttribute('class') ?? '';
    expect(cls).not.toContain('text-white');
    expect(cls).toContain('underline');
  });

  it('explains both halves of the case — getting on with it, and the login', () => {
    renderCard();
    const why = screen.getByTestId('setup-suggestion-why:till').textContent ?? '';
    expect(why).toMatch(/without waiting for you/i);
    expect(why).toMatch(/PIN/);
    expect(why).toMatch(/login never has to be shared/i);
  });

  it('DISAPPEARS once a till is set up — no nag', () => {
    renderCard({ hasActiveTillDevice: true, hasTillPin: true });
    expect(screen.getByTestId('practice-setup-checklist')).toBeTruthy();
    expect(screen.queryByTestId('setup-suggestion:till')).toBeNull();
  });

  it('names the missing half when only one is in place', () => {
    renderCard({ hasActiveTillDevice: true, hasTillPin: false });
    expect(screen.getByTestId('setup-suggestion-hint:till').textContent)
      .toMatch(/needs a PIN/i);
  });

  it('names the other missing half too', () => {
    renderCard({ hasActiveTillDevice: false, hasTillPin: true });
    expect(screen.getByTestId('setup-suggestion-hint:till').textContent)
      .toMatch(/register the computer/i);
  });

  it('is absent for a viewer who could not act on it', () => {
    renderCard({}, { ...FULL_RIGHTS, canManageTill: false });
    expect(screen.queryByTestId('setup-suggestion:till')).toBeNull();
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

  it('marks the done ones done and counts 2 of 3', () => {
    renderCard(partial);
    expect(screen.getByTestId('setup-progress').textContent).toBe('2 of 3 done');
    expect(screen.getByTestId('setup-item:banking').getAttribute('data-state')).toBe('done');
    expect(screen.getByTestId('setup-item:details').getAttribute('data-state')).toBe('done');
    expect(screen.getByTestId('setup-item:provider').getAttribute('data-state')).toBe('todo');
  });

  it('offers no action link on an item that is already done', () => {
    renderCard(partial);
    expect(screen.queryByTestId('setup-item-action:banking')).toBeNull();
    expect(screen.queryByTestId('setup-item-action:details')).toBeNull();
    expect(screen.getByTestId('setup-item-action:provider')).toBeTruthy();
  });

  it('moves the emphasis to the first thing still outstanding', () => {
    renderCard(partial);
    const cls = screen.getByTestId('setup-item-action:provider').getAttribute('class') ?? '';
    expect(cls).toContain('text-white');
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

describe('the required items finished', () => {
  it('renders NOTHING AT ALL — no card, no stub, no heading', () => {
    const { container } = renderCard(REQUIRED_DONE);
    expect(screen.queryByTestId('practice-setup-checklist')).toBeNull();
    expect(screen.queryByTestId('setup-progress')).toBeNull();
    // Not merely hidden or collapsed — the component emits no DOM whatsoever.
    expect(container.innerHTML).toBe('');
    expect(screen.queryByText(/finish setting up/i)).toBeNull();
  });

  it('takes the till suggestion with it — nothing optional keeps the card open', () => {
    // The decision this revision encodes: an item a practice can legitimately
    // never complete must not be able to hold the dashboard's best strip
    // forever. The sidebar link to the till is the way in from here on.
    const { container } = renderCard(REQUIRED_DONE);
    expect(container.innerHTML).toBe('');
    expect(screen.queryByTestId('setup-suggestion:till')).toBeNull();
  });

  it('stays absent whether or not a till was ever registered', () => {
    // Same outcome from both till states, which is the whole point of moving it
    // out of the required set.
    expect(renderCard(REQUIRED_DONE).container.innerHTML).toBe('');
    expect(renderCard({
      ...REQUIRED_DONE, hasActiveTillDevice: true, hasTillPin: true,
    }).container.innerHTML).toBe('');
  });

  it('re-appears if a required thing is undone — banking cleared by an admin', () => {
    // The behaviour a stored completion flag could not produce.
    const { container } = renderCard({ ...REQUIRED_DONE, bankingResolved: false });
    expect(container.innerHTML).not.toBe('');
    expect(screen.getByTestId('setup-progress').textContent).toBe('2 of 3 done');
    expect(screen.getByTestId('setup-item:banking').getAttribute('data-state')).toBe('todo');
  });

  it('does NOT re-appear when the last till device is revoked', () => {
    // The flip side of the same decision: revoking a till brings the
    // SUGGESTION back (proved in the derivation tests) but must never bring the
    // finished card back onto the dashboard.
    const withTill = { ...REQUIRED_DONE, hasActiveTillDevice: true, hasTillPin: true };
    expect(renderCard(withTill).container.innerHTML).toBe('');
    expect(renderCard({ ...withTill, hasActiveTillDevice: false }).container.innerHTML).toBe('');
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
    expect(screen.getByTestId('setup-progress').textContent).toBe('0 of 3 done');
    expect(screen.getByTestId('practice-setup-checklist')).toBeTruthy();
  });

  it('emphasises nothing when there is nothing the viewer can click', () => {
    renderCard({}, { canEditDetails: false, canManageTeam: false, canManageTill: false });
    for (const k of ['banking', 'provider', 'details']) {
      expect(screen.queryByTestId(`setup-item-action:${k}`)).toBeNull();
    }
    expect(screen.queryByTestId('setup-suggestion:till')).toBeNull();
  });
});
