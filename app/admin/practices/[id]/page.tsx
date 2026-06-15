import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { requireConfirmedUser } from '@/lib/auth/requireConfirmedUser';
import { approvePractice, suspendPractice } from '../actions';
import PracticeStatusActions from './PracticeStatusActions';

// ─── Practice detail view ────────────────────────────────────────────────────
//
// Full read-only view of one practice plus the Approve / Suspend /
// Reactivate actions. Server-side admin authorization is asserted FIRST
// — a non-admin who types this URL directly gets bounced to the
// role-appropriate landing page, never sees the data, and never gets
// a chance to fire the actions. The admin layout also runs this check
// (belt-and-braces); both have to pass.
//
// Banking digits are masked to last-4 to keep the operator console safe
// to share-screen. Full unmasked numbers stay only in the database.

type Params = { id: string };

type PracticeFull = {
  id:                            string;
  name:                          string;
  specialty:                     string;
  status:                        string;
  practice_registration_number:  string | null;
  hpcsa_number:                  string | null;
  email:                         string;
  phone:                         string | null;
  address_line1:                 string | null;
  address_line2:                 string | null;
  suburb:                        string | null;
  city:                          string | null;
  practice_province:             string | null;
  postal_code:                   string | null;
  bank_name:                     string | null;
  bank_account_number:           string | null;
  branch_code:                   string | null;
  account_holder:                string | null;
  account_type:                  string | null;
  fee_percent:                   number;
  owner_id:                      string;
  created_at:                    string;
  approved_at:                   string | null;
  approved_by:                   string | null;
};

type MemberFull = {
  id:                       string;
  user_id:                  string;
  role:                     string;
  active:                   boolean;
  can_create_bills:         boolean;
  can_manage_practice:      boolean;
  specialty:                string | null;
  hpcsa_number:             string | null;
  payout_destination:       string | null;
  profile: { first_name: string; last_name: string; email: string } | null;
};

function maskAccount(num: string | null): string {
  if (!num) return '—';
  if (num.length <= 4) return `…${num}`;
  return `…${num.slice(-4)}`;
}

