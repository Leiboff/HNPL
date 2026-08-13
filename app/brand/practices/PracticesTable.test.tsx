import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';
import PracticesTable from './PracticesTable';
import { buildSetupChecklist, type SetupChecklistFacts } from '@/lib/practice/setupChecklist';
import { BRAND_TABLE_AUTHORITY, type BrandPracticeSetup } from '@/lib/brand/brandPracticeSetup';

// ─── The Practices table ───────────────────────────────────────────────────
//
// It exists so a brand admin spots that a branch has no banking WITHOUT
// visiting it. So the load-bearing assertions are:
//
//   • an incomplete practice is distinguishable from a complete one by TEXT,
//     not only by colour — three independent signals, same reason the payout
//     chips carry a word
//   • what it says is missing is what the practice's own checklist card says is
//     missing, in the checklist's own words
//   • every row is a doorway into the right practice, with scope preserved
//
// The fixtures are built by running the REAL buildSetupChecklist over facts, so
// the items in a row are the items the card would render — a hand-written items
// array would let the table and the card agree in the test and diverge in the
// product.

afterEach(cleanup);

const FULL_FACTS: SetupChecklistFacts = {
  phone: '+27 11 555 0000',
  addressLine1: '12 Oxford Rd',
  latitude: -26.14,
  longitude: 28.04,
  bankingResolved: true,
  hasActiveProvider: true,
  hasActiveTillDevice: true,
  hasTillPin: true,
};

/** A row whose items come from the real derivation, not from hand-written flags. */
function setupRow(
  practiceId: string,
  factOver: Partial<SetupChecklistFacts> = {},
  over: Partial<BrandPracticeSetup> = {},
): BrandPracticeSetup {
  const facts     = { ...FULL_FACTS, ...factOver };
  const checklist = buildSetupChecklist(facts, BRAND_TABLE_AUTHORITY);
  const done = {} as BrandPracticeSetup['done'];
  for (const i of checklist.items) done[i.key] = i.done;
  const status = over.status ?? 'approved';

  return {
    practiceId,
    practiceName: practiceId,
    suburb: 'Rosebank',
    city:   'Johannesburg',
    status,
    approved: status === 'approved',
    items: checklist.items,
    done,
    outstanding: checklist.items.filter((i) => !i.done).map((i) => i.key),
    doneCount: checklist.doneCount,
    total: checklist.total,
    setupComplete: checklist.complete,
    hasProvider:   facts.hasActiveProvider,
    hasTillDevice: facts.hasActiveTillDevice,
    hasTillPin:    facts.hasTillPin,
    needsAttention: !checklist.complete || status !== 'approved',
    ...over,
  };
}

const GOOD = setupRow('p-good', {}, { practiceName: 'Rosebank' });
const NO_BANK = setupRow('p-nobank', { bankingResolved: false }, { practiceName: 'Sandton' });

const mount = (practices: BrandPracticeSetup[]) => render(<PracticesTable practices={practices} />);

// ─── Incomplete must be obvious ────────────────────────────────────────────

describe('an incomplete practice is visually distinguishable from a complete one', () => {
  it('carries a machine-readable flag, so the distinction is structural', () => {
    mount([GOOD, NO_BANK]);
    expect(screen.getByTestId('brand-practice-setup-p-good').getAttribute('data-needs-attention')).toBe('false');
    expect(screen.getByTestId('brand-practice-setup-p-nobank').getAttribute('data-needs-attention')).toBe('true');
  });

  it('gets an "Action needed" chip that the complete row does not', () => {
    mount([GOOD, NO_BANK]);
    expect(screen.getByTestId('brand-practice-attention-p-nobank').textContent).toBe('Action needed');
    expect(screen.queryByTestId('brand-practice-attention-p-good')).toBeNull();
  });

  it('names what is missing IN TEXT — colour is never the only signal', () => {
    mount([GOOD, NO_BANK]);
    expect(screen.getByTestId('brand-practice-missing-p-nobank').textContent)
      .toBe('Still needed: Bank account');
    expect(screen.queryByTestId('brand-practice-missing-p-good')).toBeNull();
  });

  it('the banking cell itself says "Not set", not merely a red mark', () => {
    mount([GOOD, NO_BANK]);
    expect(screen.getByTestId('brand-practice-banking-p-nobank').textContent).toBe('Not set');
    expect(screen.getByTestId('brand-practice-banking-p-good').textContent).toBe('Set');
  });

  it('so a complete row has THREE fewer signals and an incomplete one has all three', () => {
    mount([GOOD, NO_BANK]);
    const bad = screen.getByTestId('brand-practice-setup-p-nobank').textContent ?? '';
    expect(bad).toContain('Action needed');
    expect(bad).toContain('Still needed');
    expect(bad).toContain('Not set');
    const good = screen.getByTestId('brand-practice-setup-p-good').textContent ?? '';
    expect(good).not.toContain('Action needed');
    expect(good).not.toContain('Still needed');
    expect(good).not.toContain('Not set');
  });

  it('summarises how many need attention, at the top', () => {
    mount([GOOD, NO_BANK]);
    expect(screen.getByTestId('brand-practices-summary').textContent).toBe('1 of 2 need attention');
  });

  it('says so plainly when nothing needs attention — no false alarm', () => {
    mount([GOOD, setupRow('p-good2')]);
    expect(screen.getByTestId('brand-practices-summary').textContent)
      .toBe('All 2 practices are set up and approved');
  });
});

