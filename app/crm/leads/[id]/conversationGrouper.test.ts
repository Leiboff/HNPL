import { describe, it, expect } from 'vitest';
import {
  groupTimeline,
  conversationSubject,
  stripReSubject,
  deriveSubjectFromActivity,
  participantSummary,
  type TimelineActivity,
} from './conversationGrouper';

// ─── Timeline grouping — pure function tests ───────────────────────

function mkActivity(overrides: Partial<TimelineActivity>): TimelineActivity {
  return {
    id:               'x',
    type:             'note',
    title:            'x',
    body:             null,
    occurred_at:      '2026-07-01T00:00:00.000Z',
    created_at:       '2026-07-01T00:00:00.000Z',
    created_by:       null,
    sent_from:        null,
    reply_from:       null,
    gmail_thread_id:  null,
    gmail_message_id: null,
    ...overrides,
  };
}

describe('groupTimeline — mixed feed', () => {
  it('groups 2 threads + notes + calls correctly, ordered by latest message desc', () => {
    // Thread A: two messages (outbound at 10:00, inbound at 12:00)
    // Thread B: one outbound at 11:00
    // Plus a note at 13:00 and a call at 09:00.
    const items = [
      mkActivity({ id: 'note-1',    type: 'note',         occurred_at: '2026-07-01T13:00:00Z' }),
      mkActivity({ id: 'call-1',    type: 'call',         occurred_at: '2026-07-01T09:00:00Z' }),
      mkActivity({ id: 'A-out',     type: 'email',        occurred_at: '2026-07-01T10:00:00Z',
                   gmail_thread_id: 'A', gmail_message_id: 'A-1', title: 'Email sent: Intro' }),
      mkActivity({ id: 'A-in',      type: 'email_reply',  occurred_at: '2026-07-01T12:00:00Z',
                   gmail_thread_id: 'A', gmail_message_id: 'A-2', reply_from: 'alice@x.com' }),
      mkActivity({ id: 'B-out',     type: 'email',        occurred_at: '2026-07-01T11:00:00Z',
                   gmail_thread_id: 'B', gmail_message_id: 'B-1', title: 'Email sent: Question' }),
    ];

    const timeline = groupTimeline(items);

    // Order desc by positionAt: note-1 (13:00), thread-A latest (12:00),
    // thread-B latest (11:00), call-1 (09:00).
    expect(timeline.length).toBe(4);
    expect(timeline[0].kind).toBe('activity');
    if (timeline[0].kind === 'activity') expect(timeline[0].activity.id).toBe('note-1');

    expect(timeline[1].kind).toBe('conversation');
    if (timeline[1].kind === 'conversation') {
      expect(timeline[1].threadId).toBe('A');
      // Two messages, oldest → newest.
      expect(timeline[1].messages.map(m => m.id)).toEqual(['A-out', 'A-in']);
      expect(timeline[1].latest.id).toBe('A-in');
    }

    expect(timeline[2].kind).toBe('conversation');
    if (timeline[2].kind === 'conversation') expect(timeline[2].threadId).toBe('B');

    expect(timeline[3].kind).toBe('activity');
    if (timeline[3].kind === 'activity') expect(timeline[3].activity.id).toBe('call-1');
  });

  it('legacy activities without gmail_thread_id render as standalone', () => {
    const items = [
      mkActivity({ id: 'legacy-email', type: 'email', occurred_at: '2026-07-01T10:00:00Z', gmail_thread_id: null }),
      mkActivity({ id: 'legacy-reply', type: 'email_reply', occurred_at: '2026-07-01T11:00:00Z', gmail_thread_id: null }),
    ];
    const t = groupTimeline(items);
    expect(t.length).toBe(2);
    expect(t.every(x => x.kind === 'activity')).toBe(true);
  });

  it('empty input → empty timeline', () => {
    expect(groupTimeline([])).toEqual([]);
  });

  it('single-message thread still renders as a conversation', () => {
    const items = [
      mkActivity({
        id: 'A-out', type: 'email', occurred_at: '2026-07-01T10:00:00Z',
        gmail_thread_id: 'A', gmail_message_id: 'A-1', title: 'Email sent: Intro',
      }),
    ];
    const t = groupTimeline(items);
    expect(t.length).toBe(1);
    expect(t[0].kind).toBe('conversation');
    if (t[0].kind === 'conversation') expect(t[0].messages.length).toBe(1);
  });
});

describe('conversationSubject — recovers from activity titles', () => {
  it('picks the oldest outbound subject and strips Re:', () => {
    const msgs = [
      mkActivity({ id: 'A-1', type: 'email',       occurred_at: '2026-07-01T10:00Z', title: 'Email sent: Re: Original ask' }),
      mkActivity({ id: 'A-2', type: 'email_reply', occurred_at: '2026-07-01T11:00Z', title: 'Reply from Alice' }),
    ];
    expect(conversationSubject(msgs)).toBe('Original ask');
  });

  it('preserves the subject when no Re: prefix', () => {
    const msgs = [
      mkActivity({ type: 'email', occurred_at: '2026-07-01T10:00Z', title: 'Email sent: A quick intro' }),
    ];
    expect(conversationSubject(msgs)).toBe('A quick intro');
  });

  it('returns empty when only email_reply rows exist (title is "Reply from …")', () => {
    const msgs = [
      mkActivity({ type: 'email_reply', title: 'Reply from Alice' }),
    ];
    expect(conversationSubject(msgs)).toBe('');
  });
});

describe('stripReSubject', () => {
  it('strips a single leading Re:/RE:/re:', () => {
    expect(stripReSubject('Re: foo')).toBe('foo');
    expect(stripReSubject('RE: foo')).toBe('foo');
    expect(stripReSubject('re: foo')).toBe('foo');
  });

  it('leaves non-Re: prefixes intact (Fwd: not stripped)', () => {
    expect(stripReSubject('Fwd: intro')).toBe('Fwd: intro');
  });

  it('empty passes through', () => {
    expect(stripReSubject('')).toBe('');
  });
});

describe('deriveSubjectFromActivity', () => {
  it('extracts the subject from an outbound title', () => {
    expect(deriveSubjectFromActivity(mkActivity({ title: 'Email sent: hello' }))).toBe('hello');
  });

  it('returns empty for inbound titles', () => {
    expect(deriveSubjectFromActivity(mkActivity({ title: 'Reply from Alice' }))).toBe('');
  });
});

describe('participantSummary', () => {
  it('lists unique participants in first-seen order', () => {
    const msgs = [
      mkActivity({ type: 'email',       sent_from: 'sam@x.com' }),
      mkActivity({ type: 'email_reply', reply_from: 'alice@rosebank.co.za' }),
      mkActivity({ type: 'email',       sent_from: 'sam@x.com' }),  // dedup
    ];
    expect(participantSummary(msgs)).toEqual(['sam@x.com', 'alice@rosebank.co.za']);
  });
});
