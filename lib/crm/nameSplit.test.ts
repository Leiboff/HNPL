import { describe, it, expect } from 'vitest';
import { splitFullName } from './nameSplit';

describe('splitFullName', () => {
  it('strips a leading title and splits the rest', () => {
    expect(splitFullName('Dr Sunday Joseph Aigbodion')).toEqual({
      title: 'Dr', firstName: 'Sunday Joseph', lastName: 'Aigbodion',
    });
  });

  it('handles a plain two-token name with no title', () => {
    expect(splitFullName('Zaheda Bhabha')).toEqual({
      title: null, firstName: 'Zaheda', lastName: 'Bhabha',
    });
  });

  it('keeps a parenthetical nickname in the first-name portion', () => {
    expect(splitFullName('Dr Kristofor (Kris) Goodwin')).toEqual({
      title: 'Dr', firstName: 'Kristofor (Kris)', lastName: 'Goodwin',
    });
  });

  it('falls back to duplicating the single remaining token after a title', () => {
    expect(splitFullName('Dr Madonna')).toEqual({
      title: 'Dr', firstName: 'Madonna', lastName: 'Madonna',
    });
  });

  it('does not treat a lone single-token name as a title', () => {
    expect(splitFullName('Madonna')).toEqual({
      title: null, firstName: 'Madonna', lastName: 'Madonna',
    });
  });

  it('collapses extra whitespace', () => {
    expect(splitFullName('  Dr   Janine   Olivier  ')).toEqual({
      title: 'Dr', firstName: 'Janine', lastName: 'Olivier',
    });
  });

  it('returns empty strings for an empty input', () => {
    expect(splitFullName('')).toEqual({ title: null, firstName: '', lastName: '' });
  });
});