// ─── Agreement with the practice's own checklist ───────────────────────────

describe('what it says is missing is what the practice\'s own card says', () => {
  it('prints the checklist\'s OWN item titles, not a paraphrase', () => {
    const bare = setupRow('p-bare', {
      bankingResolved: false, hasActiveProvider: false,
      phone: null, addressLine1: null, latitude: null, longitude: null,
    });
    mount([bare]);
    const card = buildSetupChecklist(
      { ...FULL_FACTS, bankingResolved: false, hasActiveProvider: false, phone: null, addressLine1: null, latitude: null, longitude: null },
      BRAND_TABLE_AUTHORITY,
    );
    const titles = card.items.filter((i) => !i.done).map((i) => i.title);
    expect(titles).toEqual(['Bank account', 'The doctor or practitioner', 'Address and phone number']);
    expect(screen.getByTestId('brand-practice-missing-p-bare').textContent)
      .toBe(`Still needed: ${titles.join(', ')}`);
  });

  it('a geocode-less address still counts as missing — the silent case the card also catches', () => {
    // Signup writes latitude/longitude best-effort; on failure the practice looks
    // complete while being un-findable. Both surfaces must call it out.
    const noGeo = setupRow('p-nogeo', { latitude: null, longitude: null });
    mount([noGeo]);
    expect(screen.getByTestId('brand-practice-missing-p-nogeo').textContent)
      .toContain('Address and phone number');
    expect(screen.getByTestId('brand-practice-setup-p-nogeo').getAttribute('data-needs-attention')).toBe('true');
  });

  it('the practitioner cell reports roster PRESENCE, from the checklist verdict', () => {
    mount([GOOD, setupRow('p-none', { hasActiveProvider: false })]);
    // "On roster", not a number: the underlying read is .limit(1)-ed, so a
    // count here could only ever be 1 — see lib/brand/brandPracticeSetup.
    expect(screen.getByTestId('brand-practice-providers-p-good').textContent).toBe('On roster');
    expect(screen.getByTestId('brand-practice-providers-p-none').textContent).toBe('None on roster');
  });
});

// ─── Approval ─────────────────────────────────────────────────────────────

describe('approval — the column the checklist card deliberately does not have', () => {
  it('shows the status verbatim, whatever it is', () => {
    mount([
      setupRow('p1', {}, { status: 'approved' }),
      setupRow('p2', {}, { status: 'pending' }),
      setupRow('p3', {}, { status: 'suspended' }),
    ]);
    expect(screen.getByTestId('brand-practice-status-p1').textContent).toBe('approved');
    expect(screen.getByTestId('brand-practice-status-p2').textContent).toBe('pending');
    expect(screen.getByTestId('brand-practice-status-p3').textContent).toBe('suspended');
  });

  it('a fully set-up but PENDING practice needs attention without being told an item is missing', () => {
    mount([setupRow('p-wait', {}, { status: 'pending' })]);
    expect(screen.getByTestId('brand-practice-setup-p-wait').getAttribute('data-needs-attention')).toBe('true');
    expect(screen.queryByTestId('brand-practice-missing-p-wait')).toBeNull();
  });

  it('explains that pending is ours to clear, not theirs', () => {
    mount([setupRow('p-wait', {}, { status: 'pending' })]);
    expect(screen.getByTestId('brand-practices-approval-note').textContent)
      .toContain('approval is ours to complete, not yours');
  });
});

// ─── The till, as facts ───────────────────────────────────────────────────

