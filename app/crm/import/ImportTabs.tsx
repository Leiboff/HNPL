'use client';

import { useState } from 'react';
import ImportClient from './ImportClient';
import QuickImportClient from './QuickImportClient';

export default function ImportTabs() {
  const [tab, setTab] = useState<'full' | 'quick'>('full');

  return (
    <div className="space-y-4">
      <div className="flex gap-2 border-b border-gray-200" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'full'}
          onClick={() => setTab('full')}
          className={tabClass(tab === 'full')}
        >
          Full detail (CSV)
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'quick'}
          onClick={() => setTab('quick')}
          className={tabClass(tab === 'quick')}
        >
          Quick import (name + specialty + neighbourhood)
        </button>
      </div>
      {tab === 'full' ? <ImportClient /> : <QuickImportClient />}
    </div>
  );
}

function tabClass(active: boolean): string {
  return 'px-3 py-2 text-sm font-medium border-b-2 -mb-px ' +
    (active ? 'border-[#13294B] text-[#13294B]' : 'border-transparent text-gray-500 hover:text-gray-700');
}
