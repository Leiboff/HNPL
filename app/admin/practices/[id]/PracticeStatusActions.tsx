'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// Status-driven Approve / Suspend / Reactivate buttons for the practice
// detail header. The server actions enforce admin authorization; this
// component is presentational.

type Props = {
  practiceId:       string;
  status:           string;
  approvePractice:  (id: string) => Promise<{ error: string | null }>;
  suspendPractice:  (id: string) => Promise<{ error: string | null }>;
};

export default function PracticeStatusActions({
  practiceId,
  status,
  approvePractice,
  suspendPractice,
}: Props) {
  const router = useRouter();
  const [busy,  setBusy]  = useState<'approve' | 'suspend' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(kind: 'approve' | 'suspend') {
    setBusy(kind); setError(null);
    const fn = kind === 'approve' ? approvePractice : suspendPractice;
    const result = await fn(practiceId);
    setBusy(null);
    if (result.error) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col items-stretch sm:items-end gap-2 shrink-0">
      <div className="flex flex-wrap gap-2">
        {status === 'pending' && (
          <button
            type="button"
            onClick={() => run('approve')}
            disabled={busy !== null}
            data-testid={`detail-approve-${practiceId}`}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-white transition-all hover:shadow-lg disabled:opacity-60 disabled:cursor-not-allowed"
            style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
          >
            {busy === 'approve' ? 'Approving…' : 'Approve'}
          </button>
        )}
        {status === 'approved' && (
          <button
            type="button"
            onClick={() => run('suspend')}
            disabled={busy !== null}
            data-testid={`detail-suspend-${practiceId}`}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-red-700 bg-white border border-red-200 hover:bg-red-50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {busy === 'suspend' ? 'Suspending…' : 'Suspend'}
          </button>
        )}
        {status === 'suspended' && (
          <button
            type="button"
            onClick={() => run('approve')}
            disabled={busy !== null}
            data-testid={`detail-reapprove-${practiceId}`}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-white transition-all hover:shadow-lg disabled:opacity-60 disabled:cursor-not-allowed"
            style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
          >
            {busy === 'approve' ? 'Reactivating…' : 'Reactivate'}
          </button>
        )}
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
    </div>
  );
}
