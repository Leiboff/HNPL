'use client';

import { useState, useRef, useEffect } from 'react';
import { formatLocalDate } from './billHelpers';

type Props = {
  fromDate: string; // "YYYY-MM-DD" or ""
  toDate:   string;
  onChange: (from: string, to: string) => void;
};

const MONTH_NAMES  = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const SHORT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAY_HEADERS  = ['Su','Mo','Tu','We','Th','Fr','Sa'];

function displayLabel(from: string, to: string): string {
  if (!from && !to) return 'All dates';
  const fmt = (s: string) => {
    const [y, m, d] = s.split('-');
    return `${parseInt(d, 10)} ${SHORT_MONTHS[parseInt(m, 10) - 1]} ${y}`;
  };
  if (from && to && from === to) return fmt(from);
  if (from && to)  return `${fmt(from)} – ${fmt(to)}`;
  if (from)        return `From ${fmt(from)}`;
  return `To ${fmt(to)}`;
}

function toYMD(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function buildGrid(year: number, month: number): (number | null)[] {
  const firstDow    = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = Array(firstDow).fill(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoStr(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function thisMonthStart(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function thisYearStart(): string {
  return `${new Date().getFullYear()}-01-01`;
}

export default function DateRangePicker({ fromDate, toDate, onChange }: Props) {
  const [open,      setOpen]      = useState(false);
  const [viewYear,  setViewYear]  = useState(() => new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(() => new Date().getMonth());
  const [phase,     setPhase]     = useState<'from' | 'to'>('from');
  const [draftFrom, setDraftFrom] = useState('');
  const [hovered,   setHovered]   = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  function handleOpen() {
    setDraftFrom('');
    setPhase('from');
    setHovered('');
    if (fromDate) {
      const [y, m] = fromDate.split('-').map(Number);
      setViewYear(y);
      setViewMonth(m - 1);
    } else {
      const now = new Date();
      setViewYear(now.getFullYear());
      setViewMonth(now.getMonth());
    }
    setOpen(true);
  }

  function prevMonth() {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); }
    else setViewMonth(m => m - 1);
  }

  function nextMonth() {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); }
    else setViewMonth(m => m + 1);
  }

  function handleDayClick(dayStr: string) {
    if (phase === 'from') {
      setDraftFrom(dayStr);
      setPhase('to');
    } else {
      if (dayStr < draftFrom) {
        // Clicked before start — restart from this day
        setDraftFrom(dayStr);
      } else {
        // Valid end (or same-day) — apply immediately and close
        onChange(draftFrom, dayStr);
        setOpen(false);
      }
    }
  }

  function applyPreset(from: string, to: string) {
    onChange(from, to);
    setOpen(false);
  }

  function handleClear() {
    onChange('', '');
    setOpen(false);
  }

  // Hover preview: only show when picking 'to' and hover is at or after draftFrom
  const effectiveTo = phase === 'to' && hovered && draftFrom && hovered >= draftFrom ? hovered : '';

  function cellStyle(dayStr: string): string {
    const isFrom  = phase === 'to' && dayStr === draftFrom;
    const isTo    = effectiveTo !== '' && dayStr === effectiveTo;
    const inRange = draftFrom && effectiveTo && dayStr > draftFrom && dayStr < effectiveTo;
    const isToday = dayStr === todayStr();

    if (isFrom || isTo)   return 'text-white font-semibold rounded-lg [background:linear-gradient(135deg,var(--portal-ink)_0%,var(--portal-accent)_145%)]';
    if (inRange)          return 'bg-[var(--portal-accent)]/10 text-[var(--portal-ink)] rounded-lg';
    if (isToday)          return 'text-[var(--portal-accent)] font-bold rounded-lg hover:bg-gray-100';
    return 'text-gray-700 rounded-lg hover:bg-gray-100';
  }

  const isFiltered = Boolean(fromDate || toDate);
  const cells      = buildGrid(viewYear, viewMonth);

  return (
    <div ref={containerRef} className="relative">

      {/* ── Trigger ──────────────────────────────────────────────── */}
      <button
        onClick={open ? () => setOpen(false) : handleOpen}
        className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors select-none ${
          isFiltered
            ? 'border-blue-300 bg-blue-50 text-blue-700 font-medium'
            : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50 shadow-sm'
        }`}
      >
        <svg className="w-3.5 h-3.5 shrink-0 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        <span>{displayLabel(fromDate, toDate)}</span>
        {isFiltered ? (
          <span
            role="button"
            tabIndex={0}
            aria-label="Clear date filter"
            onClick={e => { e.stopPropagation(); onChange('', ''); }}
            onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); onChange('', ''); }}}
            className="ml-0.5 text-blue-400 hover:text-blue-700"
          >
            ✕
          </span>
        ) : (
          <svg className="w-3 h-3 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        )}
      </button>

      {/* ── Popover ──────────────────────────────────────────────── */}
      {open && (
        <div className="absolute right-0 top-full mt-2 bg-white rounded-2xl border border-gray-200 shadow-xl z-50 p-4 w-72">

          {/* Dynamic instruction */}
          <p className="text-[11px] text-gray-400 mb-3 min-h-[16px]">
            {phase === 'from'
              ? 'Select a start date'
              : <>Start: <span className="font-semibold text-gray-600">{formatLocalDate(draftFrom)}</span> — now select an end date</>
            }
          </p>

          {/* Month navigation */}
          <div className="flex items-center justify-between mb-3">
            <button
              onClick={prevMonth}
              className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-700 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <span className="text-sm font-semibold text-gray-900">
              {MONTH_NAMES[viewMonth]} {viewYear}
            </span>
            <button
              onClick={nextMonth}
              className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-700 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>

          {/* Day-of-week headers */}
          <div className="grid grid-cols-7 mb-1">
            {DAY_HEADERS.map(d => (
              <div key={d} className="text-center text-[10px] font-semibold text-gray-400 py-1">
                {d}
              </div>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7 gap-y-0.5">
            {cells.map((day, i) => {
              if (day === null) return <div key={i} className="h-8" />;
              const dayStr = toYMD(viewYear, viewMonth, day);
              return (
                <button
                  key={i}
                  onClick={() => handleDayClick(dayStr)}
                  onMouseEnter={() => setHovered(dayStr)}
                  onMouseLeave={() => setHovered('')}
                  className={`h-8 w-full text-xs transition-colors ${cellStyle(dayStr)}`}
                >
                  {day}
                </button>
              );
            })}
          </div>

          {/* Presets + clear */}
          <div className="mt-3 pt-3 border-t border-gray-100">
            <div className="flex flex-wrap gap-1.5 mb-2">
              {[
                { label: 'Last 7d',    from: daysAgoStr(7),   to: todayStr() },
                { label: 'Last 30d',   from: daysAgoStr(30),  to: todayStr() },
                { label: 'This month', from: thisMonthStart(), to: todayStr() },
                { label: 'This year',  from: thisYearStart(),  to: todayStr() },
              ].map(p => (
                <button
                  key={p.label}
                  onClick={() => applyPreset(p.from, p.to)}
                  className="px-2.5 py-1 text-[11px] font-medium rounded-full border border-gray-200 text-gray-600 hover:border-blue-300 hover:text-blue-700 hover:bg-blue-50 transition-colors"
                >
                  {p.label}
                </button>
              ))}
            </div>
            <button
              onClick={handleClear}
              className="text-[11px] text-gray-400 hover:text-gray-600 transition-colors"
            >
              Clear filter
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
