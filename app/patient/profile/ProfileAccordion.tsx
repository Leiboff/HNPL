'use client';

import { useState } from 'react';
import AccordionSection from '@/components/AccordionSection';

type SectionKey = 'personal' | 'phone' | 'notifications' | 'security';

type Props = {
  /** Server-rendered Personal-details body (read-only fields + footnote). */
  personalDetails: React.ReactNode;
  /** Client PhoneForm — phone-only after migration 0059 dropped the
      physical-address columns from profiles (POPIA minimisation). */
  phone: React.ReactNode;
  /** Client NotificationsToggle (push on/off). */
  notifications: React.ReactNode;
  /** Client PasskeysSection (untouched). */
  passkeys: React.ReactNode;
};

/**
 * Patient profile accordion. All sections start collapsed on page load —
 * no auto-expand of any kind. Tapping a heading expands that section;
 * tapping again collapses it. Sections can be open simultaneously.
 */
export default function ProfileAccordion({
  personalDetails,
  phone,
  notifications,
  passkeys,
}: Props) {
  const [open, setOpen] = useState<Set<SectionKey>>(() => new Set());

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
        title="Phone number"
        open={open.has('phone')}
        onToggle={() => toggle('phone')}
      >
        {phone}
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
