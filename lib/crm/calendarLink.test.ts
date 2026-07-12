import { describe, it, expect } from 'vitest';
import { buildCalendarLink, buildLeadCalendarLink } from './calendarLink';
import { sastLocalToUtc } from './timezone';

describe('Google Calendar deep-link builder', () => {
  it('encodes the required TEMPLATE params in UTC + ctz Africa/Johannesburg', () => {
    const startUtc = sastLocalToUtc('2026-06-25', '14:00');  // 12:00 UTC
    const endUtc   = new Date(startUtc.getTime() + 30 * 60_000);

    const url = buildCalendarLink({
      title:  'betternow intro — Rosebank Dental',
      startUtc,
      endUtc,
      details: 'Contact: Alice Smith\nPhone: +27 82 111 2222',
    });

    expect(url.startsWith('https://calendar.google.com/calendar/render?')).toBe(true);
    const q = new URL(url).searchParams;
    expect(q.get('action')).toBe('TEMPLATE');
    expect(q.get('text')).toBe('betternow intro — Rosebank Dental');
    expect(q.get('dates')).toBe('20260625T120000Z/20260625T123000Z');
    expect(q.get('ctz')).toBe('Africa/Johannesburg');
    expect(q.get('details')).toBe('Contact: Alice Smith\nPhone: +27 82 111 2222');
  });

  it('buildLeadCalendarLink defaults the title to "betternow intro — {practice}"', () => {
    const startUtc = sastLocalToUtc('2026-06-25', '14:00');
    const url = buildLeadCalendarLink({
      practiceName: 'Rosebank Dental',
      contactName:  'Alice Smith',
      contactPhone: '+27 82 111 2222',
      startUtc,
      durationMin:  45,
    });
    const q = new URL(url).searchParams;
    expect(q.get('text')).toBe('betternow intro — Rosebank Dental');
    // 14:00 SAST + 45min → end at 14:45 SAST = 12:45 UTC
    expect(q.get('dates')).toBe('20260625T120000Z/20260625T124500Z');
    // Contact details land in the description
    expect(q.get('details')).toContain('Alice Smith');
    expect(q.get('details')).toContain('+27 82 111 2222');
  });

  it('buildLeadCalendarLink respects an override title', () => {
    const startUtc = sastLocalToUtc('2026-06-25', '14:00');
    const url = buildLeadCalendarLink({
      practiceName:  'Rosebank Dental',
      contactName:   null,
      contactPhone:  null,
      startUtc,
      durationMin:   30,
      overrideTitle: 'Second meeting — pricing review',
    });
    expect(new URL(url).searchParams.get('text')).toBe('Second meeting — pricing review');
  });
});
