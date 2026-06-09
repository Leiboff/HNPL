'use client';

import { useMemo } from 'react';
import { calculateFee } from '@/lib/finance';
import type { PlanSummary } from './billHelpers';

const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const COUNTED_STATUSES = new Set(['pending_acceptance', 'active', 'completed']);

function lastTwelveMonths() {
  const now = new Date();
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - 11 + i, 1);
    return { year: d.getFullYear(), month: d.getMonth() + 1, label: MONTH_ABBR[d.getMonth()] };
  });
}

function niceMax(v: number): number {
  if (v <= 0) return 5000;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.ceil(v / mag) * mag;
}

function shortAmt(v: number): string {
  if (v >= 1_000_000) return `R${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `R${(v / 1_000).toFixed(0)}k`;
  return `R${v.toFixed(0)}`;
}

export default function MonthlyRevenueChart({
  plans,
  feePercent,
}: {
  plans: PlanSummary[];
  feePercent: number;
}) {
  const months = useMemo(() => lastTwelveMonths(), []);

  const data = useMemo(() =>
    months.map(({ year, month, label }) => {
      const net = plans
        .filter((p) => {
          if (!COUNTED_STATUSES.has(p.status)) return false;
          const d = new Date(p.created_at);
          return d.getFullYear() === year && d.getMonth() + 1 === month;
        })
        .reduce((sum, p) => {
          const { net } = calculateFee(Number(p.total_amount), feePercent);
          return sum + net;
        }, 0);
      return { label, net, key: `${year}-${month}` };
    }),
  [plans, months, feePercent]);

  const yMax   = niceMax(Math.max(...data.map((d) => d.net), 0));
  const N_TICK = 4;

  // SVG coordinate space
  const VW = 800, VH = 240;
  const PAD = { t: 16, r: 16, b: 44, l: 60 };
  const plotW = VW - PAD.l - PAD.r;
  const plotH = VH - PAD.t - PAD.b;
  const slotW = plotW / 12;
  const barW  = slotW * 0.5;

  const yTicks = Array.from({ length: N_TICK + 1 }, (_, i) => (yMax * i) / N_TICK);

  const xPos = (i: number) => PAD.l + i * slotW + (slotW - barW) / 2;
  const yPos = (v: number) => PAD.t + plotH - (v / yMax) * plotH;
  const bH   = (v: number) => Math.max((v / yMax) * plotH, 0);

  return (
    <div className="bg-white rounded-2xl border border-[rgba(19,41,75,.08)] shadow-sm p-6">
      <p
        className="text-xs font-semibold uppercase tracking-widest mb-5"
        style={{ color: '#13294B', opacity: 0.55 }}
      >
        Monthly net revenue — last 12 months
      </p>

      <svg viewBox={`0 0 ${VW} ${VH}`} className="w-full" style={{ height: 'auto' }} aria-hidden>
        <defs>
          <linearGradient id="practiceBarGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="#15A89E" stopOpacity={0.9} />
            <stop offset="100%" stopColor="#13294B" stopOpacity={0.8} />
          </linearGradient>
        </defs>

        {/* Y axis gridlines + labels */}
        {yTicks.map((tick, i) => (
          <g key={i}>
            <line
              x1={PAD.l} y1={yPos(tick)}
              x2={VW - PAD.r} y2={yPos(tick)}
              stroke="rgba(19,41,75,.06)" strokeWidth={1}
            />
            <text
              x={PAD.l - 8} y={yPos(tick)}
              textAnchor="end" dominantBaseline="middle"
              fontSize={10.5} fill="rgba(19,41,75,.38)"
              fontFamily="system-ui,sans-serif"
            >
              {shortAmt(tick)}
            </text>
          </g>
        ))}

        {/* Bars */}
        {data.map((d, i) => {
          const h = bH(d.net);
          const x = xPos(i);
          const y = yPos(d.net);
          return (
            <g key={d.key}>
              {h > 0 ? (
                <rect x={x} y={y} width={barW} height={h} rx={4} fill="url(#practiceBarGrad)" />
              ) : (
                <rect
                  x={x} y={PAD.t + plotH - 2} width={barW} height={2}
                  rx={1} fill="rgba(19,41,75,.08)"
                />
              )}
              <text
                x={x + barW / 2} y={PAD.t + plotH + 14}
                textAnchor="middle" fontSize={11} fill="rgba(19,41,75,.42)"
                fontFamily="system-ui,sans-serif"
              >
                {d.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
