// ─── Test-balance notice — shared, non-dismissable ────────────────────
//
// The approved balance shown to patients is a STUBBED test grant (see
// lib/underwriting/stubAffordabilityPolicy), not real credit and not the
// result of any affordability assessment. Anywhere the balance is shown,
// this notice MUST accompany it — so it lives in one shared component
// that every balance surface renders, rather than copy-pasted markup that
// could be shown in one place and forgotten in another.
//
// It is deliberately a plain server component with NO dismiss control and
// NO client state: there is no way for a patient to hide it. It renders
// unconditionally whenever it is mounted; callers mount it exactly when a
// balance is displayed.

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
