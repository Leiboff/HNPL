import type { Metadata } from 'next';
import ContactPage from './ContactPage';
import { ADDRESS_ONE_LINE, HOURS } from '@/lib/config/contact';

// Built from lib/config/contact so it cannot drift from the page body.
//
// Two deliberate omissions:
//
//   • THE REGISTERED ENTITY, which this description used to interpolate from
//     LEGAL_ENTITY. Metadata is part of this page — it is what a search
//     result and a link preview show — so leaving it here would have kept the
//     registered entity on /contact through the back door, which is exactly
//     what removing the "who we are" card was meant to stop. The registered
//     name and number live in the T&Cs and the Privacy Policy.
//     (The literal is deliberately not quoted here, so a repo-wide search
//     for it does not land on a comment about its own removal.)
//
//   • THE PHONE NUMBER, because it is temporary and metadata is cacheable
//     and crawlable. A number we intend to replace should not be propagated
//     into anything we cannot promptly update.
export const metadata: Metadata = {
  title: 'Contact us — betternow',
  description:
    `Contact betternow: email us, call us, or send a message from our contact page. Our office is at ${ADDRESS_ONE_LINE}, open ${HOURS}.`,
};

export default function Page() {
  return <ContactPage />;
}
