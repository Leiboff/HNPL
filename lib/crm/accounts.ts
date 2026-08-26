// ─── Accounts view aggregation — pure functions ───────────────────────
//
// Converted practices: actual trailing-30-day billings (from collected
// payments), days since last bill, estimate vs actual, and a "signed
// but no bill in 30 days" attention flag. Read-only by construction —
// this module never writes anything; the page that calls it only
// SELECTs.

export type AccountLead = {
  id: string;
  practice_name: string;
  estimated_monthly_billings: number | null;
  converted_practice_id: string;
};

export type AccountPractice = {
  id: string;
  name: string;
  status: string | null;
  approved_at: string | null;
};

export type AccountPlan = { id: string; practice_id: string };

export type AccountPayment = {
  plan_id: string;
  amount: number;
  status: string;
  collected_at: string | null;
};

export type AccountRow = {
  leadId: string;
  practiceId: string;
  practiceName: string;
  estimate: number | null;
  actual30d: number;
  lastBillAt: string | null;
  daysSinceLastBill: number | null;
  needsAttention: boolean; // signed/converted but no bill collected in the trailing 30 days
};

const ATTENTION_WINDOW_DAYS = 30;

export function computeAccountRows(
  leads: AccountLead[],
  practices: AccountPractice[],
  plans: AccountPlan[],
  payments: AccountPayment[],
  now: Date,
): AccountRow[] {
  const practiceById = new Map(practices.map(p => [p.id, p]));
  const planIdsByPractice = new Map<string, string[]>();
  for (const plan of plans) {
    const list = planIdsByPractice.get(plan.practice_id) ?? [];
    list.push(plan.id);
    planIdsByPractice.set(plan.practice_id, list);
  }
  const collectedByPlan = new Map<string, AccountPayment[]>();
  for (const p of payments) {
    if (p.status !== 'collected' || !p.collected_at) continue;
    const list = collectedByPlan.get(p.plan_id) ?? [];
    list.push(p);
    collectedByPlan.set(p.plan_id, list);
  }

  const windowStart = new Date(now.getTime() - ATTENTION_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  return leads
    .filter(l => practiceById.has(l.converted_practice_id))
    .map((l) => {
      const practice = practiceById.get(l.converted_practice_id)!;
      const planIds = planIdsByPractice.get(practice.id) ?? [];
      const collected = planIds.flatMap(pid => collectedByPlan.get(pid) ?? []);

      let actual30d = 0;
      let lastBillAt: string | null = null;
      for (const pay of collected) {
        const collectedAt = new Date(pay.collected_at!);
        if (collectedAt >= windowStart && collectedAt <= now) actual30d += pay.amount;
        if (!lastBillAt || collectedAt > new Date(lastBillAt)) lastBillAt = pay.collected_at;
      }

      const daysSinceLastBill = lastBillAt
        ? Math.floor((now.getTime() - new Date(lastBillAt).getTime()) / (24 * 60 * 60 * 1000))
        : null;

      return {
        leadId: l.id,
        practiceId: practice.id,
        practiceName: practice.name,
        estimate: l.estimated_monthly_billings,
        actual30d,
        lastBillAt,
        daysSinceLastBill,
        needsAttention: daysSinceLastBill === null || daysSinceLastBill > ATTENTION_WINDOW_DAYS,
      };
    });
}
