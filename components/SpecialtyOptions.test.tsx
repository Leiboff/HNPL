import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import SpecialtyOptions from './SpecialtyOptions';
import { SPECIALTIES, SPECIALTY_LETTER_GROUPS } from '@/lib/specialties';

function renderSelect(props: React.ComponentProps<typeof SpecialtyOptions> = {}) {
  const { container } = render(<select><SpecialtyOptions {...props} /></select>);
  return container.querySelector('select')!;
}

describe('SpecialtyOptions', () => {
  it('offers every specialty in the register', () => {
    const values = Array.from(renderSelect().querySelectorAll('option')).map(o => o.getAttribute('value'));
    for (const s of SPECIALTIES) expect(values).toContain(s);
  });

  it('groups them under their initial letter, in register order', () => {
    const groups = Array.from(renderSelect().querySelectorAll('optgroup'));
    expect(groups.map(g => g.getAttribute('label'))).toEqual(SPECIALTY_LETTER_GROUPS.map(g => g.letter));
  });

  it('renders no placeholder unless one is asked for', () => {
    expect(renderSelect().querySelector('option[value=""]')).toBeNull();
    const withPlaceholder = renderSelect({ placeholder: 'Select specialty' });
    expect(withPlaceholder.querySelector('option[value=""]')?.textContent).toBe('Select specialty');
  });

  it('keeps an off-register saved value selectable', () => {
    // specialty is free text in the DB (bulk imports, and the
    // pre-2026-08 vocabulary). A <select> silently drops a value it has
    // no option for, which would turn "edit the phone number" into
    // "and quietly relabel this practitioner".
    const select = renderSelect({ current: 'Sports Medicine Physician' });
    const option = Array.from(select.querySelectorAll('option'))
      .find(o => o.getAttribute('value') === 'Sports Medicine Physician');
    expect(option).toBeTruthy();
    expect(option!.closest('optgroup')?.getAttribute('label')).toBe('Currently recorded');
  });

  it('does not duplicate a saved value that IS in the register', () => {
    const select = renderSelect({ current: 'Cardiologist' });
    const matches = Array.from(select.querySelectorAll('option'))
      .filter(o => o.getAttribute('value') === 'Cardiologist');
    expect(matches).toHaveLength(1);
    expect(select.querySelector('optgroup[label="Currently recorded"]')).toBeNull();
  });

  it('ignores an empty current value', () => {
    for (const current of ['', null, undefined]) {
      expect(renderSelect({ current }).querySelector('optgroup[label="Currently recorded"]')).toBeNull();
    }
  });
});

describe('one vocabulary, no local copies', () => {
  // The bug this component exists to prevent: two surfaces offering
  // different specialties because each declared its own array.
  const ROOT = resolve(process.cwd());

  function sources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(join(ROOT, dir))) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const rel = join(dir, entry);
      if (statSync(join(ROOT, rel)).isDirectory()) sources(rel, out);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(rel);
    }
    return out;
  }

  it('no file outside lib/specialties.ts declares a SPECIALTIES array', () => {
    const offenders = sources('app')
      .concat(sources('components'))
      .filter(f => /const\s+SPECIALTIES\s*(:[^=]+)?=\s*\[/.test(readFileSync(join(ROOT, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  // Filters are the one exemption, and for the same reason the patient
  // portal has no hard-coded list: a filter offers what the DATA holds,
  // not the whole 60-entry register — most of which would match nothing
  // and none of which covers the free-text values imports leave behind.
  const FILTER_SURFACES = ['app/crm/leads/LeadsFilterDropdowns.tsx'];

  it('every specialty-picking <select> in app/ renders SpecialtyOptions', () => {
    const offenders = sources('app')
      .filter(f => !FILTER_SURFACES.includes(f))
      .filter(f => {
        const src = readFileSync(join(ROOT, f), 'utf8');
        // A <select> with a specialty field wired up nearby.
        const picksSpecialty = /<select[\s\S]{0,400}?specialty/i.test(src);
        return picksSpecialty && !/<SpecialtyOptions/.test(src);
      });
    expect(offenders).toEqual([]);
  });

  it('the filter surfaces are prop-driven, not hard-coded', () => {
    for (const f of FILTER_SURFACES) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      expect(src).toMatch(/specialties:\s*readonly string\[\]/);
      expect(src).not.toMatch(/from ['"]@\/lib\/specialties['"]/);
    }
  });
});
