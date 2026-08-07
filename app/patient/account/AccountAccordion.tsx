'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import AccordionSection from '@/components/AccordionSection';

// ─── Account settings accordion ──────────────────────────────────────────
//
// The single settings pattern for the consolidated Account page. Every
// settings section is an AccordionSection in ONE system — Personal details,
// How you pay, Notifications, Security & sign-in — so no section is a
// foreign flat block. Salary date is NOT its own section: it lives nested
// inside Personal details.
//
// Settings sections start collapsed, EXCEPT "How you pay", which starts
// open so saved cards stay visible on arrival (it's still a real toggleable
// section in the same system — same header, chevron, and a11y). Arriving
// with `?section=<key>` also opens that one (so a deep-link lands on what
// was tapped). Legacy `?section=salary` links — from before salary folded
// into Personal details — resolve to `personal`.

type SectionKey = 'personal' | 'pay' | 'notifications' | 'security';

const SECTION_KEYS: readonly SectionKey[] = ['personal', 'pay', 'notifications', 'security'];

// "How you pay" is open on load so cards are visible without a tap.
const DEFAULT_OPEN: SectionKey = 'pay';

function resolveSection(value: string | null): SectionKey | null {
  if (value === 'salary') return 'personal'; // salary now lives inside Personal details
  return value != null && (SECTION_KEYS as readonly string[]).includes(value)
    ? (value as SectionKey)
    : null;
}

type Props = {
  /** Locked identity fields + phone + nested Salary date. */
  personalDetails: React.ReactNode;
  /** Cards surface body (PCI copy + PaymentMethods) — the "How you pay"
      heading is this section's accordion header, so it's not repeated in
      the body. Rendered as an accordion section (default-open) between
      Personal details and Notifications. */
  howYouPay: React.ReactNode;
  /** Client NotificationsToggle. */
  notifications: React.ReactNode;
  /** Client PasskeysSection. */
  security: React.ReactNode;
};

export default function AccountAccordion({
  personalDetails,
  howYouPay,
  notifications,
  security,
}: Props) {
  const searchParams = useSearchParams();
  const [open, setOpen] = useState<Set<SectionKey>>(() => {
    // "How you pay" is open by default (cards visible); a deep-link opens
    // its section too. Both can be open — sections aren't mutually exclusive.
    const initial = new Set<SectionKey>([DEFAULT_OPEN]);
    const deep = resolveSection(searchParams?.get('section') ?? null);
    if (deep) initial.add(deep);
    return initial;
  });

  function toggle(s: SectionKey) {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(s)) next.delete(s);
      else            next.add(s);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-[14px]">
      <AccordionSection
        title="Personal details"
        open={open.has('personal')}
        onToggle={() => toggle('personal')}
      >
        {personalDetails}
      </AccordionSection>

      <AccordionSection
        title="How you pay"
        open={open.has('pay')}
        onToggle={() => toggle('pay')}
      >
        {howYouPay}
      </AccordionSection>

      <AccordionSection
        title="Notifications"
        open={open.has('notifications')}
        onToggle={() => toggle('notifications')}
      >
        {notifications}
      </AccordionSection>

      <AccordionSection
        title="Security & sign-in"
        open={open.has('security')}
        onToggle={() => toggle('security')}
      >
        <div className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">
            Passkeys
          </p>
          {security}
        </div>
      </AccordionSection>
    </div>
  );
}
