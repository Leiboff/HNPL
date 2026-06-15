import Link from 'next/link';

// ─── Dashboard metric card ───────────────────────────────────────────────────
//
// Single signal per card. Optional href turns the whole card into a link
// (the dashboard pattern: every metric drills into the page where you
// act on it). Optional `tone` colours the value to mark alerts.

export type StatCardTone = 'default' | 'good' | 'warn' | 'alert';

const TONE_CLS: Record<StatCardTone, string> = {
  default: 'text-gray-900',
  good:    'text-green-700',
  warn:    'text-amber-700',
  alert:   'text-red-600',
};

const TONE_BORDER: Record<StatCardTone, string> = {
  default: 'border-gray-200',
  good:    'border-gray-200',
  warn:    'border-amber-200',
  alert:   'border-red-200',
};

type Props = {
  label:    string;
  value:    string;
  sublabel?: string;
  tone?:    StatCardTone;
  href?:    string;
};

export default function StatCard({ label, value, sublabel, tone = 'default', href }: Props) {
  const body = (
    <>
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide leading-tight">
        {label}
      </p>
      <p className={`mt-2 text-2xl font-semibold tabular-nums ${TONE_CLS[tone]}`}>{value}</p>
      {sublabel && (
        <p className="mt-1 text-xs text-gray-500 truncate">{sublabel}</p>
      )}
    </>
  );

  const className = `block bg-white border ${TONE_BORDER[tone]} rounded-xl p-4 ${href ? 'hover:shadow-sm hover:border-gray-300 transition-all' : ''}`;

  if (href) return <Link href={href} className={className}>{body}</Link>;
  return <div className={className}>{body}</div>;
}
