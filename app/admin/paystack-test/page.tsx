import { redirect } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import { paystackRequest } from '@/lib/paystack';

type PaystackListResponse = {
  status: boolean;
  message: string;
  data: unknown;
};

type TestResult =
  | { ok: true;  message: string }
  | { ok: false; message: string };

async function testPaystackConnection(): Promise<TestResult> {
  try {
    const res = await paystackRequest<PaystackListResponse>(
      '/transaction?perPage=1',
    );
    if (res.status === true) {
      return { ok: true, message: res.message };
    }
    return { ok: false, message: res.message ?? 'Paystack returned status: false' };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export default async function PaystackTestPage() {
  const { user, supabase } = await requireConfirmedUser({ next: '/admin/paystack-test' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'admin') redirect('/login');

  const result = await testPaystackConnection();

  return (
    <div className="mx-auto max-w-xl px-6 py-10 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Paystack Connection Test</h1>
        <p className="mt-1 text-sm text-gray-500">
          Read-only probe — lists the most recent transaction (perPage=1). No charges are made.
        </p>
      </div>

      {result.ok ? (
        <div className="rounded-xl bg-green-50 border border-green-200 px-5 py-4">
          <p className="font-semibold text-green-800">&#10003; Connected to Paystack</p>
          <p className="mt-1 text-sm text-green-700">{result.message}</p>
        </div>
      ) : (
        <div className="rounded-xl bg-red-50 border border-red-200 px-5 py-4">
          <p className="font-semibold text-red-800">&#10007; Connection failed</p>
          <p className="mt-1 text-sm text-red-700">{result.message}</p>
        </div>
      )}

      <div className="rounded-xl bg-gray-50 border border-gray-200 px-5 py-4 space-y-1">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Debug info</p>
        <p className="text-sm text-gray-700">
          Endpoint: <code className="font-mono text-xs bg-gray-100 px-1 py-0.5 rounded">GET /transaction?perPage=1</code>
        </p>
        <p className="text-sm text-gray-700">
          Result: <code className="font-mono text-xs bg-gray-100 px-1 py-0.5 rounded">{result.ok ? 'ok' : 'error'}</code>
        </p>
        <p className="text-sm text-gray-700">
          Message: <code className="font-mono text-xs bg-gray-100 px-1 py-0.5 rounded">{result.message}</code>
        </p>
      </div>
    </div>
  );
}
