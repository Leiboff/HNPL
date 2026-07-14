'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { SPECIALTIES } from '@/lib/specialties';
import { formatDateTime, timeAgo, formatRand } from '@/app/admin/_lib/format';
import {
  updateLead, moveLeadStage, logActivity, scheduleFollowup, markSigned, markFollowupDone,
} from '../actions';
import ComposeEmailSheet from './ComposeEmailSheet';

// ─── Lead detail — fields (editable) + activity timeline + quick actions

type Lead = {
  id: string;
  practice_name: string;
  contact_first_name: string;
  contact_last_name: string;
  role_at_practice: string | null;
  specialty: string | null;
  phone: string | null;
  email: string | null;
  suburb: string | null;
  city: string | null;
  province: string | null;
  formatted_address: string | null;
  latitude: number | null;
  longitude: number | null;
  source: string;
  stage: string;
  lost_reason: string | null;
  estimated_monthly_billings: number | null;
  owner_user_id: string | null;
  next_follow_up_at: string | null;
  converted_practice_id: string | null;
  updated_at: string;
  created_at: string;
};

type Activity = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  occurred_at: string;
  created_at: string;
  created_by: string | null;
};

type PendingInvite = {
  token: string;
  expires_at: string;
  accepted_at: string | null;
  accepted_by_practice_id: string | null;
} | null;

const STAGES = ['new','contacted','meeting_scheduled','demo_done','agreement_sent','signed','onboarded','lost'] as const;
const SOURCES = ['referral','cold_outreach','inbound','event','other'] as const;

