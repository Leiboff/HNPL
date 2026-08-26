import { redirect } from 'next/navigation';
import Link from 'next/link';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import { bucketFollowups } from '@/lib/crm/followups';
import { sastDayWindows } from '@/lib/crm/timezone';
import { weightedPipelineValue, hasEnoughData } from '@/lib/crm/pipeline';
import { formatRand } from '@/app/admin/_lib/format';

// ─── /crm — My Day (default landing) ─────────────────────────────────
//
// Three buckets: overdue (red), today, upcoming (7 days). Also shows a
// metrics strip: leads by stage, conversion rate, activities logged
// this week, overdue follow-up count.
//
// Belt-and-braces role check per crm-routes-auth.test.ts pin (mirrors
// admin-routes-auth.test.ts).

const STAGES = [
  'new', 'contacted', 'meeting_scheduled', 'demo_done',
  'agreement_sent', 'signed', 'onboarded', 'lost',
] as const;

export default async function CrmHomePage() {
  const { user, supabase } = await requireConfirmedUser({ next: '/crm' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'sales' && profile?.role !== 'admin') {
    if (profile?.role === 'patient')                                                  redirect('/patient');
    else if (profile?.role === 'practice_admin' || profile?.role === 'practice_staff') redirect('/practice');
    else if (profile?.role === 'practice_provider')                                   redirect('/provider');
    else                                                                              redirect('/login');
  }

  const now = new Date();
  const { upcomingEndUtc } = sastDayWindows(now);

  const { data: rawLeads } = await supabase
    .from('crm_leads')
    .select('id, practice_name, stage, next_follow_up_at, owner_user_id')
    .is('archived_at', null)
    .not('next_follow_up_at', 'is', null)
    .lt('next_follow_up_at', upcomingEndUtc.toISOString())
    .order('next_follow_up_at', { ascending: true })
    .limit(200);

  const buckets = bucketFollowups(
    (rawLeads ?? []).map(l => ({
      id: l.id,
      next_follow_up_at: l.next_follow_up_at,
      stage: l.stage,
      practice_name: l.practice_name,
    })),
    now,
  );

  // Metrics strip
  const { data: allStages } = await supabase
    .from('crm_leads')
    .select('id, stage, estimated_monthly_billings')
    .is('archived_at', null)
    .limit(5000);
  const byStage: Record<string, { count: number }> = {};
  for (const s of STAGES) byStage[s] = { count: 0 };
  for (const l of allStages ?? []) {
    if (byStage[l.stage]) {
      byStage[l.stage].count++;
    }
  }
  const weightedPipeline = weightedPipelineValue(allStages ?? []);
  const pipelineSampleSize = (allStages ?? []).filter(l => l.stage !== 'lost').length;

  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const { count: activitiesThisWeek } = await supabase
    .from('crm_activities')
    .select('id', { count: 'exact', head: true })
    .gt('occurred_at', sevenDaysAgo.toISOString());

  // ── Inbound (unowned) leads from the public /practices form ────
  //
  // Surfaced above the follow-up buckets so sales sees new inbound
  // work first thing when they load /crm. Only unowned rows count —
  // once someone claims a lead by editing owner_user_id the row falls
  // out of this tray.
  const { data: inboundRows } = await supabase
    .from('crm_leads')
    .select('id, practice_name, contact_first_name, contact_last_name, suburb, city, created_at')
    .is('archived_at', null)
    .eq('source', 'inbound')
    .is('owner_user_id', null)
    .order('created_at', { ascending: false })
    .limit(20);
  const inbound = (inboundRows ?? []) as Array<{
    id: string; practice_name: string; contact_first_name: string; contact_last_name: string;
    suburb: string | null; city: string | null; created_at: string;
  }>;

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-6 sm:py-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold text-gray-900">My Day</h1>
          <p className="mt-1 text-sm text-gray-500">
            Follow-ups queued for you. Work top to bottom — nothing under &lsquo;overdue&rsquo; is optional.
          </p>
        </div>
        <Link
          href="/crm/leads/new"
          className="rounded-lg bg-[#13294B] text-white px-3 py-2 text-sm font-medium"
        >
          + New lead
        </Link>
      </div>

      {/* ── Metrics strip ────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MetricCard label="Overdue"          value={String(buckets.overdue.length)} tone={buckets.overdue.length ? 'danger' : 'neutral'} />
        <MetricCard
          label="Weighted pipeline"
          value={hasEnoughData(pipelineSampleSize) ? formatRand(weightedPipeline) : 'Not enough data yet'}
          tone="neutral"
          hint="value × stage close-probability"
        />
        <MetricCard label="Activities (7d)"  value={String(activitiesThisWeek ?? 0)} tone="neutral" />
        <MetricCard label="Total leads"      value={String(allStages?.length ?? 0)} tone="neutral" />
      </div>

      <StageStrip byStage={byStage} />

      {/* ── Inbound tray (public-form leads not yet claimed) ───── */}
      {inbound.length > 0 && (
        <section
          data-testid="crm-inbound-tray"
          className="bg-white rounded-2xl border border-[#15A89E]/40 overflow-hidden"
        >
          <header className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-[#15A89E]/5">
            <h2 className="text-sm font-semibold" style={{ color: '#13294B' }}>
              New inbound
            </h2>
            <span className="inline-flex items-center rounded-full bg-[#15A89E]/15 text-[#0F766E] px-2 py-0.5 text-xs font-medium">
              {inbound.length}
            </span>
          </header>
          <ul className="divide-y divide-gray-100">
            {inbound.map(r => (
              <li key={r.id}>
                <Link href={`/crm/leads/${r.id}`} className="flex items-center justify-between px-4 py-3 hover:bg-gray-50">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{r.practice_name}</p>
                    <p className="text-xs text-gray-500 truncate">
                      {r.contact_first_name} {r.contact_last_name}
                      {(r.suburb || r.city) && ` · ${[r.suburb, r.city].filter(Boolean).join(', ')}`}
                    </p>
                  </div>
                  <span className="text-xs text-gray-500 tabular-nums shrink-0">
                    {new Date(r.created_at).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'medium' })}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── Buckets ─────────────────────────────────────────────── */}
      <Bucket
        title="Overdue"
        tone="danger"
        rows={buckets.overdue}
        rawLeads={rawLeads ?? []}
        empty="Nothing overdue — nice."
      />
      <Bucket
        title="Due today"
        tone="warn"
        rows={buckets.today}
        rawLeads={rawLeads ?? []}
        empty="Nothing scheduled for today."
      />
      <Bucket
        title="Next 7 days"
        tone="neutral"
        rows={buckets.upcoming}
        rawLeads={rawLeads ?? []}
        empty="Nothing scheduled for the next 7 days."
      />
    </div>
  );
}

// ── UI atoms ────────────────────────────────────────────────────────

type Tone = 'neutral' | 'warn' | 'danger';

function MetricCard({ label, value, tone, hint }: { label: string; value: string; tone: Tone; hint?: string }) {
  const ring =
    tone === 'danger' ? 'border-red-200 bg-red-50 text-red-800'
    : tone === 'warn' ? 'border-amber-200 bg-amber-50 text-amber-800'
    : 'border-gray-200 bg-white text-gray-900';
  return (
    <div className={`rounded-2xl border p-4 ${ring}`}>
      <p className="text-xs uppercase tracking-wide font-medium">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="text-[10px] mt-0.5 opacity-70">{hint}</p>}
    </div>
  );
}

function StageStrip({ byStage }: { byStage: Record<string, { count: number }> }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-4">
      <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">Pipeline by stage</p>
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2 text-xs">
        {STAGES.map(s => (
          <div key={s} className="rounded-lg border border-gray-100 bg-gray-50 px-2 py-1.5">
            <div className="capitalize text-gray-500">{s.replace(/_/g, ' ')}</div>
            <div className="font-semibold text-gray-900 tabular-nums">{byStage[s].count}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

type BucketRow = { id: string; practice_name: string; next_follow_up_at: string | null; stage: string };

function Bucket({
  title, tone, rows, empty, rawLeads,
}: {
  title: string;
  tone: Tone;
  rows: BucketRow[];
  empty: string;
  rawLeads: Array<{ id: string; practice_name: string; stage: string; next_follow_up_at: string | null }>;
}) {
  const chip =
    tone === 'danger' ? 'bg-red-100 text-red-800'
    : tone === 'warn' ? 'bg-amber-100 text-amber-800'
    : 'bg-gray-100 text-gray-700';
  const leadsById = new Map(rawLeads.map(l => [l.id, l]));

  return (
    <section className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
      <header className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
        <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${chip}`}>
          {rows.length}
        </span>
      </header>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-gray-500">{empty}</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {rows.map(r => {
            const lead = leadsById.get(r.id) ?? r;
            const when = r.next_follow_up_at
              ? new Date(r.next_follow_up_at).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short' })
              : '—';
            return (
              <li key={r.id}>
                <Link
                  href={`/crm/leads/${r.id}`}
                  className="flex items-center justify-between px-4 py-3 hover:bg-gray-50"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{lead.practice_name}</div>
                    <div className="text-xs text-gray-500 capitalize">Stage: {lead.stage.replace(/_/g, ' ')}</div>
                  </div>
                  <div className="text-xs text-gray-600 tabular-nums shrink-0">{when} SAST</div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
