// Shared formatting helpers for the admin portal. Kept local to /admin
// (under _lib so the file isn't accidentally treated as a route) — these
// are admin-specific presentation utilities, not domain logic.

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

export function formatRand(n: number): string {
  const [integer, decimal] = n.toFixed(2).split('.');
  return `R${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimal}`;
}

/** "2026-06-15" → "15 Jun 2026" */
export function formatDateStr(s: string): string {
  const [year, month, day] = s.split('-').map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

/** ISO timestamp → "15 Jun 2026" */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** ISO timestamp → relative "2h ago" / "5d ago" string. */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(iso).getTime();
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  return `${days}d ago`;
}

type NameRef = { first_name: string; last_name: string };

export function fullName(p: NameRef | NameRef[] | null | undefined): string {
  const ref = Array.isArray(p) ? p[0] : p;
  if (!ref) return '—';
  return `${ref.first_name} ${ref.last_name}`;
}

type PracticeRef = { name: string };

export function practiceName(p: PracticeRef | PracticeRef[] | null | undefined): string {
  const ref = Array.isArray(p) ? p[0] : p;
  return ref?.name ?? '—';
}