describe('the till column reports facts rather than passing judgement', () => {
  it('names both halves when both are there', () => {
    mount([GOOD]);
    expect(screen.getByTestId('brand-practice-till-p-good').textContent).toBe('Registered · PIN set');
  });

  it('names WHICH half is missing', () => {
    mount([
      setupRow('p-nopin',  { hasTillPin: false }),
      setupRow('p-notill', { hasActiveTillDevice: false }),
    ]);
    expect(screen.getByTestId('brand-practice-till-p-nopin').textContent).toBe('Registered · no PIN');
    expect(screen.getByTestId('brand-practice-till-p-notill').textContent).toBe('PIN set · no till');
  });

  it('"Not set up" is NOT an alarm — a practice billing from one laptop is fine', () => {
    // The checklist demoted the till to optional for exactly this reason. A red
    // cross here would tell a correctly-configured practice it had done wrong.
    const laptopOnly = setupRow('p-laptop', { hasActiveTillDevice: false, hasTillPin: false });
    mount([laptopOnly]);
    expect(screen.getByTestId('brand-practice-till-p-laptop').textContent).toBe('Not set up');
    expect(screen.getByTestId('brand-practice-setup-p-laptop').getAttribute('data-needs-attention')).toBe('false');
    expect(screen.queryByTestId('brand-practice-attention-p-laptop')).toBeNull();
  });

  it('offers the till admin link, scoped per practice — relocated from the retired strip', () => {
    mount([GOOD, NO_BANK]);
    expect(screen.getByTestId('brand-practice-till-link-p-good').getAttribute('href'))
      .toBe('/practice/pos/devices?practiceId=p-good');
    expect(screen.getByTestId('brand-practice-till-link-p-nobank').getAttribute('href'))
      .toBe('/practice/pos/devices?practiceId=p-nobank');
  });
});

// ─── Doorways ─────────────────────────────────────────────────────────────

describe('every row is a doorway into the right practice', () => {
  it('links via the pivot, which sets ?practiceId= itself', () => {
    mount([GOOD, NO_BANK]);
    expect(screen.getByTestId('brand-practice-setup-link-p-good').getAttribute('href'))
      .toBe('/brand/branch/p-good');
    expect(screen.getByTestId('brand-practice-setup-link-p-nobank').getAttribute('href'))
      .toBe('/brand/branch/p-nobank');
  });

  it('the link text is the practice name, so the destination is unambiguous', () => {
    mount([GOOD, NO_BANK]);
    expect(screen.getByTestId('brand-practice-setup-link-p-good').textContent).toBe('Rosebank');
    expect(screen.getByTestId('brand-practice-setup-link-p-nobank').textContent).toBe('Sandton');
  });

  it('never deep-links into a settings section — the card there owns the fix path', () => {
    mount([NO_BANK]);
    const hrefs = screen.getAllByRole('link').map((el) => el.getAttribute('href'));
    expect(hrefs).not.toContain('/practice/details#banking');
    expect(hrefs.some((h) => h?.includes('/practice/settings'))).toBe(false);
    expect(hrefs.some((h) => h?.includes('/practice/members'))).toBe(false);
  });

  it('renders only the practices it is handed', () => {
    mount([GOOD]);
    expect(screen.getByTestId('brand-practice-setup-p-good')).toBeTruthy();
    expect(screen.queryByTestId('brand-practice-setup-p-nobank')).toBeNull();
    expect(screen.getAllByRole('row')).toHaveLength(2);   // header + one practice
  });
});

// ─── Source pins ─────────────────────────────────────────────────────────

describe('source pins', () => {
  const SRC  = readFileSync(resolve(process.cwd(), 'app/brand/practices/PracticesTable.tsx'), 'utf8');
  const code = stripComments(SRC);

  it('reads item verdicts, never a fact-level predicate of its own', () => {
    expect(code).toMatch(/p\.done\.banking/);
    expect(code).toMatch(/p\.done\.provider/);
    expect(code).not.toMatch(/bankingResolved|latitude|longitude|address_line1/);
  });

  it('reads item.href NOWHERE', () => {
    expect(code).not.toMatch(/\.href/);
  });

  it('formats no dates and no money — this screen has neither', () => {
    expect(code).not.toMatch(/new Date\(|toISOString|toFixed|toLocaleString|formatRand|formatDate/);
    expect(code).not.toMatch(/\bR\d|`R\$\{/);
  });

  it('is a server component — nothing here needs client state', () => {
    expect(code).not.toMatch(/'use client'/);
    expect(code).not.toMatch(/useState|useEffect/);
  });
});
