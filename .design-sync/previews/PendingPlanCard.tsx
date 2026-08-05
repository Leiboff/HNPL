import { PendingPlanCard } from 'hnpl';

const declineNoop = async () => ({ error: null });

export function Default() {
  return (
    <div style={{ maxWidth: 500, padding: 20 }}>
      <PendingPlanCard
        planId="demo-plan"
        totalAmount={3600}
        practiceName="Rondebosch Dental Studio"
        invoiceNumber="INV-2043"
        practiceReference="Acc 88120"
        declinePlan={declineNoop}
      />
    </div>
  );
}
