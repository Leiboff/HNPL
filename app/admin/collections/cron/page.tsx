import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import { formatDateTime, timeAgo } from '../../_lib/format';
import { classifyCronHealth, type CronRunRow } from '../../_lib/cronHealth';

// ─── /admin/collections/cron ────────────────────────────────────────────────
//
// Recent cron_runs (job_name='collect-instalments'), most recent
// first. This is where the admin investigates when the dashboard
// cron-health card shows amber or red.

type CronRun = CronRunRow & {
  id:        string;
  job_name:  string;
};

const STATE_PILL: Record<'green' | 'amber' | 'red', string> = {
  green: 'bg-green-100 text-green-700 border-green-200',
  amber: 'bg-amber-100 text-amber-800 border-amber-200',
  red:   'bg-red-100   text-red-700   border-red-200',
};

function StatePill({ state, label }: { state: 'green' | 'amber' | 'red'; label: string }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${STATE_PILL[state]}`}>
      {label}
    </span>
  );
}

function durationMs(started: string, finished: string | null): string {
  if (!finished) return '—';
  const ms = new Date(finished).getTime() - new Date(started).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60000)}m`;
}

export default async function CronRunsPage() {
  const { user, supabase } = await requireConfirmedUser({ next: '/admin/collections/cron' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'admin') {
    if (profile?.role === 'patient')                                                  redirect('/patient');
    else if (profile?.role === 'practice_admin' || profile?.role === 'practice_staff') redirect('/practice');
    else if (profile?.role === 'practice_provider')                                   redirect('/provider');
    else                                                                              redirect('/login');
  }

  const { data: rawRuns } = await supabase
    .from('cron_runs')
    .select('id, job_name, started_at, finished_at, summary')
    .eq('job_name', 'collect-instalments')
    .order('started_at', { ascending: false })
    .limit(50);

  const runs   = (rawRuns ?? []) as CronRun[];
  const health = classifyCronHealth(runs[0] ?? null);

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 py-6 sm:py-8 space-y-6">

      <div className="text-sm">
        <Link href="/admin/collections" className="text-[#15A89E] hover:text-[#13294B]">
          ← Back to collections
        </Link>
      </div>

      <div>
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-xl sm:text-2xl font-semibold text-gray-900">Cron runs — collect-instalments</h1>
          <StatePill state={health.state} label={health.label} />
        </div>
        <p className="mt-1 text-sm text-gray-500">
          Daily at 11:00 UTC = 13:00 SAST. {health.detail}
        </p>
      </div>

      {runs.length === 0 ? (
        <div className="bg-white rounded-2xl border border-amber-200 bg-amber-50 p-8 text-center">
          <p className="font-semibold text-amber-900">No cron runs recorded yet.</p>
          <p className="mt-1 text-sm text-amber-800">
            Either the cron has never fired, or the cron_runs table is empty.
            Trigger a run manually via curl, or wait for the next 11:00 UTC slot.
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {['Started', 'Duration', 'Eligible', 'Charged', 'Claim-lost', 'Transport errors', 'Written off'].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {runs.map((r) => {
                  const s = r.summary ?? {};
                  const txErr   = Number(s.transport_errors  ?? 0);
                  const wOff    = Number(s.written_off_count ?? 0);
                  return (
                    <tr key={r.id} className={(txErr > 0 || wOff > 0) ? 'bg-red-50/40' : ''}>
                      <td className="px-4 py-3 text-gray-800 whitespace-nowrap">
                        <div>{formatDateTime(r.started_at)}</div>
                        <div className="text-xs text-gray-400">{timeAgo(r.started_at)}</div>
                      </td>
                      <td className="px-4 py-3 text-gray-700 tabular-nums">{durationMs(r.started_at, r.finished_at)}</td>
                      <td className="px-4 py-3 tabular-nums">{Number(s.eligible_count   ?? 0)}</td>
                      <td className="px-4 py-3 tabular-nums text-green-700">{Number(s.charged_count    ?? 0)}</td>
                      <td className="px-4 py-3 tabular-nums text-gray-500">{Number(s.claim_lost_count ?? 0)}</td>
                      <td className={`px-4 py-3 tabular-nums ${txErr > 0 ? 'text-red-700 font-semibold' : 'text-gray-500'}`}>{txErr}</td>
                      <td className={`px-4 py-3 tabular-nums ${wOff  > 0 ? 'text-red-700 font-semibold' : 'text-gray-500'}`}>{wOff}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="text-xs text-gray-400">
        Showing the most recent {runs.length} run{runs.length === 1 ? '' : 's'}.
      </p>
    </div>
  );
}
