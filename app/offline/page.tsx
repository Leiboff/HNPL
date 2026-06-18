// ─── /offline ────────────────────────────────────────────────────────────
//
// The standalone page the service worker pre-caches and serves as the
// navigation fallback when the device is offline. Calm, on-brand, no
// fake "retry" button that lies about whether the network is back —
// the browser's own reload is the honest action.
//
// Statically rendered: no auth, no data, no client JS. Must work cold
// from the SW cache without contacting the server, which means it
// CANNOT depend on cookies, headers, or fetched data.

export const dynamic = 'force-static';

export const metadata = {
  title: 'Offline · BetterNow',
};

export default function OfflinePage() {
  return (
    <div className="min-h-screen bg-[#FAFBFD] flex items-center justify-center px-5 py-12">
      <div className="w-full max-w-sm rounded-[20px] bg-white border border-[#E5E9F0] p-8 text-center shadow-[0_1px_2px_rgba(15,31,58,0.04)]">
        <div className="w-14 h-14 mx-auto rounded-full bg-[radial-gradient(circle_at_30%_25%,#15A89E22,#13294B14_70%)] ring-1 ring-[#13294B]/10 flex items-center justify-center text-[#13294B]">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
            {/* A WiFi-with-slash mark. Calm, immediately legible as
                "no connection" without being alarming. */}
            <path d="M5 12.5a10 10 0 0 1 14 0" strokeLinecap="round" />
            <path d="M8.5 16a5 5 0 0 1 7 0" strokeLinecap="round" />
            <circle cx="12" cy="19" r="0.75" fill="currentColor" stroke="none" />
            <path d="m4 4 16 16" strokeLinecap="round" />
          </svg>
        </div>

        <h1 className="mt-5 text-2xl font-semibold tracking-[-0.01em] text-[#0F1F3A]">
          You&apos;re offline
        </h1>
        <p className="mt-2 text-[15px] leading-relaxed text-[#3A4B66]">
          BetterNow needs a connection for anything that touches your account or a payment.
        </p>
        <p className="mt-4 text-sm text-[#7A8AA0]">
          When you&apos;re back online, reopen the app — your plan and payments will be there.
        </p>
      </div>
    </div>
  );
}
