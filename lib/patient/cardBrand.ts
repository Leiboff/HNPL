// ─── Single source of truth for the short card-brand chip label ─────────
//
// Card-brand chips were rendered ad hoc: one surface matched the stored
// brand case-sensitively (`brand === 'Visa'`) and fell back to
// `brand.slice(0,2)` → "VI" when the DB actually stored "VISA"; another did
// `brand.toUpperCase().slice(0,4)` → "VISA". Same card, two labels. This
// normalises case and maps to one short label every chip uses.

export function cardBrandLabel(brand: string | null | undefined): string {
  const b = (brand ?? '').trim().toUpperCase();
  if (!b) return 'CARD';
  if (b.includes('VISA')) return 'VISA';
  if (b.includes('MASTER')) return 'MC';
  if (b.includes('AMEX') || b.includes('AMERICAN')) return 'AMEX';
  return b.slice(0, 4);
}

/** Brand → chip background (case-insensitive). Neutral navy→teal default. */
export function cardBrandGradient(brand: string | null | undefined): string {
  const b = (brand ?? '').trim().toUpperCase();
  if (b.includes('VISA'))   return 'linear-gradient(135deg,#1a1f71,#4361ee)';
  if (b.includes('MASTER')) return 'linear-gradient(135deg,#eb001b,#ff5f00)';
  return 'linear-gradient(135deg,#13294B,#15A89E)';
}
