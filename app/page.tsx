import Link from 'next/link';

function CheckIcon() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}

function StepIcon({ n }: { n: 1 | 2 | 3 }) {
  const icons = {
    1: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z" />
      </svg>
    ),
    2: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 9v7.5" />
      </svg>
    ),
    3: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  };
  return icons[n];
}

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-white">

      {/* ── Nav ── */}
      <nav className="border-b border-gray-100">
        <div className="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between">
          <span className="text-xl font-bold tracking-tight" style={{ color: '#0F4C75' }}>
            BetterNow
          </span>
          <Link
            href="/login"
            className="text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors"
          >
            Sign in
          </Link>
        </div>
      </nav>

      {/* ── Hero ── */}
      <section className="mx-auto max-w-6xl px-6 py-20 text-center">
        <h1 className="text-5xl font-bold tracking-tight text-gray-900 leading-tight">
          BetterNow,{' '}
          <span style={{ color: '#0F4C75' }}>Pay Later.</span>
        </h1>
        <p className="mt-5 text-xl text-gray-500 max-w-2xl mx-auto leading-relaxed">
          Interest-free payment plans for your patients.
          <br />
          You get paid upfront — we handle the rest.
        </p>

        <div className="mt-10 flex flex-col sm:flex-row gap-4 justify-center">
          <Link
            href="/signup/practice"
            className="inline-flex items-center justify-center rounded-xl px-7 py-3.5 text-base font-semibold text-white shadow-sm transition-colors"
            style={{ backgroundColor: '#0F4C75' }}
          >
            Get started as a practice
          </Link>
          <Link
            href="/signup/patient"
            className="inline-flex items-center justify-center rounded-xl border border-gray-300 bg-white px-7 py-3.5 text-base font-semibold text-gray-700 hover:bg-gray-50 transition-colors"
          >
            I&apos;m a patient
          </Link>
        </div>
      </section>

      {/* ── How it works ── */}
      <section className="bg-gray-50 border-y border-gray-100 py-20">
        <div className="mx-auto max-w-6xl px-6">
          <h2 className="text-center text-2xl font-bold text-gray-900 mb-14">
            How it works
          </h2>
          <div className="grid gap-10 md:grid-cols-3">
            {[
              {
                n: 1 as const,
                title: 'Record the bill',
                body: 'Your practice records the patient\'s bill in seconds — no paperwork, no portals.',
              },
              {
                n: 2 as const,
                title: 'Patient pays over time',
                body: 'They split into 2 or 3 interest-free instalments, scheduled around their salary date.',
              },
              {
                n: 3 as const,
                title: 'You get paid upfront',
                body: 'Receive 94% within days. We collect the remaining instalments — your risk is zero.',
              },
            ].map(({ n, title, body }) => (
              <div key={n} className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 text-center">
                <div
                  className="inline-flex items-center justify-center w-12 h-12 rounded-full mb-5"
                  style={{ backgroundColor: '#E8F1F8', color: '#0F4C75' }}
                >
                  <StepIcon n={n} />
                </div>
                <div
                  className="text-xs font-semibold uppercase tracking-widest mb-2"
                  style={{ color: '#0F4C75' }}
                >
                  Step {n}
                </div>
                <h3 className="text-lg font-semibold text-gray-900 mb-2">{title}</h3>
                <p className="text-sm text-gray-500 leading-relaxed">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Trust bar ── */}
      <section className="py-10 border-b border-gray-100">
        <div className="mx-auto max-w-6xl px-6">
          <ul className="flex flex-wrap items-center justify-center gap-8 text-sm font-medium text-gray-500">
            {['Secure payments', 'Interest-free', 'No paperwork', 'SA-built'].map((item) => (
              <li key={item} className="flex items-center gap-2">
                <span style={{ color: '#0F4C75' }}>
                  <CheckIcon />
                </span>
                {item}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="py-8 text-center text-sm text-gray-400">
        BetterNow &copy; 2026
      </footer>
    </div>
  );
}
