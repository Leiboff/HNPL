import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

function read(p: string): string { return readFileSync(resolve(process.cwd(), p), 'utf8'); }

describe('3.1 — nav collapsed to four sections', () => {
  it('CrmNav has exactly Today/Leads/Accounts/Settings, no separate Board/Map/Import/Gmail entries', () => {
    const SRC = read('app/crm/CrmNav.tsx');
    for (const label of ['Today', 'Leads', 'Accounts', 'Settings']) {
      expect(SRC).toMatch(new RegExp(`label:\\s*['"]${label}['"]`));
    }
    expect(SRC).not.toMatch(/label:\s*['"]Pipeline['"]/);
    expect(SRC).not.toMatch(/label:\s*['"]Import['"]/);
  });

  it('CrmBottomNav mirrors the same four sections', () => {
    const SRC = read('app/crm/CrmBottomNav.tsx');
    for (const href of ['/crm', '/crm/leads', '/crm/accounts', '/crm/settings']) {
      expect(SRC).toMatch(new RegExp(`href:\\s*['"]${href.replace('/', '\\/')}['"]`));
    }
  });

  it('Settings surfaces Import and (admin-only) Gmail accounts', () => {
    const SRC = read('app/crm/settings/page.tsx');
    expect(SRC).toMatch(/href="\/crm\/import"/);
    expect(SRC).toMatch(/href="\/crm\/admin\/gmail-accounts"/);
    expect(SRC).toMatch(/isAdmin &&/);
  });
});

describe('the Kanban board is removed', () => {
  it('app/crm/board no longer exists', () => {
    expect(existsSync(resolve(process.cwd(), 'app/crm/board'))).toBe(false);
  });

  it('nothing links to /crm/board any more', () => {
    for (const f of [
      'app/crm/CrmNav.tsx', 'app/crm/CrmBottomNav.tsx', 'app/crm/leads/LeadsViewSwitcher.tsx',
      'app/crm/leads/actions.ts', 'app/crm/import/actions.ts', 'app/crm/import/quickActions.ts',
    ]) {
      expect(read(f)).not.toMatch(/\/crm\/board/);
    }
  });
});

describe('3.1 — List · Map switcher shares one filter state', () => {
  it('LeadsViewSwitcher preserves the current querystring across both routes', () => {
    const SRC = read('app/crm/leads/LeadsViewSwitcher.tsx');
    expect(SRC).toMatch(/useSearchParams/);
    expect(SRC).toMatch(/qs \? `\$\{href\}\?\$\{qs\}` : href/);
    expect(SRC).toMatch(/{ view: 'list', href: '\/crm\/leads', label: 'List' }/);
    expect(SRC).toMatch(/{ view: 'map',  href: '\/crm\/map',   label: 'Map' }/);
  });

  it('leads list and map pages both import the same switcher', () => {
    expect(read('app/crm/leads/page.tsx')).toMatch(/LeadsViewSwitcher/);
    expect(read('app/crm/map/MapClient.tsx')).toMatch(/LeadsViewSwitcher/);
  });

  it('map page decodes filters from searchParams and applies them via the shared pure function', () => {
    const MAP = read('app/crm/map/page.tsx');
    expect(MAP).toMatch(/decodeFilters\(await searchParams\)/);
    expect(MAP).toMatch(/applyLeadFilters\(/);
  });
});

describe('stage/source/specialty/city/owner are dropdown filters, not pill chips', () => {
  it('LeadsFilterDropdowns renders a <select> per dimension', () => {
    const SRC = read('app/crm/leads/LeadsFilterDropdowns.tsx');
    for (const testId of ['filter-stage', 'filter-source', 'filter-specialty', 'filter-city', 'filter-owner']) {
      expect(SRC).toMatch(new RegExp(`data-testid="${testId}"`));
    }
    expect(SRC).toMatch(/<select/);
  });

  it('the leads list page reaches the dropdown component (via LeadsListSection > LeadsToolbar), not the old pill wall', () => {
    // The retail-style Sort/Filter buttons wrap LeadsFilterDropdowns inside
    // LeadsToolbar's Filter sheet, so page.tsx no longer imports it directly.
    const PAGE = read('app/crm/leads/page.tsx');
    expect(PAGE).toMatch(/LeadsListSection/);
    expect(PAGE).not.toMatch(/leads-filters-disclosure/);
    expect(PAGE).not.toMatch(/function ChipLink/);

    expect(read('app/crm/leads/LeadsListSection.tsx')).toMatch(/LeadsToolbar/);
    expect(read('app/crm/leads/LeadsToolbar.tsx')).toMatch(/LeadsFilterDropdowns/);
  });
});

describe('3.4 — scale', () => {
  it('leads list shows a result count', () => {
    expect(read('app/crm/leads/page.tsx')).toMatch(/data-testid="leads-result-count"/);
  });
  it('map shows a result count', () => {
    expect(read('app/crm/map/MapClient.tsx')).toMatch(/data-testid="map-result-count"/);
  });

  it('10. map cluster bubbles are coloured via the SAME palette function as the pins and legend', () => {
    const SRC = read('app/crm/map/MapClient.tsx');
    expect(SRC).toMatch(/function dominantStageColor/);
    expect(SRC).toMatch(/return pinColourForStage\(best\);/);
    expect(SRC).toMatch(/renderer: buildClusterRenderer\(g\) as any/);
  });

  it('route planner supports a saved base address, not just live location', () => {
    const SRC = read('app/crm/map/MapClient.tsx');
    expect(SRC).toMatch(/data-testid="map-use-base-address"/);
    expect(SRC).toMatch(/data-testid="map-base-address-editor"/);
    expect(SRC).toMatch(/Start from my location/); // live location still works too
  });
});

describe('no schema change was required for Phase 3', () => {
  it('the saved base address is client-side (localStorage), not a new column', () => {
    const SRC = read('app/crm/map/MapClient.tsx');
    expect(SRC).toMatch(/window\.localStorage\.setItem\(BASE_ADDRESS_KEY/);
  });
});
