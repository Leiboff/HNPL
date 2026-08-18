'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import AccordionSection from '@/components/AccordionSection';

// ─── Account settings — four groups, one interaction pattern ──────────────
//
// Replaces AccountAccordion, which held four sections in one undifferentiated
// stack while the page around it used two other patterns for its remaining
// items (a flat card for Log out, a chevron nav-row for Get help). Every
// settings item a patient can operate is now an AccordionSection in this one
// system, and they sit under four plain-text group headers.
//
// ─── WHY GROUPS AT ALL ────────────────────────────────────────────────
//
// Seven sections in a flat stack read as a pile: nothing tells you where to
// start looking, so you scan all seven. Four headers turn the same seven into
// four short lists, and the headers themselves answer "which of these do I
// want?" before any section is opened. The headers are deliberately NOT
// interactive — a collapsible group containing collapsible sections is two
// disclosure levels for one decision, which is how a settings page starts
// feeling like a filesystem.
//
// ─── WHY THESE FOUR ───────────────────────────────────────────────────
//
//   Your details        who you are, plus the one recurring-money decision
//   How you pay         the cards
//   Sign-in & security  how you get in
//   This device         what is true of THIS browser only
//
// "This device" is the one a generic BNPL account page would not produce, and
// it is the honest header for what it holds. NotificationsToggle reports the
// combined state of this browser's permission AND our stored subscription —
// not an account-wide preference — and signing out ends this session, not
// every session. Grouping them under a device header states something true
// that the old flat list left the patient to infer.
//
// Salary date is its OWN section rather than a field nested inside Personal
// details. It is not an identity detail: it is a decision about when money
// moves, its consequences differ from every other field on the page (it
// applies to FUTURE plans only — existing schedules are snapshotted), and
// burying it is why the confirm screen had to deep-link into another
// section's interior to reach it. As its own section it has its own
// deep-link target.

type SectionKey =
  | 'personal'
  | 'salary'
  | 'pay'
  | 'passkeys'
  | 'password'
  | 'notifications'
  | 'signout';

const SECTION_KEYS: readonly SectionKey[] = [
  'personal', 'salary', 'pay', 'passkeys', 'password', 'notifications', 'signout',
];

// Cards stay visible on arrival — the most-checked thing on the page.
const DEFAULT_OPEN: SectionKey = 'pay';

/**
 * Resolve `?section=` to a section key.
 *
 * `?section=salary` now resolves to the SALARY section. It used to be
 * redirected to `personal`, because salary date was a field nested inside
 * Personal details and there was no salary section to open. Now there is, so
 * the parameter resolves to what it always said — this is the legacy alias
 * retiring because its target exists, not a behaviour change.
 */
export function resolveSection(value: string | null): SectionKey | null {
  return value != null && (SECTION_KEYS as readonly string[]).includes(value)
    ? (value as SectionKey)
    : null;
}

/** A non-interactive group label. Four of these carry the whole hierarchy. */
function GroupHeader({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="px-1 pt-2 text-[11px] font-semibold uppercase"
      style={{ letterSpacing: '.14em', color: 'rgba(19,41,75,.45)' }}
    >
      {children}
    </p>
  );
}

type Props = {
  /** Locked identity fields + the per-field phone editor. */
  personalDetails: React.ReactNode;
  /** SalaryDaySection — its own section now, not nested. */
  salaryDate: React.ReactNode;
  /** PCI copy + PaymentMethods. */
  paymentCards: React.ReactNode;
  /** PasskeysSection. The old inner "Passkeys" sub-heading is gone: this
      section's own header says it, and saying it twice was the only place on
      the page with two levels of heading for one thing. */
  passkeys: React.ReactNode;
  /** Password reset — rarely used, so it lives behind its own disclosure. */
  password: React.ReactNode;
  /** NotificationsToggle. */
  notifications: React.ReactNode;
  /** Sign out. Destructive, so it is behind a disclosure like everything
      else rather than sitting as a permanently-visible red button. */
  signOut: React.ReactNode;
};

export default function AccountSettings({
  personalDetails,
  salaryDate,
  paymentCards,
  passkeys,
  password,
  notifications,
  signOut,
}: Props) {
  const searchParams = useSearchParams();
  const [open, setOpen] = useState<Set<SectionKey>>(() => {
    const initial = new Set<SectionKey>([DEFAULT_OPEN]);
    const deep = resolveSection(searchParams?.get('section') ?? null);
    if (deep) initial.add(deep);
    return initial;
  });

  function toggle(s: SectionKey) {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(s)) next.delete(s);
      else             next.add(s);
      return next;
    });
  }

  /** Every section goes through here, so none can drift to another pattern. */
  const section = (key: SectionKey, title: string, body: React.ReactNode) => (
    <AccordionSection title={title} open={open.has(key)} onToggle={() => toggle(key)}>
      {body}
    </AccordionSection>
  );

  return (
    <div className="flex flex-col gap-[14px]">

      <GroupHeader>Your details</GroupHeader>
      {section('personal', 'Personal details', personalDetails)}
      {section('salary',   'Salary date',      salaryDate)}

      <GroupHeader>How you pay</GroupHeader>
      {section('pay', 'Payment cards', paymentCards)}

      <GroupHeader>Sign-in &amp; security</GroupHeader>
      {section('passkeys', 'Passkeys',            passkeys)}
      {section('password', 'Password & recovery', password)}

      <GroupHeader>This device</GroupHeader>
      {section('notifications', 'Notifications', notifications)}
      {section('signout',       'Sign out',      signOut)}

    </div>
  );
}
