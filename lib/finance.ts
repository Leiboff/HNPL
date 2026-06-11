import { clampSalaryDateForMonth } from './salaryDates';

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

function nextSalaryDate(after: Date, salaryDay: number, bufferDays: number): Date {
  // All arithmetic in UTC — 'after' is always a UTC-midnight Date here.
  const earliest = new Date(Date.UTC(
    after.getUTCFullYear(),
    after.getUTCMonth(),
    after.getUTCDate() + bufferDays,   // JS handles month overflow automatically
  ));

  const candidate = clampSalaryDateForMonth(after.getUTCFullYear(), after.getUTCMonth(), salaryDay);

  if (candidate >= earliest) {
    return candidate;
  }

  // Move to the following month.
  const nextMonth = after.getUTCMonth() === 11 ? 0 : after.getUTCMonth() + 1;
  const nextYear  = after.getUTCMonth() === 11 ? after.getUTCFullYear() + 1 : after.getUTCFullYear();
  return clampSalaryDateForMonth(nextYear, nextMonth, salaryDay);
}

export function calculatePaymentDates(
  startDate: Date,
  salaryDay: number,
  planType: 2 | 3,
  bufferDays = 5,
): Date[] {
  // Normalize to UTC midnight of startDate's UTC calendar date. Without this,
  // a mid-day live timestamp serialises correctly by luck; a local-midnight Date
  // on UTC+2 would shift back one day via .toISOString().
  const payment1 = new Date(Date.UTC(
    startDate.getUTCFullYear(),
    startDate.getUTCMonth(),
    startDate.getUTCDate(),
  ));

  const payment2 = nextSalaryDate(payment1, salaryDay, bufferDays);

  if (planType === 2) {
    return [payment1, payment2];
  }

  // Payment 3: hard-advance to the month after payment2's UTC month.
  const payment3Month = payment2.getUTCMonth() === 11 ? 0 : payment2.getUTCMonth() + 1;
  const payment3Year  = payment2.getUTCMonth() === 11 ? payment2.getUTCFullYear() + 1 : payment2.getUTCFullYear();
  const payment3      = clampSalaryDateForMonth(payment3Year, payment3Month, salaryDay);

  return [payment1, payment2, payment3];
}
