// Bundled by render.ts: the real patient layout around the celebration.
import { renderToStaticMarkup } from 'react-dom/server';
import PatientLayout from '@/app/patient/layout';
import ApprovedCelebration from './ApprovedCelebration';
import { FIXTURE } from './fixtures';

export async function renderMarkup(): Promise<string> {
  const shell = await PatientLayout({
    children: (
      <ApprovedCelebration
        firstName={FIXTURE.profile.first_name}
        allowance={FIXTURE.availableBalance}
      />
    ),
  });
  return renderToStaticMarkup(shell);
}
