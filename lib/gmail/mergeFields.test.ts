import { describe, it, expect } from 'vitest';
import { substituteMergeFields } from './mergeFields';

describe('substituteMergeFields', () => {
  it('substitutes every supported merge field', () => {
    const out = substituteMergeFields(
      'Hi {{contact_first_name}} — a note about {{practice_name}}. — {{my_name}}',
      { contact_first_name: 'Alice', practice_name: 'Rosebank Dental', my_name: 'Sam' },
    );
    expect(out).toBe('Hi Alice — a note about Rosebank Dental. — Sam');
  });

  it('leaves unknown placeholders intact', () => {
    const out = substituteMergeFields('{{practice_name}} {{unknown}}', { practice_name: 'X' });
    expect(out).toBe('X {{unknown}}');
  });

  it('leaves the placeholder visible when the value is empty/null', () => {
    const out = substituteMergeFields('Hi {{contact_first_name}}', { contact_first_name: '' });
    expect(out).toBe('Hi {{contact_first_name}}');
    const out2 = substituteMergeFields('Hi {{contact_first_name}}', { contact_first_name: null });
    expect(out2).toBe('Hi {{contact_first_name}}');
  });

  it('is safe when the template has no fields', () => {
    expect(substituteMergeFields('plain text', {})).toBe('plain text');
  });
});
