'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import AccordionSection from '@/components/AccordionSection';

// ─── Account settings accordion ──────────────────────────────────────────
//
// The single settings pattern for the consolidated Account page. Three
// disclosure sections — Personal details, Notifications, Security & sign-in
// — with the "How you pay" (cards) block rendered inline between the first
// section and the rest, matching the page's section order. Salary date is
// NOT its own section: it lives nested inside Personal details.
//
// Sections start collapsed. Arriving with `?section=<key>` opens that one
// (so a deep-link lands on what was tapped). Legacy `?section=salary` links
// — from before salary folded into Personal details — resolve to `personal`.

type SectionKey = 'personal' | 'notifications' | 'security';

const SECTION_KEYS: readonly SectionKey[] = ['personal', 'notifications', 'security'];

function resolveSection(value: string | null): SectionKey | null {
  if (value === 'salary') return 'personal'; // salary now lives inside Personal details
  return value != null && (SECTION_KEYS as readonly string[]).includes(value)
    ? (value as SectionKey)
    : null;
}

type Props = {
  /** Locked identity fields + phone + nested Salary date. */
  personalDetails: React.ReactNode;
  /** Cards surface (heading + PCI copy + PaymentMethods) — inline, not an
      accordion; rendered between Personal details and Notifications. */
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
    const deep = resolveSection(searchParams?.get('section') ?? null);
    return deep ? new Set<SectionKey>([deep]) : new Set<SectionKey>();
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

      {howYouPay}

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
