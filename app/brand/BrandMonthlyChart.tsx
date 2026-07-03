'use client';

import { useMemo } from 'react';
import type { MonthPoint } from '@/lib/brand/monthlyRevenue';

// ─── Reusable 12-month bar chart for brand surfaces ───────────────────
//
// Consumes a MonthPoint[] pre-aggregated by buildMonthlySeries — the
// chart is a rendering primitive, NOT a query owner. Adopts the same
// SVG shape as the practice-side MonthlyRevenueChart so the visual
// language is consistent across the app, but takes gross/net as a
// prop (the practice chart is net-only). Consumers switching modes
// re-render this with a different `mode`.

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

type Props = {
  points: MonthPoint[];
  mode:   'gross' | 'net';
  title?: string;
};

export default function BrandMonthlyChart({ points, mode, title }: Props) {
  const values = useMemo(() => points.map((p) => (mode === 'gross' ? p.gross : p.net)), [points, mode]);
  const yMax   = niceMax(Math.max(...values, 0));
  const N_TICK = 4;

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

  const heading = title ?? `Monthly ${mode === 'gross' ? 'gross' : 'net'} revenue — last 12 months`;

  return (
    <div className="bg-white rounded-2xl border border-[rgba(19,41,75,.08)] shadow-sm p-6">
      <p
        className="text-xs font-semibold uppercase tracking-widest mb-5"
        style={{ color: '#13294B', opacity: 0.55 }}
      >
        {heading}
      </p>

      <svg viewBox={`0 0 ${VW} ${VH}`} className="w-full" style={{ height: 'auto' }} aria-hidden>
        <defs>
          <linearGradient id="brandBarGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="#15A89E" stopOpacity={0.9} />
            <stop offset="100%" stopColor="#13294B" stopOpacity={0.8} />
          </linearGradient>
        </defs>

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

        {points.map((p, i) => {
          const v = mode === 'gross' ? p.gross : p.net;
          const h = bH(v);
          const x = xPos(i);
          const y = yPos(v);
          return (
            <g key={p.key}>
              {h > 0 ? (
                <rect x={x} y={y} width={barW} height={h} rx={4} fill="url(#brandBarGrad)" />
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
                {p.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
