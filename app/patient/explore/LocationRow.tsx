'use client';

// ─── LocationRow — Discovery-Health-style location strip ────────────────
//
// Replaces the older "Use my location" pill + "Near your current
// location" caption. One tap-target under the practitioner search bar:
//   [Location]                     [📍 Suburb, City]  (teal)
//   [Location]                     [📍 Choose location] (teal)
//   [Location]                     [📍 Locating…]     (teal)
//
// Tapping anywhere on the row opens ChangeLocationSheet (owned by the
// parent). Value color is always teal (#15A89E) so the row reads as
// interactive — never blends into the background.

type Props = {
  /** Suburb, City string (once resolved) or null when unknown. */
  label:    string | null;
  /** True while a background lookup (GPS + reverse-geocode) is in flight. */
  loading?: boolean;
  onOpen:   () => void;
};

export default function LocationRow({ label, loading = false, onOpen }: Props) {
  const value =
    label ? label :
    loading ? 'Locating…' :
    'Choose location';

  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="location-row"
      className="w-full rounded-2xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm px-4 py-3 flex items-center justify-between gap-3 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-[#15A89E]/25"
      aria-label={`Change location. Current: ${value}`}
    >
      <span className="text-sm font-semibold" style={{ color: '#13294B' }}>
        Location
      </span>
      <span
        className="inline-flex items-center gap-1.5 text-sm font-semibold truncate"
        style={{ color: '#15A89E' }}
        data-testid="location-row-value"
      >
        <PinIcon />
        {value}
      </span>
    </button>
  );
}

function PinIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      aria-hidden
      className="shrink-0"
    >
      <path d="M12 22s7-7 7-12a7 7 0 0 0-14 0c0 5 7 12 7 12z" strokeLinejoin="round" />
      <circle cx="12" cy="10" r="2.5" />
    </svg>
  );
}
