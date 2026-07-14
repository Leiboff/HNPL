// ─── Email template merge-field substitution ─────────────────────────
//
// Pure function. Given a template string with {{practice_name}},
// {{contact_first_name}}, {{my_name}} placeholders, substitute the
// values from `vars`. Unknown placeholders are left intact (visible in
// the preview so the sender notices).
//
// No HTML injection worry — the compose sheet sends plain text; the
// substituted values are the sender's own inputs plus lead fields
// they can already see. If we ever add HTML compose, escape at the
// render boundary, not here.

export type MergeVars = {
  practice_name?:       string | null;
  contact_first_name?:  string | null;
  contact_last_name?:   string | null;
  my_name?:             string | null;
};

const RE = /\{\{\s*(practice_name|contact_first_name|contact_last_name|my_name)\s*\}\}/g;

export function substituteMergeFields(template: string, vars: MergeVars): string {
  return template.replace(RE, (_match, key: keyof MergeVars) => {
    const v = vars[key];
    if (v == null || v === '') return `{{${key}}}`;   // leave visible when missing
    return String(v);
  });
}
