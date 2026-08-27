import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { STAGES, STAGE_LABELS, TERMINAL_STAGES, WORKING_STAGES } from '@/lib/crm/stages';

// ─── Stage vocabulary — lib/crm/stages.ts is the only source ─────────
//
// Step 0 of the CRM interest/dedupe work extracted the eight-member
// stage literal out of every file that used to declare its own copy.
// These are source-pin tests: any file that reintroduces a hand-rolled
// stage array/set trips the grep assertions below.

const ROOT = resolve(process.cwd());
function read(p: string): string { return readFileSync(resolve(ROOT, p), 'utf8'); }

const FULL_STAGE_LITERAL = /['"]new['"]\s*,\s*['"]contacted['"]\s*,\s*['"]meeting_scheduled['"]\s*,\s*['"]demo_done['"]/;
const TERMINAL_LITERAL   = /\[\s*['"](signed|onboarded|lost)['"]\s*,\s*['"](signed|onboarded|lost)['"]\s*,\s*['"](signed|onboarded|lost)['"]\s*\]/;

describe('lib/crm/stages.ts — single source of truth', () => {
  it('exports the nine-stage vocabulary in pipeline order (Step 0\'s original eight, plus Change 3\'s nurture)', () => {
    expect(STAGES).toEqual([
      'new', 'contacted', 'meeting_scheduled', 'demo_done',
      'agreement_sent', 'nurture', 'signed', 'onboarded', 'lost',
    ]);
  });

  it('has a label for every stage', () => {
    for (const s of STAGES) expect(STAGE_LABELS[s]).toBeTruthy();
  });

  it('TERMINAL_STAGES is exactly signed/onboarded/lost — nurture is deliberately NOT terminal', () => {
    expect(TERMINAL_STAGES).toEqual(new Set(['signed', 'onboarded', 'lost']));
  });

  it('WORKING_STAGES is the complement of TERMINAL_STAGES, in STAGES order', () => {
    expect(WORKING_STAGES).toEqual(['new', 'contacted', 'meeting_scheduled', 'demo_done', 'agreement_sent', 'nurture']);
    for (const s of WORKING_STAGES) expect(TERMINAL_STAGES.has(s)).toBe(false);
  });
});

describe('no duplicated stage literal remains outside lib/crm/stages.ts', () => {
  const CONSUMERS = [
    'app/crm/page.tsx',
    'app/crm/leads/page.tsx',
    'app/crm/leads/actions.ts',
    'app/crm/leads/LeadsFilterDropdowns.tsx',
    'app/crm/leads/[id]/LeadDetailClient.tsx',
    'app/crm/map/MapClient.tsx',
  ];

  for (const path of CONSUMERS) {
    it(`${path} imports STAGES from lib/crm/stages instead of declaring its own`, () => {
      const src = read(path);
      expect(src).toMatch(/from\s+['"]@\/lib\/crm\/stages['"]/);
      expect(src).not.toMatch(FULL_STAGE_LITERAL);
    });
  }

  for (const path of ['lib/crm/followups.ts', 'lib/crm/priorityScore.ts']) {
    it(`${path} imports TERMINAL_STAGES from lib/crm/stages instead of declaring its own`, () => {
      const src = read(path);
      expect(src).toMatch(/from\s+['"]\.\/stages['"]/);
      expect(src).not.toMatch(TERMINAL_LITERAL);
    });
  }

  it('lib/gmail/replyIngest.ts CLOSED_STAGES is TERMINAL_STAGES re-exported, not its own Set', () => {
    const src = read('lib/gmail/replyIngest.ts');
    expect(src).toMatch(/from\s+['"]@\/lib\/crm\/stages['"]/);
    expect(src).toMatch(/CLOSED_STAGES\s*=\s*TERMINAL_STAGES/);
    expect(src).not.toMatch(TERMINAL_LITERAL);
  });
});
