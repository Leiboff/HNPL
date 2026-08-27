import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  hashHpcsaNumber, groupContactsByHpcsa, findOtherLeadsForContact, hasOnboardedPractitionerMatch,
  type ContactWithHpcsa,
} from './hpcsa';

describe('hashHpcsaNumber', () => {
  it('matches md5(lower(trim(x))) — the exact 0064 normalisation', () => {
    const expected = createHash('md5').update('mp1234567'.toLowerCase()).digest('hex');
    expect(hashHpcsaNumber('  MP1234567  ')).toBe(expected);
  });

  it('is case- and whitespace-insensitive (two variants of the same number hash identically)', () => {
    expect(hashHpcsaNumber('MP1234567')).toBe(hashHpcsaNumber(' mp1234567 '));
  });

  it('returns null for null, undefined, and blank input', () => {
    expect(hashHpcsaNumber(null)).toBeNull();
    expect(hashHpcsaNumber(undefined)).toBeNull();
    expect(hashHpcsaNumber('   ')).toBeNull();
    expect(hashHpcsaNumber('')).toBeNull();
  });
});

function contact(id: string, lead_id: string, hpcsa_group_key: string | null): ContactWithHpcsa {
  return { id, lead_id, hpcsa_group_key };
}

describe('groupContactsByHpcsa', () => {
  it('groups one contact across two leads under the same key', () => {
    const key = hashHpcsaNumber('MP1234567')!;
    const contacts = [
      contact('c1', 'lead-A', key),
      contact('c2', 'lead-B', key),
      contact('c3', 'lead-C', 'other-key'),
    ];
    const groups = groupContactsByHpcsa(contacts);
    expect(groups.get(key)?.map(c => c.lead_id).sort()).toEqual(['lead-A', 'lead-B']);
  });

  it('a NULL hpcsa_group_key never appears as a group — but the contact is not otherwise hidden by this function', () => {
    const contacts = [contact('c1', 'lead-A', null), contact('c2', 'lead-B', null)];
    const groups = groupContactsByHpcsa(contacts);
    expect(groups.size).toBe(0);
  });
});

describe('findOtherLeadsForContact', () => {
  const key = hashHpcsaNumber('MP1234567')!;

  it('finds the other lead(s) the same practitioner appears at', () => {
    const all = [contact('c1', 'lead-A', key), contact('c2', 'lead-B', key), contact('c3', 'lead-C', key)];
    expect(findOtherLeadsForContact(all[0], all).sort()).toEqual(['lead-B', 'lead-C']);
  });

  it('excludes the contact\'s own lead even if it has multiple contacts with the same key', () => {
    const all = [contact('c1', 'lead-A', key), contact('c1b', 'lead-A', key)];
    expect(findOtherLeadsForContact(all[0], all)).toEqual([]);
  });

  it('returns empty for a contact with no hpcsa_group_key (never hidden, just has no cross-practice signal)', () => {
    const c = contact('c1', 'lead-A', null);
    expect(findOtherLeadsForContact(c, [c, contact('c2', 'lead-B', null)])).toEqual([]);
  });
});

describe('hasOnboardedPractitionerMatch — the high-conversion saved-view signal', () => {
  const key = hashHpcsaNumber('MP1234567')!;
  const onboardedKeys = new Set([key]);

  it('true for a new/contacted/nurture lead with a matching contact', () => {
    for (const stage of ['new', 'contacted', 'nurture']) {
      expect(hasOnboardedPractitionerMatch(stage, [contact('c1', 'lead-X', key)], onboardedKeys)).toBe(true);
    }
  });

  it('false for stages outside new/contacted/nurture even with a match', () => {
    for (const stage of ['meeting_scheduled', 'demo_done', 'agreement_sent', 'signed', 'onboarded', 'lost']) {
      expect(hasOnboardedPractitionerMatch(stage, [contact('c1', 'lead-X', key)], onboardedKeys)).toBe(false);
    }
  });

  it('false when no contact key is in the onboarded set', () => {
    expect(hasOnboardedPractitionerMatch('new', [contact('c1', 'lead-X', 'unmatched-key')], onboardedKeys)).toBe(false);
  });

  it('a NULL hpcsa_group_key contact never contributes a false match', () => {
    expect(hasOnboardedPractitionerMatch('new', [contact('c1', 'lead-X', null)], onboardedKeys)).toBe(false);
  });
});
