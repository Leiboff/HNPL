// ─── Google Calendar deep-link builder ─────────────────────────────────
//
// Phase 1 has no Google OAuth. Instead, when a sales user schedules a
// call/meeting, the server returns a Google Calendar "template URL" the
// user can open in a new tab to add the event to their own calendar.
//
// Format: calendar.google.com/calendar/render?action=TEMPLATE
//   text     event title
//   dates    YYYYMMDDTHHmmssZ/YYYYMMDDTHHmmssZ (UTC, Z-suffixed)
//   details  free-text description
//   ctz      Africa/Johannesburg — hint for how Google renders the block
//
// Phase 2 seam: replace this with a real Calendar API insert once we
// pipe OAuth through. Guarded by CALENDAR_SYNC flag (see /crm/leads/actions).

import { SAST_TZ } from './timezone';

export const CALENDAR_SYNC = false as const; // Phase 2 flag

function toGCalUtc(d: Date): string {
  // YYYYMMDDTHHmmssZ
  const y  = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  const h  = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const s  = String(d.getUTCSeconds()).padStart(2, '0');
  return `${y}${mo}${da}T${h}${mi}${s}Z`;
}

export type CalendarLinkArgs = {
  title:    string;
  startUtc: Date;
  endUtc:   Date;
  details?: string;
  location?: string;
};

export function buildCalendarLink(args: CalendarLinkArgs): string {
  const params = new URLSearchParams();
  params.set('action', 'TEMPLATE');
  params.set('text',   args.title);
  params.set('dates',  `${toGCalUtc(args.startUtc)}/${toGCalUtc(args.endUtc)}`);
  if (args.details)  params.set('details',  args.details);
  if (args.location) params.set('location', args.location);
  params.set('ctz', SAST_TZ);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * Convenience: build a link from lead + scheduling inputs the CRM form
 * captures. Title defaults to the standard "betternow intro — {name}"
 * pattern per the Phase 1 spec.
 */
export function buildLeadCalendarLink(args: {
  practiceName:   string;
  contactName:    string | null;
  contactPhone:   string | null;
  startUtc:       Date;
  durationMin:    number;
  overrideTitle?: string;
  notes?:         string;
}): string {
  const title = args.overrideTitle?.trim() || `betternow intro — ${args.practiceName}`;
  const endUtc = new Date(args.startUtc.getTime() + args.durationMin * 60_000);
  const detailLines: string[] = [];
  if (args.contactName)  detailLines.push(`Contact: ${args.contactName}`);
  if (args.contactPhone) detailLines.push(`Phone: ${args.contactPhone}`);
  if (args.notes)        detailLines.push('', args.notes);
  return buildCalendarLink({
    title,
    startUtc: args.startUtc,
    endUtc,
    details: detailLines.length ? detailLines.join('\n') : undefined,
  });
}
