export function splitInstalments(
  totalAmountRands: number,
  planType: 2 | 3,
): number[] {
  const totalCents = Math.round(totalAmountRands * 100);
  const baseCents = Math.floor(totalCents / planType);
  const remainderCents = totalCents - baseCents * planType;

  const instalments = Array.from({ length: planType }, (_, i) =>
    i === 0 ? baseCents + remainderCents : baseCents,
  );

  return instalments.map((cents) => Math.round(cents) / 100);
}

export function calculateFee(
  grossAmountRands: number,
  feePercent: number,
): { gross: number; fee: number; net: number } {
  const grossCents = Math.round(grossAmountRands * 100);
  const feeCents = Math.round(grossCents * (feePercent / 100));
  const netCents = grossCents - feeCents;

  return {
    gross: grossCents / 100,
    fee: feeCents / 100,
    net: netCents / 100,
  };
}

function lastDayOfMonth(year: number, month: number): number {
  // month is 0-indexed (Date convention). Day 0 of next month = last day of this month.
  return new Date(year, month + 1, 0).getDate();
}

function clampedSalaryDate(year: number, month: number, salaryDay: number): Date {
  const clamped = Math.min(salaryDay, lastDayOfMonth(year, month));
  return new Date(year, month, clamped);
}

function nextSalaryDate(after: Date, salaryDay: number, bufferDays: number): Date {
  const earliest = new Date(after);
  earliest.setDate(earliest.getDate() + bufferDays);

  const candidate = clampedSalaryDate(after.getFullYear(), after.getMonth(), salaryDay);

  if (candidate >= earliest) {
    return candidate;
  }

  // Move to the following month.
  const nextMonth = after.getMonth() === 11 ? 0 : after.getMonth() + 1;
  const nextYear = after.getMonth() === 11 ? after.getFullYear() + 1 : after.getFullYear();
  return clampedSalaryDate(nextYear, nextMonth, salaryDay);
}

export function calculatePaymentDates(
  startDate: Date,
  salaryDay: number,
  planType: 2 | 3,
  bufferDays = 5,
): Date[] {
  const payment1 = new Date(startDate);

  const payment2 = nextSalaryDate(payment1, salaryDay, bufferDays);

  if (planType === 2) {
    return [payment1, payment2];
  }

  // Payment 3: next salaryDay after payment2, always at least 1 day later so
  // use bufferDays=1 to advance at least one month from payment2's month.
  const payment3Month = payment2.getMonth() === 11 ? 0 : payment2.getMonth() + 1;
  const payment3Year =
    payment2.getMonth() === 11 ? payment2.getFullYear() + 1 : payment2.getFullYear();
  const payment3 = clampedSalaryDate(payment3Year, payment3Month, salaryDay);

  return [payment1, payment2, payment3];
}
