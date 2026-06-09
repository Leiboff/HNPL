'use client';

import { useState, useMemo } from 'react';
import type { PracticeCard } from './page';

export default function ExploreView({ practices }: { practices: PracticeCard[] }) {
  const [search,    setSearch]    = useState('');
  const [specialty, setSpecialty] = useState<string | null>(null);

  const specialties = useMemo(() => {
    const seen = new Set<string>();
    practices.forEach((p) => { if (p.specialty) seen.add(p.specialty); });
    return Array.from(seen).sort();
  }, [practices]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return practices.filter((p) => {
      const matchesSearch    = !q || p.name.toLowerCase().includes(q);
      const matchesSpecialty = !specialty || p.specialty === specialty;
      return matchesSearch && matchesSpecialty;
    });
  }, [practices, search, specialty]);

  const chipStyle = (active: boolean) =>
    active
      ? { background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)', color: '#fff' }
      : { background: 'rgba(19,41,75,.06)', color: '#13294B' };

  return (
    <div className="space-y-4">
      {/* Search */}
      <input
        type="search"
        placeholder="Search practices…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-[#15A89E] focus:outline-none focus:ring-1 focus:ring-[#15A89E]"
      />

      {/* Specialty chips */}
      {specialties.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setSpecialty(null)}
            className="rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all"
            style={chipStyle(specialty === null)}
          >
            All
          </button>
          {specialties.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSpecialty(specialty === s ? null : s)}
              className="rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all"
              style={chipStyle(specialty === s)}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Results */}
      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-200 py-14 text-center">
          <p className="font-medium text-gray-500">No practices found</p>
          <p className="mt-1 text-sm text-gray-400">Try a different search or specialty.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((practice) => (
            <div
              key={practice.id}
              className="bg-white rounded-2xl border border-[rgba(19,41,75,.08)] shadow-sm px-5 py-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-gray-900 truncate">{practice.name}</p>
                  {practice.specialty && (
                    <p className="text-xs text-gray-400 mt-0.5">{practice.specialty}</p>
                  )}
                </div>
                {practice.phone && (
                  <a
                    href={`tel:${practice.phone}`}
                    className="shrink-0 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors shadow-sm"
                  >
                    Call
                  </a>
                )}
              </div>
              {practice.email && (
                <p className="mt-2 text-xs text-gray-400">{practice.email}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
