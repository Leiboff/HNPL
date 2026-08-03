import type { Metadata } from 'next';
import LegalTermsPage from './LegalTermsPage';
import { TERMS_VERSION, TERMS_EFFECTIVE_DATE_LABEL } from '@/lib/legal/terms';

export const metadata: Metadata = {
  title: 'Customer Terms & Conditions — betternow',
  description:
    `The betternow customer terms and conditions (version ${TERMS_VERSION}, effective ${TERMS_EFFECTIVE_DATE_LABEL}) — how our interest-free Pay-in-2 and Pay-in-3 payment plans work, fees, and your rights.`,
};

export default function Page() {
  return <LegalTermsPage />;
}
