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

import { sanitizeHtmlAllowList } from '@/lib/html/sanitizeAllowList';

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
// REWRITTEN 2026-09-02 (audit A-08). This used to be a sequence of regex
// deletions — strip these tag names, strip `on*=` attributes, rewrite
// `javascript:` in href/src — and five bypasses were confirmed against it:
//
//   <img/onerror=alert(1) src=x>    `/` separates attributes, and every on*
//                                   pattern required whitespace
//   <svg/onload=alert(1)>           `svg` was not in the tag list at all
//   <a href="j&#97;vascript:…">     the browser decodes entities AFTER the
//                                   regex has run
//   <a href="java&#10;script:…">    browsers strip control characters from a
//                                   scheme; a regex does not
//   <script src=…                   an unterminated tag matched neither the
//                                   paired nor the self-closing pattern and
//                                   passed through verbatim
//
// They are all one bug: a filter written against a simplified grammar,
// deleting from a string the browser will parse with the real one. Adding a
// sixth pattern buys a seventh bypass.
//
// lib/html/sanitizeAllowList.ts parses instead, and serialises a fresh
// document from what it understood — so an input it does not understand
// yields LESS output rather than unfiltered output. See that file's header
// for the full reasoning; the proofs-turned-closures are in
// signature.sanitizer-bypass.adversarial.test.ts.
//
// The allow-list is scoped to what an email signature is, which is why this
// wrapper adds nothing to it: no form controls, no `<link>`, no `<meta>`, no
// `<base>` — those are simply not on it, rather than being named in a list of
// things to remove.

export function sanitizeSignatureHtml(input: string): string {
  return sanitizeHtmlAllowList(input);
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
