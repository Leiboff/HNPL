'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { moveLeadStage, markSigned } from '../leads/actions';
import { LOST_REASONS, LOST_REASON_LABELS } from '@/lib/crm/lostReasons';
import { formatRand } from '@/app/admin/_lib/format';

type BoardRow = {
  id: string;
  practice_name: string;
  stage: string;
  contact_first_name: string;
  contact_last_name: string;
  next_follow_up_at: string | null;
  specialty: string | null;
  estimated_monthly_billings: number | null;
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
            Drag to move between stages. Column totals show lead count per stage.
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
          const stageValue = stageRows.reduce((sum, r) => sum + (r.estimated_monthly_billings ?? 0), 0);
          return (
            <div
              key={stage.key}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => onDrop(stage.key, e)}
              className="bg-white rounded-2xl border border-gray-200 min-h-[300px] flex flex-col"
              data-testid={`crm-board-column:${stage.key}`}
            >
              <div className="p-3 border-b border-gray-100">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-gray-900">{stage.label}</h3>
                  <span
                    className="text-xs text-gray-500 tabular-nums"
                    data-testid={`crm-board-column-count:${stage.key}`}
                  >
                    {stageRows.length}
                  </span>
                </div>
                {stageValue > 0 && (
                  <p className="mt-0.5 text-[11px] text-gray-400 tabular-nums" data-testid={`crm-board-column-value:${stage.key}`}>
                    {formatRand(stageValue)}
                  </p>
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
                      {r.estimated_monthly_billings != null && (
                        <p className="text-[10px] text-gray-500 tabular-nums" data-testid={`crm-board-card-value:${r.id}`}>
                          {formatRand(r.estimated_monthly_billings)}
                        </p>
                      )}
                      {r.next_follow_up_at && (
                        <p className="text-[10px] text-gray-400 mt-1">
                          {new Date(r.next_follow_up_at).toLocaleDateString('en-ZA', { timeZone: 'Africa/Johannesburg' })}
                        </p>
                      )}
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
        <p className="text-xs text-gray-500">A lost reason is required so we can spot patterns.</p>
        <select
          value={reason}
          onChange={e => setReason(e.target.value)}
          className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#15A89E]/40 focus:border-[#15A89E]"
          data-testid="board-lost-reason-picker"
        >
          <option value="">Select a reason…</option>
          {LOST_REASONS.map(r => <option key={r} value={r}>{LOST_REASON_LABELS[r]}</option>)}
        </select>
        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onCancel} disabled={pending} className="rounded-lg border border-gray-200 bg-white text-gray-700 px-3 py-2 text-sm">Cancel</button>
          <button type="button" onClick={() => onConfirm(reason)} disabled={pending || !reason.trim()} className="rounded-lg bg-[#13294B] text-white px-3 py-2 text-sm font-medium disabled:opacity-60">Move to lost</button>
        </div>
      </div>
    </div>
  );
}
