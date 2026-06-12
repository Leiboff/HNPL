'use client';

import { useState } from 'react';
import AccordionSection from '@/components/AccordionSection';
import { usePasskeys } from '@/lib/hooks/usePasskeys';

type SectionKey = 'personal' | 'address' | 'security';

type Props = {
  /** Which section starts expanded — null = all collapsed. */
  initialOpen: SectionKey | null;
  /** Collapsed-state summary for the personal-details header. */
  personalSummary: string;
  /** Collapsed-state summary for the address header. */
  addressSummary: string;
  /** Server-rendered Personal-details body (read-only fields + footnote). */
  personalDetails: React.ReactNode;
  /** Client AddressForm with its own Save button. */
  contactAddress: React.ReactNode;
  /** Client PasskeysSection (untouched). */
  passkeys: React.ReactNode;
};

/**
 * Patient profile accordion. Each section toggles independently; default
 * state has all sections collapsed except whichever the server marked as
 * the first incomplete one (currently address, if no address line is
 * stored).
 *
 * `usePasskeys` runs here for the security-section summary count. The same
 * hook also runs inside the existing PasskeysSection — two calls per page
 * load, but that keeps PasskeysSection unmodified (per the task's "don't
 * touch passkey logic" constraint).
 */
export default function ProfileAccordion({
  initialOpen,
  personalSummary,
  addressSummary,
  personalDetails,
  contactAddress,
  passkeys,
}: Props) {
  const [open, setOpen] = useState<Set<SectionKey>>(() =>
    initialOpen ? new Set([initialOpen]) : new Set(),
  );

  function toggle(s: SectionKey) {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(s)) next.delete(s);
      else            next.add(s);
      return next;
    });
  }

  // Live count for the Security & sign-in collapsed summary.
  const { passkeys: passkeysList, loading: passkeysLoading, supported: passkeysSupported } = usePasskeys();
  const securitySummary: string = !passkeysSupported
    ? 'Unavailable in this browser'
    : passkeysLoading
      ? '…'
      : passkeysList.length === 0
        ? 'No passkeys yet'
        : `${passkeysList.length} passkey${passkeysList.length === 1 ? '' : 's'}`;

  return (
    <div className="space-y-3">
      <AccordionSection
        title="Personal details"
        summary={personalSummary}
        open={open.has('personal')}
        onToggle={() => toggle('personal')}
      >
        {personalDetails}
      </AccordionSection>

      <AccordionSection
        title="Contact & billing address"
        summary={addressSummary}
        open={open.has('address')}
        onToggle={() => toggle('address')}
      >
        {contactAddress}
      </AccordionSection>

      <AccordionSection
        title="Security & sign-in"
        summary={securitySummary}
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
