'use client';

import Link from 'next/link';

export default function BranchCreateLink({ groupId }: { groupId: string }) {
  return (
    <Link
      href={`/brand/${groupId}/new-branch`}
      className="inline-flex items-center justify-center rounded-lg px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:shadow-md"
      style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
    >
      + Add branch
    </Link>
  );
}
