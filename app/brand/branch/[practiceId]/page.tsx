import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import {
  updateBranchDetails,
  updateBranchBanking,
} from '@/app/brand/actions';
import BranchDetailsForm from './BranchDetailsForm';
import BranchBankingForm from './BranchBankingForm';

// ─── Brand-admin: edit a branch in their group ─────────────────────────
//
// Two edit-mode forms on one page:
//   1. Descriptive details (name, phone, address+coords via Places).
//   2. Banking (separate so it's discrete + audit-traceable).
//
// LOCKED columns are never exposed by either form:
//   status, approved_at, approved_by, fee_percent, owner_id,
//   group_id, created_at, email.
// The brand-admin sees `status` and `fee_percent` as READ-ONLY for
// awareness (you'd want to know your branch is still pending or what
// your commission is) but they cannot be edited from here. The
// platform-admin actions remain the only writers.

export const dynamic = 'force-dynamic';

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

export default async function BrandBranchEditPage({
  params,
}: {
  params: Promise<{ practiceId: string }>;
}) {
  const { practiceId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Resolve the practice's group via service-role (not RLS-coupled
  // to the caller) so we can authoritatively check brand-admin
  // membership without conflating "wrong group" with "no such
  // practice".
  const { data: practice } = await svc()
    .from('practices')
    .select(`
      id, name, status, group_id,
      phone, fee_percent,
      address_line1, address_line2, suburb, city, practice_province, postal_code,
      latitude, longitude,
      bank_name, bank_account_number, branch_code, account_holder, account_type
    `)
    .eq('id', practiceId)
    .maybeSingle();

  if (!practice) notFound();

  const { data: membership } = await supabase
    .from('practice_group_members')
    .select('user_id')
    .eq('group_id', practice.group_id as string)
    .eq('user_id', user.id)
    .eq('active', true)
    .maybeSingle();
  if (!membership) notFound();  // 404 rather than 403 — same shape as a stranger asking

  return (
    <div className="mx-auto max-w-xl px-4 sm:px-6 py-6 sm:py-10 space-y-6">
      <header>
        <Link href="/brand" className="text-xs text-gray-500 hover:underline">← Back to my practices</Link>
        <h1 className="text-2xl font-semibold mt-1" style={{ color: '#13294B' }}>{practice.name as string}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className={`px-2 py-0.5 rounded-full font-medium ${
            practice.status === 'approved'  ? 'bg-green-100 text-green-700' :
            practice.status === 'pending'   ? 'bg-amber-100 text-amber-700' :
            practice.status === 'suspended' ? 'bg-red-100 text-red-700' :
                                              'bg-gray-100 text-gray-500'
          }`}>
            {practice.status as string}
          </span>
          <span className="text-gray-500">Commission: {Number(practice.fee_percent ?? 0)}%</span>
        </div>
        <p className="text-xs text-gray-400 mt-1">
          Status and commission are set by BetterNow — contact support to change them.
        </p>
      </header>

      <BranchDetailsForm
        practiceId={practiceId}
        initial={{
          name:          (practice.name           as string)        ?? '',
          phone:         (practice.phone          as string | null) ?? null,
          addressLine1:  (practice.address_line1  as string | null) ?? '',
          addressLine2:  (practice.address_line2  as string | null) ?? null,
          suburb:        (practice.suburb         as string | null) ?? null,
          city:          (practice.city           as string | null) ?? null,
          province:      (practice.practice_province as string | null) ?? null,
          postalCode:    (practice.postal_code    as string | null) ?? null,
          latitude:      practice.latitude  != null ? Number(practice.latitude)  : null,
          longitude:     practice.longitude != null ? Number(practice.longitude) : null,
        }}
        saveAction={updateBranchDetails}
      />

      <BranchBankingForm
        practiceId={practiceId}
        initial={{
          bankName:          (practice.bank_name           as string | null) ?? null,
          bankAccountNumber: (practice.bank_account_number as string | null) ?? null,
          branchCode:        (practice.branch_code         as string | null) ?? null,
          accountHolder:     (practice.account_holder      as string | null) ?? null,
          accountType:       (practice.account_type        as 'current' | 'savings' | null) ?? null,
        }}
        saveAction={updateBranchBanking}
      />
    </div>
  );
}
