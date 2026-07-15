// ─── Timeline grouping — email conversations vs standalone activities
//
// The timeline arrives newest-first (occurred_at desc, 200 rows). We
// group email + email_reply rows that share a gmail_thread_id into
// ONE conversation card, positioned at the LATEST message's
// timestamp. Non-email activities interleave chronologically.
//
// Pure function so it's easy to unit-test the grouping shape.

export type TimelineActivity = {
  id:                string;
  type:              string;
  title:             string;
  body:              string | null;
  occurred_at:       string;
  created_at:        string;
  created_by:        string | null;
  sent_from:         string | null;
  reply_from:        string | null;
  gmail_thread_id:   string | null;
  gmail_message_id:  string | null;
};

export type ConversationItem = {
  kind:        'conversation';
  threadId:    string;
  /** Order-stable id for React (== threadId). */
  key:         string;
  messages:    TimelineActivity[];   // oldest → newest
  latest:      TimelineActivity;
  /** occurred_at of the latest message — used to place the card. */
  positionAt:  string;
};

export type StandaloneItem = {
  kind:  'activity';
  key:   string;
  activity: TimelineActivity;
  /** occurred_at, same as activity.occurred_at — kept as its own
   *  field so callers sort a mixed list uniformly. */
  positionAt: string;
};

export type TimelineItem = ConversationItem | StandaloneItem;

const EMAIL_TYPES = new Set(['email', 'email_reply']);

/**
 * Group an activity list (any order) into a mixed timeline.
 * Conversations gather all email/email_reply rows sharing a
 * gmail_thread_id — regardless of intervening non-email activities.
 * Everything is ordered newest-first by positionAt.
 */
export function groupTimeline(activities: TimelineActivity[]): TimelineItem[] {
  const conversations = new Map<string, TimelineActivity[]>();
  const standalones: StandaloneItem[] = [];

  for (const a of activities) {
    if (EMAIL_TYPES.has(a.type) && a.gmail_thread_id) {
      const arr = conversations.get(a.gmail_thread_id) ?? [];
      arr.push(a);
      conversations.set(a.gmail_thread_id, arr);
    } else {
      standalones.push({
        kind:       'activity',
        key:        a.id,
        activity:   a,
        positionAt: a.occurred_at,
      });
    }
  }

  const convItems: ConversationItem[] = [];
  for (const [threadId, msgs] of conversations.entries()) {
    const sorted = [...msgs].sort(compareByOccurredAtAsc);
    const latest = sorted[sorted.length - 1];
    convItems.push({
      kind:       'conversation',
      threadId,
      key:        threadId,
      messages:   sorted,
      latest,
      positionAt: latest.occurred_at,
    });
  }

  return [...convItems, ...standalones].sort(compareByPositionAtDesc);
}

function compareByOccurredAtAsc(a: TimelineActivity, b: TimelineActivity): number {
  const ta = Date.parse(a.occurred_at);
  const tb = Date.parse(b.occurred_at);
  return ta - tb;
}

function compareByPositionAtDesc(a: TimelineItem, b: TimelineItem): number {
  const ta = Date.parse(a.positionAt);
  const tb = Date.parse(b.positionAt);
  return tb - ta;
}

/** Participant summary: unique addresses seen in the thread. Sender
 *  of latest message first, then remaining unique addresses in
 *  first-seen order. Used for the collapsed conversation header. */
export function participantSummary(messages: TimelineActivity[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const addAddress = (address: string | null) => {
    if (!address) return;
    const lc = address.toLowerCase();
    if (seen.has(lc)) return;
    seen.add(lc);
    out.push(address);
  };
  for (const m of messages) {
    if (m.type === 'email') {
      addAddress(m.sent_from);
      // The other party on outbound is the lead — we don't have it in
      // the activity row directly; the caller can pass lead.email
      // when it wants a "You + Alice" style summary. This helper
      // returns only what's on the activities themselves.
    } else if (m.type === 'email_reply') {
      addAddress(m.reply_from);
    }
  }
  return out;
}

/** Strip a single leading Re:/RE:/re: (case-insensitive), used for
 *  the conversation card title. */
export function stripReSubject(subject: string): string {
  if (!subject) return '';
  return subject.replace(/^\s*re\s*:\s*/i, '').trim();
}

/** Recover a display subject from an outbound activity's title
 *  (`Email sent: ${subject.slice(0, 60)}`). For inbound `email_reply`
 *  rows the title is `Reply from …` — return an empty string so the
 *  caller can walk the thread for a subject. */
export function deriveSubjectFromActivity(activity: TimelineActivity): string {
  if (!activity.title) return '';
  const m = activity.title.match(/^Email sent:\s*(.+)$/);
  return m ? m[1].trim() : '';
}

/** Pick a display subject for a conversation. Prefers the oldest
 *  outbound activity's subject (that's the thread's original
 *  subject), else the latest activity's title as-is. */
export function conversationSubject(messages: TimelineActivity[]): string {
  const sorted = [...messages].sort(compareByOccurredAtAsc);
  for (const m of sorted) {
    if (m.type === 'email') {
      const s = deriveSubjectFromActivity(m);
      if (s) return stripReSubject(s);
    }
  }
  // Last resort: try to strip "Reply from " off the latest activity.
  const latest = sorted[sorted.length - 1];
  if (latest?.title) {
    const m = latest.title.match(/^Reply from\s*(.+)$/);
    return m ? '' : latest.title;
  }
  return '';
}
