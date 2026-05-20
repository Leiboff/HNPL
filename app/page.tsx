import { createClient } from '@/lib/supabase/server';

export default async function Page() {
  const supabase = await createClient();
  const { data, error } = await supabase.from('practices').select('*');

  return (
    <main className="min-h-screen bg-gray-50 p-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">
        HNPL — Connection Test
      </h1>

      {error ? (
        <div className="rounded-md bg-red-50 border border-red-200 p-4 mb-6 text-red-800">
          <span className="font-medium">Error:</span> {error.message}
        </div>
      ) : (
        <div className="rounded-md bg-green-50 border border-green-200 p-4 mb-6 text-green-800">
          ✓ Connected to Supabase
        </div>
      )}

      <pre className="rounded-md bg-gray-900 text-gray-100 p-4 text-sm overflow-auto">
        <code>{JSON.stringify(data, null, 2)}</code>
      </pre>
    </main>
  );
}
