// ─── Company signature — CRM-managed, not Gmail-fetched ───────────
//
// Deliberate design: we do NOT add gmail.settings.readonly. Signatures
// live IN the CRM (crm_signatures table) so the company controls
// brand consistency across every sender. Two shapes:
//
//   1. Structured fields — display_name, title, phone, email —
//      merged into the brand HTML template below.
//
//   2. Raw HTML override — power users can paste HTML. It's
//      sanitised at write-time (scripts/event-handlers stripped)
//      and stored verbatim thereafter.
//
// Plain-text fallback is either supplied or derived by stripping the
// HTML — used for the text/plain MIME part.

export type SignatureData = {
  displayName: string;
  title:       string;
  phone:       string;
  email:       string;
};

// ── Brand template ───────────────────────────────────────────────

/**
 * betternow signature template. Email-safe inline styles, a table
 * layout with a teal vertical rule, wordmark ("better" #13294B +
 * "now" #15A89E), and E./P./W. contact lines with teal markers.
 *
 * All values in `vars` are HTML-escaped before substitution.
 */
export function renderBrandSignatureHtml(vars: SignatureData): string {
  const displayName = escapeHtml(vars.displayName || '');
  const title       = escapeHtml(vars.title       || '');
  const phone       = escapeHtml(vars.phone       || '');
  const email       = escapeHtml(vars.email       || '');
  const phoneHref   = escapeHtml((vars.phone || '').replace(/[^\d+]/g, ''));
  const emailHref   = escapeHtml(vars.email || '');

  return [
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" ',
    'style="font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Arial, sans-serif; ',
    'color: #13294B; font-size: 13px; line-height: 1.45; margin-top: 18px;">',
    '<tr>',
    // Left column — wordmark
    '<td valign="top" style="padding-right: 16px; border-right: 2px solid #15A89E;">',
    '<div style="font-size: 20px; font-weight: 700; letter-spacing: -0.5px;">',
    '<span style="color:#13294B;">better</span><span style="color:#15A89E;">now</span>',
    '</div>',
    '</td>',
    // Right column — contact card
    '<td valign="top" style="padding-left: 16px;">',
    displayName ? `<div style="font-weight: 600; color: #13294B;">${displayName}</div>` : '',
    title       ? `<div style="color: #13294B; opacity: 0.75;">${title}</div>`        : '',
    (phone || email) ? '<div style="margin-top: 6px; color: #13294B; opacity: 0.85;">' : '',
      phone ? `<div><span style="color:#15A89E; font-weight:700; margin-right:6px;">P.</span><a href="tel:${phoneHref}" style="color:#13294B; text-decoration:none;">${phone}</a></div>` : '',
      email ? `<div><span style="color:#15A89E; font-weight:700; margin-right:6px;">E.</span><a href="mailto:${emailHref}" style="color:#13294B; text-decoration:none;">${email}</a></div>` : '',
      '<div><span style="color:#15A89E; font-weight:700; margin-right:6px;">W.</span><a href="https://betternow.co.za" style="color:#13294B; text-decoration:none;">betternow.co.za</a></div>',
    (phone || email) ? '</div>' : '',
    '</td>',
    '</tr>',
    '</table>',
  ].filter(Boolean).join('');
}

export function renderBrandSignatureText(vars: SignatureData): string {
  const lines = ['—', 'betternow'];
  if (vars.displayName) lines.push(vars.displayName);
  if (vars.title)       lines.push(vars.title);
  if (vars.phone)       lines.push(`P. ${vars.phone}`);
  if (vars.email)       lines.push(`E. ${vars.email}`);
  lines.push('W. betternow.co.za');
  return lines.join('\n');
}

// ── HTML escape ──────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Sanitiser for user-supplied HTML override ────────────────────
//
// Not a full DOMPurify — dependency-free strip of the dangerous
// primitives an email-signature editor would ever accept:
//   • <script>, <style>, <iframe>, <object>, <embed>, <link>,
//     <meta>, <base> tag pairs (contents removed)
//   • ALL event-handler attributes (on*="…")
//   • javascript: / vbscript: / data: URLs on any href/src/action
//
// We keep formatting tags (b/i/u/strong/em/br/p/div/span/table/…),
// inline styles, and standard link/image tags — signatures need HTML
// to render at all.

const BAD_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'input', 'button', 'select', 'textarea'];

export function sanitizeSignatureHtml(input: string): string {
  if (!input) return '';

  let out = input;

  // Strip <TAG …>…</TAG> pairs AND self-closing variants for each bad tag.
  for (const tag of BAD_TAGS) {
    const paired = new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi');
    out = out.replace(paired, '');
    const self  = new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi');
    out = out.replace(self, '');
  }

  // Strip event-handler attributes (on*).
  out = out.replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, '');
  out = out.replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, '');
  out = out.replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, '');

  // Neutralise javascript:, vbscript:, data: URLs on href/src/action.
  out = out.replace(
    /(\s(?:href|src|action|formaction)\s*=\s*["'])\s*(?:javascript|vbscript|data):[^"']*(["'])/gi,
    '$1#$2',
  );

  return out.trim();
}

// ── Merge fields on a signature body ─────────────────────────────

/**
 * Apply signature-scoped merge fields against a template body/
 * override. Substitution is HTML-escaped for structured fields; on
 * the raw-HTML path the writer sanitised the payload already.
 */
export function applySignatureMergeFields(
  template: string,
  vars: SignatureData,
): string {
  return template
    .replace(/\{\{\s*display_name\s*\}\}/g, escapeHtml(vars.displayName))
    .replace(/\{\{\s*title\s*\}\}/g,        escapeHtml(vars.title))
    .replace(/\{\{\s*phone\s*\}\}/g,        escapeHtml(vars.phone))
    .replace(/\{\{\s*email\s*\}\}/g,        escapeHtml(vars.email));
}

// ── Attach a signature to a composed email ───────────────────────

/**
 * Compose the final HTML + text bodies from a raw plain-text body and
 * a signature. Adds a divider on the text side and appends the HTML
 * signature after a <br> break on the HTML side.
 *
 * When omit=true we return the raw body unchanged (empty html) — the
 * caller then sends the message text-only.
 */
export function composeWithSignature(input: {
  bodyText:       string;
  signatureHtml:  string;
  signatureText:  string;
  omitSignature?: boolean;
}): { bodyText: string; bodyHtml: string } {
  const { bodyText, signatureHtml, signatureText, omitSignature } = input;
  if (omitSignature) {
    return { bodyText, bodyHtml: '' };
  }
  const escapedBody = escapeHtml(bodyText).replace(/\r?\n/g, '<br>');
  const html = `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; color:#13294B; font-size:14px; line-height:1.55;">${escapedBody}</div>${signatureHtml || ''}`;
  const text = `${bodyText}\n\n${signatureText || ''}`.trim();
  return { bodyText: text, bodyHtml: html };
}
