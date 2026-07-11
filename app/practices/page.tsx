import type { Metadata } from 'next';
import PracticesPage from './PracticesPage';

export const metadata: Metadata = {
  title: 'betternow for practices — paid upfront, we handle collection',
  description:
    'Turn patient shortfalls into treatments that go ahead. Get paid within days, add zero admin, and let patients split their bill into interest-free instalments timed to their salary dates.',
};

export default function Page() {
  return <PracticesPage />;
}
