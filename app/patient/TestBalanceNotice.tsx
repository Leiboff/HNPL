// ─── Test-balance notice — shared, non-dismissable ────────────────────
//
// ─── WHEN THIS RENDERS, AND WHY IT IS CONDITIONAL NOW ──────────────────
//
// It used to render beside EVERY balance, because every balance was a
// stubbed R5,000 grant with no assessment behind it. That is no longer
// true: a limit produced by the assessment pipeline is a real
// affordability decision, and telling that patient "no credit or
// affordability assessment has been performed" would be a false statement
// on a money surface.
//
// It is not simply deleted either, because limits granted by the old stub
// still exist on real accounts and are still exactly what this notice
// says they are.
//
// So the callers render it only when the limit has NO backing assessment
// — `profiles.current_credit_assessment_id IS NULL`. That marker is
// written by the pipeline and by nothing else, so the notice retires
// itself account by account as patients are re-assessed, with no flag to
// remember to flip.
//
// Still a plain server component with NO dismiss control and NO client
// state: where it applies, there is no way for a patient to hide it.

export default function TestBalanceNotice() {
  return (
    <div
      role="note"
      data-testid="test-balance-notice"
      className="rounded-xl px-4 py-3 text-[12.5px] leading-[1.5]"
      style={{ background: 'rgba(180,35,24,.06)', border: '1px solid rgba(180,35,24,.25)', color: '#8A2B22' }}
    >
      <span className="font-semibold">Test balance — not real credit.</span>{' '}
      This amount is for testing only. No credit or affordability assessment has been
      performed, and it cannot be used to make real payments.
    </div>
  );
}
