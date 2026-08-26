// ─── Split a single "full name" import column into first/last ──────────
//
// Bulk lead imports from directory-style sources (e.g. neighbourhood-only
// practitioner lists) give one "Name" column like "Dr Sunday Joseph
// Aigbodion" rather than separate first/last fields. crm_leads requires
// contact_first_name + contact_last_name (see migration 0069), so we
// split here: strip a leading title, treat the last token as the
// surname, and join everything before it as the given name(s) — this
// keeps double-barrelled/middle names intact in "first name" rather
// than guessing which token is a middle name.

const TITLES = new Set([
  'dr', 'dr.', 'prof', 'prof.', 'professor',
  'mr', 'mr.', 'mrs', 'mrs.', 'ms', 'ms.', 'miss', 'adv', 'adv.',
]);

export type SplitName = {
  title:     string | null;
  firstName: string;
  lastName:  string;
};

export function splitFullName(raw: string): SplitName {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { title: null, firstName: '', lastName: '' };

  let title: string | null = null;
  if (tokens.length > 1 && TITLES.has(tokens[0].toLowerCase())) {
    title = tokens.shift()!;
  }

  // Single remaining token (e.g. "Dr Madonna") — required first/last
  // columns downstream both get it rather than leaving one blank.
  if (tokens.length === 1) return { title, firstName: tokens[0], lastName: tokens[0] };

  const lastName  = tokens[tokens.length - 1];
  const firstName = tokens.slice(0, -1).join(' ');
  return { title, firstName, lastName };
}
