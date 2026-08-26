import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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

describe('3.1 — List · Board · Map switcher shares one filter state', () => {
  it('LeadsViewSwitcher preserves the current querystring across all three routes', () => {
    const SRC = read('app/crm/leads/LeadsViewSwitcher.tsx');
    expect(SRC).toMatch(/useSearchParams/);
    expect(SRC).toMatch(/qs \? `\$\{href\}\?\$\{qs\}` : href/);
  });

  it('leads list, board, and map pages all import the same switcher', () => {
    expect(read('app/crm/leads/page.tsx')).toMatch(/LeadsViewSwitcher/);
    expect(read('app/crm/board/BoardClient.tsx')).toMatch(/LeadsViewSwitcher/);
    expect(read('app/crm/map/MapClient.tsx')).toMatch(/LeadsViewSwitcher/);
  });

  it('board and map pages decode filters from searchParams and apply them via the shared pure function', () => {
    const BOARD = read('app/crm/board/page.tsx');
    expect(BOARD).toMatch(/decodeFilters\(await searchParams\)/);
    expect(BOARD).toMatch(/applyLeadFilters\(/);
    const MAP = read('app/crm/map/page.tsx');
    expect(MAP).toMatch(/decodeFilters\(await searchParams\)/);
    expect(MAP).toMatch(/applyLeadFilters\(/);
  });
});

describe('3.4 — scale', () => {
  it('leads list shows a result count', () => {
    expect(read('app/crm/leads/page.tsx')).toMatch(/data-testid="leads-result-count"/);
  });
  it('board shows a result count', () => {
    expect(read('app/crm/board/BoardClient.tsx')).toMatch(/data-testid="board-result-count"/);
  });
  it('map shows a result count', () => {
    expect(read('app/crm/map/MapClient.tsx')).toMatch(/data-testid="map-result-count"/);
  });

  it('7. adversarial — board columns cap and offer "show more"', () => {
    const SRC = read('app/crm/board/BoardClient.tsx');
    expect(SRC).toMatch(/const COLUMN_PAGE_SIZE = 50/);
    expect(SRC).toMatch(/expanded\.has\(stage\.key\) \? stageRows : stageRows\.slice\(0, COLUMN_PAGE_SIZE\)/);
    expect(SRC).toMatch(/data-testid=\{`crm-board-column-show-more:/);
  });

  it('board cards show full practice names — no truncate class on the name', () => {
    const SRC = read('app/crm/board/BoardClient.tsx');
    expect(SRC).toMatch(/text-xs font-semibold text-gray-900 break-words">\{r\.practice_name\}/);
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
