'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import AccordionSection from '@/components/AccordionSection';

type SectionKey = 'personal' | 'salary' | 'notifications' | 'security';

const SECTION_KEYS: readonly SectionKey[] = ['personal', 'salary', 'notifications', 'security'];

function isSectionKey(value: string | null): value is SectionKey {
  return value != null && (SECTION_KEYS as readonly string[]).includes(value);
}

type Props = {
  /** Personal-details body — includes phone as an inline editable
      field (0065: phone moved out of its standalone accordion). */
  personalDetails: React.ReactNode;
  /** Salary-date section — edit-toggle dropdown. Post-0065 the
      salary_day source of truth is the profile; checkout reads it
      server-side. Changes here affect FUTURE plans only. */
  salaryDay: React.ReactNode;
  /** Client NotificationsToggle (push on/off). */
  notifications: React.ReactNode;
  /** Client PasskeysSection (untouched). */
  passkeys: React.ReactNode;
};

/**
 * Patient profile accordion. Sections start collapsed on a normal page
 * load. The ONE exception is a deep-link: arriving with `?section=<key>`
 * (e.g. the Account "Payday" row → `?section=salary`) opens that section
 * so the patient lands directly on what they tapped. Tapping a heading
 * expands/collapses; sections can be open simultaneously.
 */
export default function ProfileAccordion({
  personalDetails,
  salaryDay,
  notifications,
  passkeys,
}: Props) {
  const searchParams = useSearchParams();
  const [open, setOpen] = useState<Set<SectionKey>>(() => {
    const deepLink = searchParams?.get('section') ?? null;
    return isSectionKey(deepLink) ? new Set<SectionKey>([deepLink]) : new Set<SectionKey>();
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
    <div className="space-y-3">
      <AccordionSection
        title="Personal details"
        open={open.has('personal')}
        onToggle={() => toggle('personal')}
      >
        {personalDetails}
      </AccordionSection>

      <AccordionSection
        title="Salary date"
        open={open.has('salary')}
        onToggle={() => toggle('salary')}
      >
        {salaryDay}
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
          {passkeys}
        </div>
      </AccordionSection>
    </div>
  );
}
