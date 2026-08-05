import { StatCard } from 'hnpl';

export function Default() {
  return (
    <div style={{ maxWidth: 260, padding: 20 }}>
      <StatCard label="Due today" value="R12,400" sublabel="8 instalments" />
    </div>
  );
}

export function Tones() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, padding: 20, maxWidth: 560 }}>
      <StatCard label="Collected · 30d" value="R84,200" tone="good" />
      <StatCard label="Overdue" value="R6,150" tone="warn" href="/admin/collections" />
      <StatCard label="At risk" value="R3,900" tone="alert" href="/admin/collections" />
      <StatCard label="Active plans" value="142" sublabel="across 38 practices" />
    </div>
  );
}
