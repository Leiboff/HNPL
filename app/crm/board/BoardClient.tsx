'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { formatRand } from '@/app/admin/_lib/format';
import { moveLeadStage, markSigned } from '../leads/actions';

type BoardRow = {
  id: string;
  practice_name: string;
  stage: string;
  contact_first_name: string;
  contact_last_name: string;
  estimated_monthly_billings: number | string | null;
  next_follow_up_at: string | null;
  specialty: string | null;
};

const STAGES = [
  { key: 'new',                label: 'New' },
  { key: 'contacted',          label: 'Contacted' },
  { key: 'meeting_scheduled',  label: 'Meeting scheduled' },
  { key: 'demo_done',          label: 'Demo done' },
  { key: 'agreement_sent',     label: 'Agreement sent' },
  { key: 'signed',             label: 'Signed' },
  { key: 'onboarded',          label: 'Onboarded' },
  { key: 'lost',               label: 'Lost' },
] as const;

export default function BoardClient({ rows: initial }: { rows: BoardRow[] }) {
  const [rows, setRows] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const [lostPrompt, setLostPrompt]   = useState<null | { id: string; from: string }>(null);
  const [inviteUrl,  setInviteUrl]    = useState<string | null>(null);

  function commitMove(id: string, toStage: string, lostReason?: string) {
    startTransition(async () => {
      const res = await moveLeadStage(id, toStage, lostReason);
      if (res.error) {
        setMsg({ kind: 'err', text: res.error });
        return;
      }
      // Optimistic update
      setRows(prev => prev.map(r => r.id === id
        ? { ...r, stage: toStage }
        : r,
      ));

      // Moving to 'signed' triggers the invite creation
      if (toStage === 'signed') {
        const signedRes = await markSigned(id);
        if (signedRes.error) { setMsg({ kind: 'err', text: signedRes.error }); return; }
        if (signedRes.inviteUrl) { setInviteUrl(signedRes.inviteUrl); }
      }
      setMsg({ kind: 'ok', text: 'Stage updated.' });
    });
  }

  function onDrop(toStage: string, ev: React.DragEvent) {
    ev.preventDefault();
    const id = ev.dataTransfer.getData('text/lead-id');
    if (!id) return;
    const from = rows.find(r => r.id === id);
    if (!from || from.stage === toStage) return;
    if (toStage === 'lost') {
      setLostPrompt({ id, from: from.stage });
      return;
    }
    commitMove(id, toStage);
  }

  return (
    <div className="mx-auto max-w-full px-4 sm:px-6 py-6 sm:py-8">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold text-gray-900">Pipeline</h1>
          <p className="mt-1 text-sm text-gray-500">
            Drag to move between stages. Column totals show lead count + summed monthly-billings proxy.
          </p>
        </div>
        <Link href="/crm/leads/new" className="rounded-lg bg-[#13294B] text-white px-3 py-2 text-sm font-medium">+ New lead</Link>
      </div>

      {msg && (
        <div role="alert" className={`mb-3 text-xs rounded-lg px-3 py-2 ${msg.kind === 'ok'
          ? 'border border-green-200 bg-green-50 text-green-800'
          : 'border border-red-200 bg-red-50 text-red-700'}`}>
          {msg.text}
        </div>
      )}

      {inviteUrl && (
        <div className="mb-3 rounded-lg border border-[#15A89E]/40 bg-[#15A89E]/10 text-[#13294B] px-3 py-3 text-xs">
          <p className="font-semibold">Practice invite ready — share this link:</p>
          <div className="mt-1 flex gap-2">
            <input readOnly value={inviteUrl} className="flex-1 rounded-lg border border-gray-200 bg-white px-2 py-1.5 font-mono text-[11px]" />
            <button onClick={() => { navigator.clipboard.writeText(inviteUrl); setMsg({ kind: 'ok', text: 'Copied.' }); }} className="rounded-lg bg-[#13294B] text-white px-3 py-1.5 text-xs font-medium">Copy</button>
            <button onClick={() => setInviteUrl(null)} className="rounded-lg border border-gray-200 bg-white text-gray-700 px-3 py-1.5 text-xs">Dismiss</button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
        {STAGES.map(stage => {
          const stageRows = rows.filter(r => r.stage === stage.key);
          const total = stageRows.reduce((acc, r) => acc + Number(r.estimated_monthly_billings ?? 0), 0);
          return (
            <div
              key={stage.key}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => onDrop(stage.key, e)}
              className="bg-white rounded-2xl border border-gray-200 min-h-[300px] flex flex-col"
            >
              <div className="p-3 border-b border-gray-100">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-gray-900">{stage.label}</h3>
                  <span className="text-xs text-gray-500 tabular-nums">{stageRows.length}</span>
                </div>
                {total > 0 && (
                  <p className="text-[10px] text-gray-500 tabular-nums mt-0.5">{formatRand(total)}/mo</p>
                )}
              </div>
              <ul className="flex-1 p-2 space-y-2 overflow-y-auto max-h-[65vh]">
                {stageRows.map(r => (
                  <li key={r.id}>
                    <Link
                      href={`/crm/leads/${r.id}`}
                      draggable
                      onDragStart={(e) => { e.dataTransfer.setData('text/lead-id', r.id); e.dataTransfer.effectAllowed = 'move'; }}
                      className="block cursor-move rounded-lg border border-gray-200 bg-white hover:border-gray-300 p-2"
                    >
                      <p className="text-xs font-semibold text-gray-900 truncate">{r.practice_name}</p>
                      <p className="text-[11px] text-gray-500 truncate">
                        {r.contact_first_name} {r.contact_last_name}
                      </p>
                      {r.specialty && <p className="text-[10px] text-gray-400 truncate">{r.specialty}</p>}
                      <div className="flex items-center justify-between text-[10px] text-gray-400 mt-1">
                        <span>{r.estimated_monthly_billings ? formatRand(Number(r.estimated_monthly_billings)) : '—'}</span>
                        {r.next_follow_up_at && (
                          <span>{new Date(r.next_follow_up_at).toLocaleDateString('en-ZA', { timeZone: 'Africa/Johannesburg' })}</span>
                        )}
                      </div>
                    </Link>
                  </li>
                ))}
                {stageRows.length === 0 && (
                  <li className="text-[11px] text-gray-400 text-center py-4">Drop leads here</li>
                )}
              </ul>
            </div>
          );
        })}
      </div>

      {lostPrompt && (
        <LostReasonSheet
          onConfirm={(reason) => { commitMove(lostPrompt.id, 'lost', reason); setLostPrompt(null); }}
          onCancel={() => setLostPrompt(null)}
          pending={pending}
        />
      )}
    </div>
  );
}

function LostReasonSheet({ onConfirm, onCancel, pending }: {
  onConfirm: (reason: string) => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const [reason, setReason] = useState('');
  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="bg-white rounded-2xl border border-gray-200 shadow-lg w-full max-w-md p-4 space-y-3">
        <h3 className="text-sm font-semibold text-gray-900">Why did this lead go lost?</h3>
        <p className="text-xs text-gray-500">A lost reason is required so we can spot patterns (price, timing, competitor, no-show, etc.).</p>
        <input
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="e.g. Competitor pricing, No response after 3 attempts"
          className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#15A89E]/40 focus:border-[#15A89E]"
        />
        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onCancel} disabled={pending} className="rounded-lg border border-gray-200 bg-white text-gray-700 px-3 py-2 text-sm">Cancel</button>
          <button type="button" onClick={() => onConfirm(reason)} disabled={pending || !reason.trim()} className="rounded-lg bg-[#13294B] text-white px-3 py-2 text-sm font-medium disabled:opacity-60">Move to lost</button>
        </div>
      </div>
    </div>
  );
}