function fullAddress(p: PracticeFull): string {
  const parts = [
    p.address_line1, p.address_line2, p.suburb, p.city,
    p.practice_province, p.postal_code,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : '—';
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending:   'bg-amber-100 text-amber-800 border-amber-200',
    approved:  'bg-green-100 text-green-700 border-green-200',
    suspended: 'bg-red-100  text-red-700   border-red-200',
    inactive:  'bg-gray-100 text-gray-600  border-gray-200',
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${map[status] ?? 'bg-gray-100 text-gray-600 border-gray-200'}`}>
      {status}
    </span>
  );
}

function Field({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs text-gray-400 uppercase tracking-wide">{label}</p>
      <p className={`mt-0.5 text-sm text-gray-800 ${mono ? 'font-mono' : ''}`}>
        {value ?? '—'}
      </p>
    </div>
  );
}

export default async function PracticeDetailPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { id } = await params;
  const { user, supabase } = await requireConfirmedUser({ next: `/admin/practices/${id}` });

  // Server-side admin authorization — non-admin callers bounce to the
  // role-appropriate landing page. This is enforced both here and in
  // the parent layout; either alone would suffice but both is fine.
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profile?.role !== 'admin') {
    if (profile?.role === 'patient')                                              redirect('/patient');
    else if (profile?.role === 'practice_admin' || profile?.role === 'practice_staff') redirect('/practice');
    else if (profile?.role === 'practice_provider')                               redirect('/provider');
    else                                                                          redirect('/login');
  }

  // ── Practice row ────────────────────────────────────────────────────────
  const { data: practiceRaw } = await supabase
    .from('practices')
    .select(`
      id, name, specialty, status,
      practice_registration_number, hpcsa_number,
      email, phone,
      address_line1, address_line2, suburb, city, practice_province, postal_code,
      bank_name, bank_account_number, branch_code, account_holder, account_type,
      fee_percent, owner_id,
      created_at, approved_at, approved_by
    `)
    .eq('id', id)
    .maybeSingle();

  if (!practiceRaw) notFound();
  const practice = practiceRaw as PracticeFull;

  // ── Members + owner profile ─────────────────────────────────────────────
  const { data: membersRaw } = await supabase
    .from('practice_members')
    .select(`
      id, user_id, role, active,
      can_create_bills, can_manage_practice,
      specialty, hpcsa_number, payout_destination,
      profile:profiles!practice_members_user_id_fkey(first_name, last_name, email)
    `)
    .eq('practice_id', id)
    .order('active',  { ascending: false })
    .order('role',    { ascending: true  });

  const members = (membersRaw ?? []).map((m) => ({
    ...m,
    profile: Array.isArray(m.profile) ? m.profile[0] ?? null : m.profile,
  })) as MemberFull[];

  const { data: ownerProfile } = await supabase
    .from('profiles')
    .select('first_name, last_name, email')
    .eq('id', practice.owner_id)
    .maybeSingle();

  const providerCount   = members.filter(m => m.active && m.role === 'provider').length;
  const allHpcsas       = [practice.hpcsa_number, ...members.map(m => m.hpcsa_number)]
    .filter((h): h is string => !!h);
  const bankingComplete = !!(practice.bank_name && practice.bank_account_number);

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-6 sm:py-8 space-y-6">

      {/* Breadcrumb / back link */}
      <div className="text-sm">
        <Link href="/admin/practices?status=pending" className="text-[#15A89E] hover:text-[#13294B]">
          ← Back to practices
        </Link>
      </div>

      {/* Heading + actions */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-xl sm:text-2xl font-semibold text-gray-900 break-words">
              {practice.name}
            </h1>
            <StatusPill status={practice.status} />
          </div>
          <p className="mt-1 text-sm text-gray-500">
            {practice.specialty} · signed up {new Date(practice.created_at).toLocaleDateString()}
          </p>
        </div>
        <PracticeStatusActions
          practiceId={practice.id}
          status={practice.status}
          approvePractice={approvePractice}
          suspendPractice={suspendPractice}
        />
      </div>

      {/* Compliance / completeness chips */}
      <div className="flex flex-wrap gap-2">
        <Chip label={`${providerCount} active provider${providerCount === 1 ? '' : 's'}`} ok={providerCount > 0} />
        <Chip label="Banking" ok={bankingComplete} />
        <Chip label="PR" ok={!!practice.practice_registration_number} />
        <Chip label="HPCSA" ok={allHpcsas.length > 0} />
      </div>

      {/* Identity */}
      <Section title="Identity">
        <Grid>
          <Field label="Practice name"  value={practice.name} />
          <Field label="Specialty"      value={practice.specialty} />
          <Field label="PR (BHF)"       value={practice.practice_registration_number || '—'} mono />
          <Field label="HPCSA (practice)" value={practice.hpcsa_number || '—'} mono />
          <Field label="Fee %"          value={`${practice.fee_percent ?? '—'}%`} />
          <Field label="Status"         value={<StatusPill status={practice.status} />} />
        </Grid>
      </Section>

      {/* Contact + address */}
      <Section title="Contact & address">
        <Grid>
          <Field label="Email" value={practice.email} />
          <Field label="Phone" value={practice.phone || '—'} mono />
          <Field label="Full address" value={fullAddress(practice)} />
        </Grid>
      </Section>

      {/* Owner */}
      <Section title="Practice owner">
        <Grid>
          <Field
            label="Name"
            value={ownerProfile ? `${ownerProfile.first_name} ${ownerProfile.last_name}` : '—'}
          />
          <Field label="Email" value={ownerProfile?.email ?? '—'} />
          <Field label="User ID" value={practice.owner_id} mono />
        </Grid>
      </Section>

      {/* Team */}
      <Section title={`Team (${members.length})`}>
        {members.length === 0 ? (
          <p className="text-sm text-gray-500">No members yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-gray-400 uppercase tracking-wide border-b border-gray-100">
                <tr>
                  <th className="py-2 pr-4">Name</th>
                  <th className="py-2 pr-4">Role</th>
                  <th className="py-2 pr-4">Specialty</th>
                  <th className="py-2 pr-4">HPCSA</th>
                  <th className="py-2 pr-4">Capabilities</th>
                  <th className="py-2 pr-4">Active</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {members.map((m) => (
                  <tr key={m.id}>
                    <td className="py-3 pr-4 text-gray-800 whitespace-nowrap">
                      {m.profile ? (
                        <>
                          <span className="font-medium">{m.profile.first_name} {m.profile.last_name}</span>
                          <br />
                          <span className="text-xs text-gray-500">{m.profile.email}</span>
                        </>
                      ) : '—'}
                    </td>
                    <td className="py-3 pr-4 text-gray-700">{m.role}</td>
                    <td className="py-3 pr-4 text-gray-700">{m.specialty || '—'}</td>
                    <td className="py-3 pr-4 text-gray-700 font-mono text-xs">{m.hpcsa_number || '—'}</td>
                    <td className="py-3 pr-4 text-xs">
                      <CapList
                        bills={m.can_create_bills}
                        manage={m.can_manage_practice}
                      />
                    </td>
                    <td className="py-3 pr-4">
                      {m.active
                        ? <span className="text-green-700 text-xs font-medium">active</span>
                        : <span className="text-gray-400 text-xs">disabled</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* Banking */}
      <Section title="Banking / payout">
        <Grid>
          <Field label="Bank"            value={practice.bank_name || '—'} />
          <Field label="Account holder"  value={practice.account_holder || '—'} />
          <Field label="Account number"  value={maskAccount(practice.bank_account_number)} mono />
          <Field label="Branch code"     value={practice.branch_code || '—'} mono />
          <Field label="Account type"    value={practice.account_type || '—'} />
        </Grid>
        {!bankingComplete && (
          <p className="mt-3 text-xs text-amber-700">
            Banking is incomplete — the practice has not yet been paid out for any plan.
          </p>
        )}
      </Section>

      {/* Audit */}
      <Section title="Approval audit">
        <Grid>
          <Field
            label="Signed up"
            value={new Date(practice.created_at).toLocaleString()}
          />
          <Field
            label="First approved"
            value={practice.approved_at ? new Date(practice.approved_at).toLocaleString() : 'Never'}
          />
          <Field
            label="Approved by"
            value={practice.approved_by ? `${practice.approved_by.slice(0, 8)}…` : '—'}
            mono
          />
        </Grid>
      </Section>

    </div>
  );
}

// ─── Tiny presentational helpers (local to this file) ───────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
      <h2 className="text-sm font-semibold text-gray-900 mb-3">{title}</h2>
      {children}
    </section>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-4">{children}</div>;
}

function Chip({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span
      className={[
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium border',
        ok ? 'bg-green-50 text-green-700 border-green-200'
           : 'bg-amber-50 text-amber-800 border-amber-200',
      ].join(' ')}
    >
      {ok ? '✓' : '○'} {label}
    </span>
  );
}

function CapList({ bills, manage }: { bills: boolean; manage: boolean }) {
  const flags: string[] = [];
  if (bills)  flags.push('bills');
  if (manage) flags.push('manage');
  return <span className="text-gray-600">{flags.length ? flags.join(', ') : '—'}</span>;
}
