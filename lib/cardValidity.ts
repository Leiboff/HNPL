// month parameters here are 1-indexed (1 = January, 12 = December).

export function lastDayOfMonth(year: number, month: number): Date {
  // Passing day=0 to the Date constructor yields the last day of the preceding
  // month (JS months are 0-indexed). Because our month is 1-indexed, passing it
  // directly gives us the correct result: new Date(y, 6, 0) → 30 Jun, etc.
  const d = new Date(year, month, 0);
  d.setHours(23, 59, 59, 999);
  return d;
}

export function cardExpiryDate(expMonth: number, expYear: number): Date {
  return lastDayOfMonth(expYear, expMonth);
}

export function isCardValidForPlan(
  card: { exp_month: number; exp_year: number },
  lastInstalmentDate: Date,
  bufferDays = 30,
): boolean {
  const expiry   = cardExpiryDate(card.exp_month, card.exp_year);
  const deadline = new Date(lastInstalmentDate.getTime() + bufferDays * 24 * 60 * 60 * 1000);
  return expiry.getTime() >= deadline.getTime();
}
