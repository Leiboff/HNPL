import type { Metadata } from 'next';
import ContactPage from './ContactPage';
import { ADDRESS_ONE_LINE, HOURS, LEGAL_ENTITY } from '@/lib/config/contact';

// The description carries the entity + address + hours because this page's
// audience includes an acquirer's onboarding reviewer, who may well be
// reading a search result or a link preview before opening the page. It is
// built from lib/config/contact so it cannot drift from the page body — and
// deliberately does NOT include the phone number, which is temporary and
// should not be propagated into anything cacheable or crawlable.
export const metadata: Metadata = {
  title: 'Contact us — betternow',
  description:
    `How to contact ${LEGAL_ENTITY} (trading as betternow): email, phone and our registered address at ${ADDRESS_ONE_LINE}. Open ${HOURS}.`,
};

export default function Page() {
  return <ContactPage />;
}
