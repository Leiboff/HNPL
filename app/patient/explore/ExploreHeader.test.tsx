import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CategoryCount } from '@/lib/practitioner/categories';

// ─── Tests — the navy Find-care header ────────────────────────────────
//
// Landing → "Find care" + the total count (unchanged brand line), plus the
// search field, which moved up here off the sheet when the header became
// the navy crown.
// Inside a specialty → the SPECIALTY is the title, the count is that
// specialty's own, and a labelled back control returns to the specialty
// list. The title has to follow the URL param, because the Filters
// drawer in the sheet rewrites it (ExploreView.selectSpecialty).

const currentParams = new URLSearchParams();
const pushed: string[] = [];
vi.mock('next/navigation', async () => {
  const actual = await vi.importActual<typeof import('next/navigation')>('next/navigation');
  return {
    ...actual,
    useSearchParams: () => currentParams,
    // The landing's search field navigates on submit. Outside an app
    // router the real hook throws, so it is stubbed here — and the pushes
    // are captured, because "typing a query takes you to the results" is
    // behaviour this header now owns.
    useRouter: () => ({
      push: (href: string) => { pushed.push(href); },
      replace: () => {}, prefetch: () => {}, back: () => {}, forward: () => {}, refresh: () => {},
    }),
  };
});

function setParams(next: Record<string, string>) {
  for (const k of Array.from(currentParams.keys())) currentParams.delete(k);
  for (const [k, v] of Object.entries(next)) currentParams.set(k, v);
}

import ExploreHeader from './ExploreHeader';

const CATEGORIES: CategoryCount[] = [
  { specialty: 'General Dental Practitioner', count: 8 },
  { specialty: 'Physiotherapy',               count: 1 },
];

describe('ExploreHeader — landing', () => {
  beforeEach(() => { setParams({}); pushed.length = 0; });

  it('titles "Find care" and counts the whole directory', () => {
    render(<ExploreHeader practitionerCount={9} categories={CATEGORIES} />);
    expect(screen.getByTestId('explore-header-title').textContent).toBe('Find care');
    expect(screen.getByTestId('explore-header-count').textContent)
      .toBe('Pay later at 9 practitioners near you.');
    // No back control on the landing — there's nowhere above it.
    expect(screen.queryByTestId('results-back-to-landing')).toBeNull();
  });

  it('drops the count from the line when the directory is empty', () => {
    render(<ExploreHeader practitionerCount={0} categories={[]} />);
    expect(screen.getByTestId('explore-header-count').textContent)
      .toBe('Pay later at practitioners near you.');
  });

  it('carries the search field, and submitting it opens the results view', async () => {
    render(<ExploreHeader practitionerCount={9} categories={CATEGORIES} />);
    const input = screen.getByTestId('landing-search') as HTMLInputElement;
    await userEvent.type(input, 'berger{enter}');
    expect(pushed).toEqual(['/patient/explore?view=results&q=berger']);
  });

  it('an empty search still opens the results view, unfiltered', async () => {
    render(<ExploreHeader practitionerCount={9} categories={CATEGORIES} />);
    // Whitespace is not a query. Submitting blank means "show me everyone",
    // which is the results view with no ?q= at all — not ?q=%20.
    await userEvent.type(screen.getByTestId('landing-search'), '   {enter}');
    expect(pushed).toEqual(['/patient/explore?view=results']);
  });
});

describe('ExploreHeader — inside a specialty, the search field comes off', () => {
  it('leaves searching to the sheet, which live-filters the list', () => {
    setParams({ view: 'results', specialty: 'Physiotherapy' });
    render(<ExploreHeader practitionerCount={9} categories={CATEGORIES} />);
    // Two search boxes on one screen is one too many, and the sheet's is
    // the one that actually filters as you type (ResultsView).
    expect(screen.queryByTestId('landing-search')).toBeNull();
  });
});

describe('ExploreHeader — inside a specialty', () => {
  it('promotes the specialty to the title with its own practitioner count', () => {
    setParams({ view: 'results', specialty: 'General Dental Practitioner' });
    render(<ExploreHeader practitionerCount={9} categories={CATEGORIES} />);
    expect(screen.getByTestId('explore-header-title').textContent)
      .toBe('General Dental Practitioner');
    expect(screen.getByTestId('explore-header-count').textContent)
      .toBe('Pay later at 8 practitioners.');
  });

  it('singularises a one-practitioner specialty', () => {
    setParams({ view: 'results', specialty: 'Physiotherapy' });
    render(<ExploreHeader practitionerCount={9} categories={CATEGORIES} />);
    expect(screen.getByTestId('explore-header-count').textContent)
      .toBe('Pay later at 1 practitioner.');
  });

  it('renders a labelled back control pointing at the specialty list', () => {
    setParams({ view: 'results', specialty: 'Physiotherapy' });
    render(<ExploreHeader practitionerCount={9} categories={CATEGORIES} />);
    const back = screen.getByTestId('results-back-to-landing');
    expect(back.getAttribute('href')).toBe('/patient/explore');
    expect(back.textContent).toContain('All specialties');
    expect(back.getAttribute('aria-label')).toBe('Back to all specialties');
  });

  it('a hand-typed specialty with nobody behind it never claims practitioners', () => {
    setParams({ view: 'results', specialty: 'Urology' });
    render(<ExploreHeader practitionerCount={9} categories={CATEGORIES} />);
    expect(screen.getByTestId('explore-header-title').textContent).toBe('Urology');
    expect(screen.getByTestId('explore-header-count').textContent)
      .toBe('No practitioners listed here yet.');
  });

  it('a search or an unfiltered results view titles "All practitioners"', () => {
    setParams({ view: 'results', q: 'berger' });
    render(<ExploreHeader practitionerCount={9} categories={CATEGORIES} />);
    // The query itself is NOT echoed here: the search box in the sheet
    // owns that text and can change without the URL, so a header that
    // quoted it would go stale mid-typing.
    expect(screen.getByTestId('explore-header-title').textContent).toBe('All practitioners');
    expect(screen.getByTestId('explore-header-count').textContent)
      .toBe('Pay later at 9 practitioners.');
    expect(screen.getByTestId('results-back-to-landing')).toBeTruthy();
  });
});
