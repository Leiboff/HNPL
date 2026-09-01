import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── What the new-lead form compels, and what it does not ─────────────
//
// Product rule: a sales rep must supply the practice name, an address
// and a contact number. Everything else — including the contact's name —
// is optional, because cold-sourced leads arrive as "the practice on
// Oxford Rd, here's their number" and refusing to record one loses the
// lead rather than improving it.
//
// Source pins: the form's affordance and the server action's guarantee
// have to agree, or the form promises something the action rejects.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const FORM = read('app/crm/leads/new/NewLeadForm.tsx');
const ACT  = read('app/crm/leads/actions.ts');

describe('the form marks exactly the three compulsory fields', () => {
  it('practice name, address and phone are marked required', () => {
    expect(FORM).toMatch(/<Field label="Practice name" required>/);
    expect(FORM).toMatch(/<Field label="Address" required>/);
    expect(FORM).toMatch(/<Field label="Phone" required>/);
  });

  it('the contact name fields are NOT marked required', () => {
    expect(FORM).toMatch(/<Field label="Contact first name">/);
    expect(FORM).toMatch(/<Field label="Contact last name">/);
    // …and carry no native constraint either.
    expect(FORM).not.toMatch(/<input required value=\{f\.contact_first_name\}/);
    expect(FORM).not.toMatch(/<input required value=\{f\.contact_last_name\}/);
  });

  it('nothing else is marked required', () => {
    const required = Array.from(FORM.matchAll(/<Field label="([^"]+)"[^>]*\brequired\b/g)).map(m => m[1]);
    expect(required.sort()).toEqual(['Address', 'Phone', 'Practice name']);
  });
});

describe('the address requirement is enforced where the browser cannot', () => {
  it('the submit handler guards it, because a picked place is not an input', () => {
    // PlacesAutocomplete reports a place only once it is chosen from the
    // dropdown, so `required` on a text input would not cover it.
    expect(FORM).toMatch(/if \(!f\.formatted_address\.trim\(\)\)/);
    expect(FORM).toMatch(/if \(!f\.phone\.trim\(\)\)/);
    expect(FORM).toMatch(/if \(!f\.practice_name\.trim\(\)\)/);
  });
});

describe('createLead enforces the same three, server-side', () => {
  it('rejects a missing practice name, phone, or address', () => {
    expect(ACT).toMatch(/if \(!input\.practice_name\?\.trim\(\)\) return \{ error: 'Practice name is required\.' \}/);
    expect(ACT).toMatch(/if \(!input\.phone\?\.trim\(\)\)\s+return \{ error: 'A contact number is required\.' \}/);
    expect(ACT).toMatch(/!input\.formatted_address\?\.trim\(\) && !input\.street_address\?\.trim\(\)/);
  });

  it('no longer rejects a lead for having no contact name', () => {
    expect(ACT).not.toMatch(/Contact first name is required/);
    expect(ACT).not.toMatch(/Contact last name is required/);
  });

  it('stores an absent contact name as empty string, keeping the columns NOT NULL', () => {
    // crm_leads.contact_first_name/last_name are NOT NULL (0069), and so
    // are first_name/last_name on the primary contact the insert trigger
    // seeds from them (0075). '' satisfies both without widening every
    // consumer's type to string | null.
    expect(ACT).toMatch(/contact_first_name:\s*input\.contact_first_name\?\.trim\(\) \?\? ''/);
    expect(ACT).toMatch(/contact_last_name:\s*input\.contact_last_name\?\.trim\(\)\s*\?\? ''/);
  });
});

describe('a nameless lead still renders', () => {
  it('every surface that shows a contact name goes through contactDisplayName', () => {
    for (const f of [
      'app/crm/page.tsx',
      'app/crm/leads/LeadsResultsList.tsx',
      'app/crm/leads/[id]/ContactsCard.tsx',
    ]) {
      const src = read(f);
      expect(src).toMatch(/from ['"]@\/lib\/crm\/nameSplit['"]/);
      // No raw `{x.first_name} {x.last_name}` left to print a lone space.
      expect(src).not.toMatch(/\{\w+\.contact_first_name\}\s+\{\w+\.contact_last_name\}/);
      expect(src).not.toMatch(/\{c\.first_name\}\s+\{c\.last_name\}/);
    }
  });
});

describe('the specialty dropdown prompts rather than saying "(none)"', () => {
  it('the placeholder reads "Select"', () => {
    expect(FORM).toMatch(/<SpecialtyOptions placeholder="Select" \/>/);
    expect(FORM).not.toMatch(/placeholder="\(none\)"/);
  });
});
