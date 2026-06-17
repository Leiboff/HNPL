export type PatientRef  = { first_name: string; last_name: string };
export type ProviderRef = { first_name: string; last_name: string };
export type PayoutRef   = { net_amount: number; status: string };

// Embedded invitation row joined into the plans query. Plans that were
// created against an existing patient (Scenario A) have no invitation —
// the field is null. Plans created for a new patient email (Scenario B)
// carry these timestamps so the lifecycle chip can render "Sent" vs
// "Viewed" vs "Expired" correctly.
export type InvitationRef = {
  viewed_at:   string | null;
  accepted_at: string | null;
  expires_at:  string | null;
};

export type PlanSummary = {
  id: string;
  total_amount: number;
  status: string;
  created_at: string;
  invoice_number: string | null;
  practice_reference: string | null;
  provider_id: string | null;
  patient:  PatientRef  | PatientRef[]  | null;
  provider: ProviderRef | ProviderRef[] | null;
  payouts:  PayoutRef   | PayoutRef[]   | null;
  invitations?: InvitationRef | InvitationRef[] | null;
};

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'] as const;

export function formatRand(amount: number): string {
  const [integer, decimal] = amount.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

export function formatDate(isoStr: string): string {
  const d = new Date(isoStr);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

// Safe formatter for YYYY-MM-DD strings from date inputs (avoids UTC offset shifting)
export function formatLocalDate(yyyymmdd: string): string {
  const [y, m, d] = yyyymmdd.split('-');
  return `${parseInt(d, 10)} ${MONTHS[parseInt(m, 10) - 1]} ${y}`;
}

export function patientDisplay(plan: PlanSummary): string {
  const p = Array.isArray(plan.patient) ? plan.patient[0] : plan.patient;
  if (!p) return '—';
  return `${p.first_name} ${p.last_name.charAt(0).toUpperCase()}.`;
}

export function providerName(plan: PlanSummary): string {
  const p = Array.isArray(plan.provider) ? plan.provider[0] : plan.provider;
  if (!p) return '—';
  return `${p.first_name} ${p.last_name}`;
}

export function getPayout(plan: PlanSummary): PayoutRef | null {
  if (!plan.payouts) return null;
  return Array.isArray(plan.payouts) ? (plan.payouts[0] ?? null) : plan.payouts;
}

export function getInvitation(plan: PlanSummary): InvitationRef | null {
  if (!plan.invitations) return null;
  return Array.isArray(plan.invitations) ? (plan.invitations[0] ?? null) : plan.invitations;
}

export function doctorStatus(status: string): { label: string; cls: string } {
  switch (status) {
    case 'pending_acceptance': return { label: 'Awaiting patient', cls: 'bg-amber-100 text-amber-800' };
    case 'active':             return { label: 'Accepted',         cls: 'bg-green-100 text-green-700' };
    case 'completed':          return { label: 'Accepted',         cls: 'bg-green-100 text-green-700' };
    case 'defaulted':          return { label: 'Accepted',         cls: 'bg-green-100 text-green-700' };
    case 'declined':           return { label: 'Declined',         cls: 'bg-red-100 text-red-700'    };
    case 'cancelled':          return { label: 'Cancelled',        cls: 'bg-gray-100 text-gray-400'  };
    default:                   return { label: status,             cls: 'bg-gray-100 text-gray-600'  };
  }
}
