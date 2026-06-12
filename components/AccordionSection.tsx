'use client';

import { useId } from 'react';

type Props = {
  /** Section header text. */
  title: string;
  /** One-line summary shown on the right when collapsed. Hidden when open. */
  summary?: React.ReactNode;
  /** Controlled open state. */
  open: boolean;
  /** Called when the user activates the header (click / Enter / Space). */
  onToggle: () => void;
  /** Section body (revealed when open). */
  children: React.ReactNode;
};

/**
 * Disclosure-pattern accordion section. Each instance is a single section:
 * a header row (button + title + summary + chevron) that is always
 * visible, plus a panel that expands/collapses smoothly. Multiple
 * AccordionSection instances can be open simultaneously — open state is
 * controlled by the parent.
 *
 * Smooth height animation uses the grid-rows trick (0fr ↔ 1fr) so it works
 * with arbitrary content heights without measuring.
 */
export default function AccordionSection({
  title,
  summary,
  open,
  onToggle,
  children,
}: Props) {
  const idBase   = useId();
  const buttonId = `${idBase}-button`;
  const panelId  = `${idBase}-panel`;

  return (
    <div className="bg-white rounded-2xl border border-[rgba(19,41,75,.08)] shadow-sm overflow-hidden">
      <button
        type="button"
        id={buttonId}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-gray-50 focus-visible:outline-none focus-visible:bg-gray-50 focus-visible:ring-2 focus-visible:ring-[#15A89E] focus-visible:ring-inset transition-colors min-h-15"
      >
        <p className="text-sm font-semibold shrink-0" style={{ color: '#13294B' }}>
          {title}
        </p>
        {!open && summary != null && summary !== '' && (
          <p className="text-xs text-gray-500 truncate min-w-0 flex-1 text-right" data-testid="accordion-summary">
            {summary}
          </p>
        )}
        <svg
          aria-hidden
          viewBox="0 0 20 20"
          className={`w-4 h-4 shrink-0 text-gray-400 transition-transform duration-200 ${open ? 'rotate-180' : ''} ${!open && summary != null && summary !== '' ? '' : 'ml-auto'}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 8l4 4 4-4" />
        </svg>
      </button>
      <div
        id={panelId}
        role="region"
        aria-labelledby={buttonId}
        aria-hidden={!open}
        className={`grid transition-[grid-template-rows] duration-300 ease-out ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
      >
        <div className="overflow-hidden min-h-0">
          <div className="px-5 pb-5 pt-3 border-t border-gray-100">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