export default function LeadDetailClient({
  lead: initialLead, activities: initialActivities, pendingInvite,
}: {
  lead: Lead;
  activities: Activity[];
  pendingInvite: PendingInvite;
}) {
  const [lead, setLead]           = useState(initialLead);
  const [activities, setActs]     = useState(initialActivities);
  const [msg, setMsg]             = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(
    pendingInvite && !pendingInvite.accepted_at
      ? `${typeof window !== 'undefined' ? window.location.origin : ''}/signup/practice?token=${pendingInvite.token}`
      : null,
  );
  const [pending, startTransition] = useTransition();

  // Ephemeral form state for the schedule sheet
  const [schedule, setSchedule] = useState<{ open: boolean; type: 'call' | 'meeting' }>({ open: false, type: 'call' });
  const [showLog,  setShowLog]  = useState<null | { type: 'call' | 'meeting' | 'whatsapp' | 'email' | 'note' }>(null);
  const [showStage, setShowStage] = useState(false);
  const [showCompose, setShowCompose] = useState(false);

  function ok(text: string)  { setMsg({ kind: 'ok', text }); }
  function err(text: string) { setMsg({ kind: 'err', text }); }

  function saveField(field: keyof Lead, value: string | number | null) {
    startTransition(async () => {
      const res = await updateLead(lead.id, { [field]: value });
      if (res.error) return err(res.error);
      setLead(l => ({ ...l, [field]: value } as Lead));
      ok('Saved.');
    });
  }

  function doStage(stage: string, lostReason?: string, note?: string) {
    startTransition(async () => {
      const res = await moveLeadStage(lead.id, stage, lostReason, note);
      if (res.error) return err(res.error);
      setLead(l => ({ ...l, stage, lost_reason: stage === 'lost' ? lostReason ?? null : l.lost_reason }));
      // Optimistic activity add (server has already logged the real one)
      setActs(a => ([
        {
          id: `optimistic-${Date.now()}`,
          type: 'stage_change',
          title: `Stage: ${lead.stage} → ${stage}`,
          body:  stage === 'lost' ? `Reason: ${lostReason ?? ''}` : (note ?? null),
          occurred_at: new Date().toISOString(),
          created_at:  new Date().toISOString(),
          created_by:  null,
        },
        ...a,
      ]));
      setShowStage(false);
      ok(`Moved to ${stage.replace(/_/g, ' ')}.`);
    });
  }

  function doLog(type: 'call' | 'meeting' | 'whatsapp' | 'email' | 'note', title: string, body: string) {
    startTransition(async () => {
      const res = await logActivity({ lead_id: lead.id, type, title, body });
      if (res.error) return err(res.error);
      setActs(a => ([
        {
          id: `optimistic-${Date.now()}`,
          type,
          title: title || type,
          body:  body || null,
          occurred_at: new Date().toISOString(),
          created_at:  new Date().toISOString(),
          created_by:  null,
        },
        ...a,
      ]));
      setShowLog(null);
      ok('Logged.');
    });
  }

  function doSchedule(date: string, time: string, durationMin: number, notes: string, type: 'call' | 'meeting') {
    startTransition(async () => {
      const res = await scheduleFollowup({
        lead_id: lead.id,
        local_date: date,
        local_time: time,
        duration_min: durationMin,
        type,
        notes,
      });
      if (res.error || !res.calendarUrl) return err(res.error ?? 'Failed to schedule.');
      window.open(res.calendarUrl, '_blank', 'noopener,noreferrer');
      setSchedule({ open: false, type: 'call' });
      ok('Scheduled and follow-up set. Opened Google Calendar in a new tab.');
    });
  }

  function doMarkSigned() {
    startTransition(async () => {
      const res = await markSigned(lead.id);
      if (res.error) return err(res.error);
      if (res.inviteUrl) {
        setInviteUrl(res.inviteUrl);
        setLead(l => ({ ...l, stage: 'signed' }));
        ok('Invite created. Copy the link below and share with the practice.');
      }
    });
  }

  function markDoneWithNext(iso: string | null, note: string) {
    startTransition(async () => {
      const res = await markFollowupDone(lead.id, iso, note);
      if (res.error) return err(res.error);
      setLead(l => ({ ...l, next_follow_up_at: iso }));
      ok('Follow-up marked done.');
    });
  }

  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 py-6 sm:py-8 space-y-6">

      <div className="flex items-center gap-3">
        <Link href="/crm/leads" className="text-sm text-[#15A89E] hover:text-[#13294B]">← All leads</Link>
      </div>

      <div>
        <h1 className="text-xl sm:text-2xl font-semibold text-gray-900">{lead.practice_name}</h1>
        <p className="mt-1 text-sm text-gray-500 capitalize">
          Stage: {lead.stage.replace(/_/g, ' ')} · Source: {lead.source.replace('_', ' ')}
          {lead.lost_reason && ` · Lost reason: ${lead.lost_reason}`}
        </p>
      </div>

      {msg && (
        <div
          role="alert"
          className={`text-xs rounded-lg px-3 py-2 ${
            msg.kind === 'ok'
              ? 'border border-green-200 bg-green-50 text-green-800'
              : 'border border-red-200 bg-red-50 text-red-700'
          }`}
        >
          {msg.text}
        </div>
      )}

      {inviteUrl && (
        <div className="rounded-2xl border border-[#15A89E]/40 bg-[#15A89E]/10 p-4">
          <p className="text-sm font-medium text-[#13294B]">Practice invite ready</p>
          <p className="text-xs text-gray-600 mt-1">Share this link with the practice so they can complete signup. Their signup will auto-link back to this lead; when a platform admin approves the practice, the lead moves to &lsquo;onboarded&rsquo; automatically.</p>
          <div className="mt-2 flex gap-2">
            <input readOnly value={inviteUrl} className="flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-mono" />
            <button
              type="button"
              onClick={() => { navigator.clipboard.writeText(inviteUrl); ok('Copied to clipboard.'); }}
              className="rounded-lg bg-[#13294B] text-white px-3 py-2 text-xs font-medium"
            >
              Copy
            </button>
          </div>
        </div>
      )}

      {/* Quick-actions strip */}
      <div className="flex flex-wrap gap-2">
        <QuickBtn onClick={() => setShowLog({ type: 'call' })}     label="Log call" />
        <QuickBtn onClick={() => setShowLog({ type: 'meeting' })}  label="Log meeting" />
        <QuickBtn onClick={() => setShowLog({ type: 'note' })}     label="Add note" />
        <QuickBtn onClick={() => setShowCompose(true)}             label="Email lead" />
        <QuickBtn onClick={() => setSchedule({ open: true, type: 'call' })}    label="Schedule call" />
        <QuickBtn onClick={() => setSchedule({ open: true, type: 'meeting' })} label="Schedule meeting" />
        <QuickBtn onClick={() => setShowStage(true)}               label="Move stage" tone="accent" />
        {lead.stage !== 'signed' && lead.stage !== 'onboarded' && !inviteUrl && (
          <QuickBtn onClick={doMarkSigned} label="Mark signed → invite" tone="accent" />
        )}
      </div>

      {/* Fields */}
      <div className="bg-white rounded-2xl border border-gray-200 p-4 space-y-4">
        <h2 className="text-sm font-semibold text-gray-900">Lead details</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <FieldText label="Practice name"     value={lead.practice_name}            onSave={v => saveField('practice_name', v)}      pending={pending} required />
          <FieldText label="Contact first"     value={lead.contact_first_name}       onSave={v => saveField('contact_first_name', v)} pending={pending} required />
          <FieldText label="Contact last"      value={lead.contact_last_name}        onSave={v => saveField('contact_last_name', v)}  pending={pending} required />
          <FieldText label="Role at practice"  value={lead.role_at_practice ?? ''}   onSave={v => saveField('role_at_practice', v || null)} pending={pending} />
          <FieldSelect label="Specialty"       value={lead.specialty ?? ''}          options={['', ...SPECIALTIES]} onSave={v => saveField('specialty', v || null)} pending={pending} />
          <FieldText label="Phone"             value={lead.phone ?? ''}              onSave={v => saveField('phone', v || null)}      pending={pending} />
          <FieldText label="Email"             value={lead.email ?? ''}              onSave={v => saveField('email', v.toLowerCase() || null)} pending={pending} type="email" />
          <FieldText label="Suburb"            value={lead.suburb ?? ''}             onSave={v => saveField('suburb', v || null)}     pending={pending} />
          <FieldText label="City"              value={lead.city ?? ''}               onSave={v => saveField('city', v || null)}       pending={pending} />
          <FieldText label="Province"          value={lead.province ?? ''}           onSave={v => saveField('province', v || null)}   pending={pending} />
          <FieldSelect label="Source"          value={lead.source}                   options={[...SOURCES]}                            onSave={v => saveField('source', v)} pending={pending} />
          <FieldText label="Est. R/mo"         value={String(lead.estimated_monthly_billings ?? '')} onSave={v => saveField('estimated_monthly_billings', v ? Number(v.replace(/[R,\s]/g, '')) : null)} pending={pending} inputMode="numeric" />
        </div>
        <p className="text-[10px] text-gray-400 pt-2 border-t border-gray-100">
          Created {formatDateTime(lead.created_at)} · Updated {timeAgo(lead.updated_at)}
          {lead.estimated_monthly_billings ? ` · deal-size proxy ${formatRand(Number(lead.estimated_monthly_billings))}` : ''}
        </p>
      </div>

      {/* Follow-up schedule */}
      <div className="bg-white rounded-2xl border border-gray-200 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-gray-900">Follow-up</h2>
        {lead.next_follow_up_at ? (
          <>
            <p className="text-sm text-gray-700">
              Next: {new Date(lead.next_follow_up_at).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'full', timeStyle: 'short' })} SAST
            </p>
            <MarkDoneForm onDone={markDoneWithNext} pending={pending} />
          </>
        ) : (
          <p className="text-sm text-gray-500">No follow-up scheduled. Nudge: leads in non-terminal stages should always have a next action — use &lsquo;Schedule call&rsquo; above.</p>
        )}
      </div>

      {/* Timeline */}
      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900">Activity timeline</h2>
          <span className="text-xs text-gray-500">{activities.length}</span>
        </div>
        {activities.length === 0 ? (
          <p className="p-6 text-sm text-gray-500">No activity yet. Log a call, meeting, or note above.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {activities.map(a => (
              <li key={a.id} className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-600">
                    {a.type.replace(/_/g, ' ')}
                  </span>
                  <span className="text-xs text-gray-500">{timeAgo(a.occurred_at)}</span>
                </div>
                <p className="mt-1 text-sm text-gray-900 font-medium">{a.title}</p>
                {a.body && <p className="mt-1 text-sm text-gray-700 whitespace-pre-wrap">{a.body}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Log activity sheet */}
      {showLog && (
        <LogSheet
          type={showLog.type}
          onSubmit={(title, body) => doLog(showLog.type, title, body)}
          onCancel={() => setShowLog(null)}
          pending={pending}
        />
      )}

      {/* Schedule sheet */}
      {schedule.open && (
        <ScheduleSheet
          type={schedule.type}
          onSubmit={(d, t, dur, notes) => doSchedule(d, t, dur, notes, schedule.type)}
          onCancel={() => setSchedule({ open: false, type: 'call' })}
          pending={pending}
        />
      )}

      {/* Compose email sheet */}
      {showCompose && (
        <ComposeEmailSheet
          open
          onClose={() => setShowCompose(false)}
          leadId={lead.id}
          leadEmail={lead.email}
          practiceName={lead.practice_name}
        />
      )}

      {/* Move stage sheet */}
      {showStage && (
        <MoveStageSheet
          current={lead.stage}
          onSubmit={doStage}
          onCancel={() => setShowStage(false)}
          pending={pending}
        />
      )}
    </div>
  );
}

// ── Atoms ───────────────────────────────────────────────────────────

function QuickBtn({ label, onClick, tone }: { label: string; onClick: () => void; tone?: 'accent' }) {
  const cls = tone === 'accent'
    ? 'rounded-lg bg-[#13294B] text-white px-3 py-2 text-xs font-medium'
    : 'rounded-lg border border-gray-200 bg-white text-gray-700 px-3 py-2 text-xs font-medium hover:bg-gray-50';
  return <button type="button" onClick={onClick} className={cls}>{label}</button>;
}

function FieldText({
  label, value, onSave, pending, required, type, inputMode,
}: {
  label: string; value: string; onSave: (v: string) => void; pending: boolean;
  required?: boolean; type?: 'text' | 'email'; inputMode?: 'numeric';
}) {
  const [v, setV] = useState(value);
  return (
    <label className="text-xs">
      <span className="block font-medium text-gray-700 mb-1">{label}{required && <span className="text-red-500"> *</span>}</span>
      <input
        type={type ?? 'text'}
        inputMode={inputMode}
        value={v}
        onChange={e => setV(e.target.value)}
        onBlur={() => { if (v !== value) onSave(v); }}
        disabled={pending}
        className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[#15A89E]/40 focus:border-[#15A89E] disabled:opacity-60"
      />
    </label>
  );
}

function FieldSelect({
  label, value, options, onSave, pending,
}: {
  label: string; value: string; options: readonly string[]; onSave: (v: string) => void; pending: boolean;
}) {
  return (
    <label className="text-xs">
      <span className="block font-medium text-gray-700 mb-1">{label}</span>
      <select
        value={value}
        onChange={e => onSave(e.target.value)}
        disabled={pending}
        className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#15A89E]/40 focus:border-[#15A89E] disabled:opacity-60"
      >
        {options.map(o => <option key={o || '(none)'} value={o}>{o || '(none)'}</option>)}
      </select>
    </label>
  );
}

// ── Sheets (inline, no modal library) ───────────────────────────────

function LogSheet({ type, onSubmit, onCancel, pending }: {
  type: 'call' | 'meeting' | 'whatsapp' | 'email' | 'note';
  onSubmit: (title: string, body: string) => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const [title, setTitle] = useState('');
  const [body,  setBody]  = useState('');
  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="bg-white rounded-2xl border border-gray-200 shadow-lg w-full max-w-md p-4 space-y-3">
        <h3 className="text-sm font-semibold text-gray-900 capitalize">Log {type}</h3>
        <label className="block text-xs text-gray-700">
          Title
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder={`${type} — brief description`}
            className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#15A89E]/40 focus:border-[#15A89E]"
          />
        </label>
        <label className="block text-xs text-gray-700">
          Notes
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            rows={4}
            className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#15A89E]/40 focus:border-[#15A89E] resize-y"
          />
        </label>
        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onCancel} disabled={pending} className="rounded-lg border border-gray-200 bg-white text-gray-700 px-3 py-2 text-sm">Cancel</button>
          <button type="button" onClick={() => onSubmit(title, body)} disabled={pending} className="rounded-lg bg-[#13294B] text-white px-3 py-2 text-sm font-medium disabled:opacity-60">Save</button>
        </div>
      </div>
    </div>
  );
}

function ScheduleSheet({ type, onSubmit, onCancel, pending }: {
  type: 'call' | 'meeting';
  onSubmit: (date: string, time: string, dur: number, notes: string) => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const now = new Date();
  const defaultDate = now.toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' }); // YYYY-MM-DD
  const [date, setDate] = useState(defaultDate);
  const [time, setTime] = useState('14:00');
  const [dur,  setDur]  = useState(30);
  const [notes, setNotes] = useState('');

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="bg-white rounded-2xl border border-gray-200 shadow-lg w-full max-w-md p-4 space-y-3">
        <h3 className="text-sm font-semibold text-gray-900 capitalize">Schedule {type}</h3>
        <p className="text-xs text-gray-500">Time is in Africa/Johannesburg (SAST). We&apos;ll set the follow-up + open a Google Calendar deep link so you can add it to your own calendar.</p>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-gray-700">
            Date
            <input type="date" value={date} onChange={e => setDate(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm" />
          </label>
          <label className="text-xs text-gray-700">
            Time
            <input type="time" value={time} onChange={e => setTime(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm" />
          </label>
        </div>
        <label className="text-xs text-gray-700">
          Duration (min)
          <input type="number" min={1} max={480} value={dur} onChange={e => setDur(Number(e.target.value))} className="mt-1 w-24 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm" />
        </label>
        <label className="text-xs text-gray-700 block">
          Notes
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm resize-y" />
        </label>
        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onCancel} disabled={pending} className="rounded-lg border border-gray-200 bg-white text-gray-700 px-3 py-2 text-sm">Cancel</button>
          <button type="button" onClick={() => onSubmit(date, time, dur, notes)} disabled={pending} className="rounded-lg bg-[#13294B] text-white px-3 py-2 text-sm font-medium disabled:opacity-60">Schedule & open calendar</button>
        </div>
      </div>
    </div>
  );
}

function MoveStageSheet({ current, onSubmit, onCancel, pending }: {
  current: string;
  onSubmit: (stage: string, lostReason?: string, note?: string) => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const [stage, setStage]    = useState(current);
  const [reason, setReason]  = useState('');
  const [note, setNote]      = useState('');
  const requireReason = stage === 'lost';
  const canSubmit = stage !== current && (!requireReason || reason.trim().length > 0);

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="bg-white rounded-2xl border border-gray-200 shadow-lg w-full max-w-md p-4 space-y-3">
        <h3 className="text-sm font-semibold text-gray-900">Move stage</h3>
        <label className="text-xs text-gray-700 block">
          To
          <select value={stage} onChange={e => setStage(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm">
            {STAGES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
        </label>
        {requireReason && (
          <label className="text-xs text-gray-700 block">
            Lost reason <span className="text-red-500">*</span>
            <input value={reason} onChange={e => setReason(e.target.value)} required className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm" />
          </label>
        )}
        <label className="text-xs text-gray-700 block">
          Note (optional)
          <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm resize-y" />
        </label>
        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onCancel} disabled={pending} className="rounded-lg border border-gray-200 bg-white text-gray-700 px-3 py-2 text-sm">Cancel</button>
          <button type="button" onClick={() => onSubmit(stage, reason, note)} disabled={pending || !canSubmit} className="rounded-lg bg-[#13294B] text-white px-3 py-2 text-sm font-medium disabled:opacity-60">Move</button>
        </div>
      </div>
    </div>
  );
}

function MarkDoneForm({ onDone, pending }: {
  onDone: (iso: string | null, note: string) => void;
  pending: boolean;
}) {
  const [nextDate, setNextDate] = useState('');
  const [nextTime, setNextTime] = useState('14:00');
  const [note, setNote] = useState('');

  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50 p-3 text-xs space-y-2">
      <p className="text-gray-700 font-medium">Mark done → schedule next</p>
      <div className="grid grid-cols-2 gap-2">
        <input type="date" value={nextDate} onChange={e => setNextDate(e.target.value)} className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs" />
        <input type="time" value={nextTime} onChange={e => setNextTime(e.target.value)} className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs" />
      </div>
      <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} placeholder="What happened?" className="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs resize-y" />
      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={() => onDone(null, note)}
          disabled={pending}
          className="rounded-lg border border-gray-200 bg-white text-gray-700 px-2 py-1.5 text-xs disabled:opacity-60"
        >
          Done, clear
        </button>
        <button
          type="button"
          onClick={() => {
            if (!nextDate) { alert('Pick a next date, or use "Done, clear" if this lead is terminal.'); return; }
            // Convert SAST-local to UTC (SAST = UTC+2)
            const dt = new Date(`${nextDate}T${nextTime}:00+02:00`);
            onDone(dt.toISOString(), note);
          }}
          disabled={pending}
          className="rounded-lg bg-[#13294B] text-white px-2 py-1.5 text-xs font-medium disabled:opacity-60"
        >
          Done, schedule next
        </button>
      </div>
    </div>
  );
}
