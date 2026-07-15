'use client';

import { useMemo, useState } from 'react';
import { materialiseSplit, firstLine } from '@/lib/gmail/quoteSplit';
import {
  conversationSubject,
  type ConversationItem,
  type TimelineActivity,
} from './conversationGrouper';

// ─── Outlook-style conversation card ───────────────────────────────
//
// Collapsed: subject (Re: stripped), participant summary, message
// count badge, one-line preview of the latest fresh text, latest
// timestamp, and a Reply button.
//
// Expanded: chronological message rows. All but the latest collapsed
// to sender + one-line preview + time. The latest opens by default
// with its ••• quoted-text toggle.
//
// Rows are visually directional — `email` = sent (by us), `email_reply`
// = received. Sent carries "Sent by {name} · {address}", received
// carries "From {name/address}" + "Received {time}".

type ActorRef = { firstName: string | null; lastName: string | null };
type ActorsById = Record<string, ActorRef>;

type Props = {
  conversation: ConversationItem;
  actorsById:   ActorsById;
  onReply:      (activityId: string) => void;
};

const SAST_TZ = 'Africa/Johannesburg';

export default function ConversationCard({ conversation, actorsById, onReply }: Props) {
  const [expanded, setExpanded] = useState(false);
  const { messages, latest } = conversation;

  const subject      = useMemo(() => conversationSubject(messages), [messages]);
  const participants = useMemo(() => summariseParticipants(messages), [messages]);
  const latestSplit  = useMemo(() => materialiseSplit(latest.body ?? ''), [latest]);
  const preview      = useMemo(() => firstLine(latestSplit.fresh, 120), [latestSplit.fresh]);

  return (
    <li className="px-0 py-0" data-testid={`crm-conversation:${conversation.threadId}`}>
      <div className="border-t border-gray-100">
        {/* Header — collapsed summary + Reply button */}
        <div className="px-4 py-3 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-600">
              conversation
            </span>
            <span
              className="inline-flex items-center rounded-full bg-[#13294B]/10 text-[#13294B] text-[10px] font-semibold px-1.5 py-0.5"
              data-testid="crm-conversation-count"
            >
              {messages.length}
            </span>
            <span className="text-xs text-gray-500 ml-auto">
              {formatSastRelative(latest.occurred_at)}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            aria-expanded={expanded}
            className="text-left"
            data-testid="crm-conversation-toggle"
          >
            {subject && (
              <p className="text-sm text-gray-900 font-semibold">{subject}</p>
            )}
            <p className="text-[11px] text-gray-500 mt-0.5">
              {participants.length > 0 ? participants.join(' · ') : '—'}
            </p>
            {!expanded && preview && (
              <p className="text-sm text-gray-700 mt-1 line-clamp-1" data-testid="crm-conversation-preview">
                {preview}
              </p>
            )}
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onReply(latest.id)}
              className="rounded-md border border-gray-200 bg-white text-gray-700 px-2 py-0.5 text-[10px] font-medium hover:bg-gray-50"
              data-testid={`crm-conversation-reply:${conversation.threadId}`}
            >
              Reply
            </button>
          </div>
        </div>

        {/* Expanded body — message rows */}
        {expanded && (
          <div className="border-t border-gray-100 bg-gray-50/60 crm-conv-expand" data-testid="crm-conversation-expanded">
            <ul className="divide-y divide-gray-100">
              {messages.map((m, i) => (
                <MessageRow
                  key={m.id}
                  msg={m}
                  actor={m.created_by ? actorsById[m.created_by] : null}
                  isLatest={i === messages.length - 1}
                />
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* prefers-reduced-motion — remove the transition entirely; on
          default settings the height reveal is inexpensive because we
          rely on browser layout, not JS-driven animation. */}
      <style jsx>{`
        .crm-conv-expand {
          animation: crmConvExpand 160ms ease-out;
        }
        @media (prefers-reduced-motion: reduce) {
          .crm-conv-expand { animation: none; }
        }
        @keyframes crmConvExpand {
          from { opacity: 0; transform: translateY(-2px); }
          to   { opacity: 1; transform: translateY(0);    }
        }
      `}</style>
    </li>
  );
}

function MessageRow({
  msg, actor, isLatest,
}: {
  msg:      TimelineActivity;
  actor:    ActorRef | null | undefined;
  isLatest: boolean;
}) {
  const [open, setOpen] = useState(isLatest);
  const [quotesOpen, setQuotesOpen] = useState(false);

  const isSent = msg.type === 'email';
  const displayName = actor
    ? [actor.firstName, actor.lastName].filter(Boolean).join(' ').trim() || null
    : null;

  const split   = useMemo(() => materialiseSplit(msg.body ?? ''), [msg.body]);
  const preview = useMemo(() => firstLine(split.fresh, 100), [split.fresh]);

  const senderLabel = isSent
    ? (displayName ? `Sent by ${displayName}` : 'Sent')
    : (msg.reply_from ? `From ${msg.reply_from}` : (msg.title || 'From ?'));

  return (
    <li
      className={`px-4 py-3 ${isSent ? 'border-l-2 border-l-[#15A89E]' : 'border-l-2 border-l-[#13294B]/30'}`}
      data-testid={`crm-message:${msg.id}`}
      data-direction={isSent ? 'sent' : 'received'}
    >
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className="w-full text-left flex items-start gap-3"
        data-testid={`crm-message-toggle:${msg.id}`}
      >
        <Avatar name={displayName ?? (msg.reply_from ?? msg.sent_from ?? '')} tone={isSent ? 'sent' : 'received'} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-900 truncate">{senderLabel}</span>
            <span className="text-xs text-gray-500 ml-auto whitespace-nowrap">
              {formatSastRelative(msg.occurred_at)}
            </span>
          </div>
          {!open && preview && (
            <p className="text-sm text-gray-700 mt-0.5 line-clamp-1">{preview}</p>
          )}
        </div>
      </button>

      {open && (
        <div className="mt-2 pl-11">
          <p className="text-[11px] text-gray-500">
            {isSent
              ? `Sent by ${displayName ?? '—'}${msg.sent_from ? ` · ${msg.sent_from}` : ''}`
              : `From ${msg.reply_from ?? '—'} · Received ${formatSastLong(msg.occurred_at)}`}
          </p>
          {split.fresh && (
            <pre className="mt-2 whitespace-pre-wrap font-sans text-sm text-gray-800">{split.fresh}</pre>
          )}
          {split.quoted && (
            <>
              <button
                type="button"
                onClick={() => setQuotesOpen(v => !v)}
                className="mt-2 inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white text-gray-500 hover:text-gray-700 px-2 py-1 text-[11px]"
                aria-label={quotesOpen ? 'Hide quoted text' : 'Show quoted text'}
                data-testid={`crm-message-quotes-toggle:${msg.id}`}
              >
                <span className="tracking-widest">•••</span>
              </button>
              {quotesOpen && (
                <pre
                  className="mt-2 whitespace-pre-wrap font-sans text-xs text-gray-500 border-l-2 border-gray-200 pl-3"
                  data-testid={`crm-message-quoted:${msg.id}`}
                >
                  {split.quoted}
                </pre>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}

// ── UI atoms ────────────────────────────────────────────────────────

function Avatar({ name, tone }: { name: string; tone: 'sent' | 'received' }) {
  const initial = (name.trim()[0] ?? '?').toUpperCase();
  const bg = tone === 'sent' ? '#15A89E' : '#13294B';
  return (
    <span
      className="shrink-0 inline-flex items-center justify-center rounded-full w-8 h-8 text-white text-xs font-semibold"
      style={{ background: bg }}
      aria-hidden
    >
      {initial}
    </span>
  );
}

// ── Time / attribution ──────────────────────────────────────────────

function summariseParticipants(messages: TimelineActivity[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (addr: string | null | undefined) => {
    if (!addr) return;
    const lc = addr.toLowerCase();
    if (seen.has(lc)) return;
    seen.add(lc);
    out.push(addr);
  };
  for (const m of messages) {
    add(m.sent_from);
    if (m.type === 'email_reply') add(m.reply_from);
  }
  return out.slice(0, 4);
}

/** Today → short SAST time (e.g. "14:32"). Older → date + time
 *  (e.g. "12 Jul, 14:32"). Always formatted in Africa/Johannesburg. */
function formatSastRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const isToday =
    formatSastYMD(d) === formatSastYMD(today);
  if (isToday) {
    return new Intl.DateTimeFormat('en-ZA', {
      timeZone: SAST_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d);
  }
  return new Intl.DateTimeFormat('en-ZA', {
    timeZone: SAST_TZ, day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d).replace(',', '');
}

/** "12 Jul 2026, 14:32 SAST" — for the expanded message header. */
function formatSastLong(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-ZA', {
    timeZone: SAST_TZ,
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
  return `${parts} SAST`;
}

function formatSastYMD(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-ZA', {
    timeZone: SAST_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const y = parts.find(p => p.type === 'year')?.value ?? '';
  const m = parts.find(p => p.type === 'month')?.value ?? '';
  const day = parts.find(p => p.type === 'day')?.value ?? '';
  return `${y}-${m}-${day}`;
}
