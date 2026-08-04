import type { Metadata } from 'next';
import LegalPrivacyPage from './LegalPrivacyPage';
import { PRIVACY_VERSION, PRIVACY_EFFECTIVE_DATE_LABEL } from '@/lib/legal/privacy';

export const metadata: Metadata = {
  title: 'Privacy Policy — betternow',
  description:
    `The betternow Privacy Policy (version ${PRIVACY_VERSION}, effective ${PRIVACY_EFFECTIVE_DATE_LABEL}) — what Personal Information we collect, how and why we use it, who we share it with, and your rights under POPIA.`,
};

export default function Page() {
  return <LegalPrivacyPage />;
}
