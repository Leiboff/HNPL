'use client';

/**
 * The one edit affordance for an inline-editable profile field: a bare
 * pencil, icon-only. Replaces three near-identical buttons that had each
 * grown their own label — "Change" on phone, "Edit" on salary date and
 * salary amount, "Add" on phone-when-empty — which read as three different
 * behaviours where there was only one. The icon plus a field-specific
 * aria-label carries the same meaning without the wording drift.
 */
export default function EditIconButton({
  label,
  onClick,
  testId,
}: {
  /** Accessible name, e.g. "Change phone" or "Edit salary date". */
  label:   string;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      data-testid={testId}
      className="shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-lg border border-gray-200 bg-white hover:bg-gray-50"
      style={{ color: '#13294B' }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
        <path d="M12 20h9" strokeLinecap="round" />
        <path d="m16.5 3.5 4 4L8 20l-4 1 1-4 11.5-13.5z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}
