import { redirect } from 'next/navigation';
import PatientScreen from '@/app/patient/PatientScreen';
import SubScreenHeader from '@/app/patient/account/SubScreenHeader';
import { createClient } from '@/lib/supabase/server';
import { getRequestUser } from '@/lib/auth/requestUser';
import { ensureMyReferralCode } from './actions';
import ReferTabs from './ReferTabs';
import ReferralList, { type ReferralRow } from './ReferralList';

// ─── Refer — the patient's own referral screen ───────────────────────────
//
// One choice and three objects: what am I referring, the affordances for it,
// and the record of what I have referred already.
//
// The two sides of that choice are not symmetrical, and the screen does not
// pretend they are. Referring a FRIEND is a share — a code, a link, the
// system share sheet, WhatsApp, email — with the email-invitation form as one
// channel among them. Referring a PRACTICE is a lead form and nothing else,
// because a practice cannot sign itself up: what that produces is a
// crm_leads row with source='referral' for a rep to work. ReferTabs owns that
// asymmetry; this page just supplies the code.
//
// ─── THE CODE IS MINTED ON RENDER ────────────────────────────────────────
//
// ensureMyReferralCode() is called here rather than behind a button. The
// button's only possible answer is yes — nobody opens a referral screen to
// decline a code — so it would be a step rather than a choice, and it would
// leave the first visit showing an empty card.
//
// It is a WRITE from a server component, which is unusual in this repo and
// deliberate here: it is idempotent (one live code per owner, enforced by a
// unique index), it takes no input, and it cannot be triggered by anyone but
// the account it writes for. Nothing else on this page writes anything.
//
// ─── READS ARE THE PATIENT'S OWN, TWICE OVER ─────────────────────────────
//
// The referral list is read on the SESSION client, not the service-role one,
// so 0145's referrals_referrer_select scopes it at the database. The action
// layer uses service-role because it has to write; a read that RLS can do
// should be done by RLS, so a mistake in this file returns nothing rather
// than somebody else's referrals.
//
// The `.eq('referrer_id', …)` on top of that is not redundant belt to those
// braces — it is the same defence-in-depth posture the rest of this surface
// takes (app/patient/account/page.tsx filters its own payments read the same
// way under the same policies). Either layer alone is correct; both together
// mean a policy edited by hand cannot quietly widen this screen.

export default async function ReferPage() {
  const user = await getRequestUser();
  if (!user) redirect('/login');

  const supabase = await createClient();

  // Sequential rather than parallel: the read should see a code that this
  // request may have just minted. The alternative — Promise.all — would race
  // a write against a read of the same account for no measurable gain.
  const codeResult = await ensureMyReferralCode();

  const { data } = await supabase
    .from('referrals')
    .select('id, kind, status, invitee_name, invitee_email, practice_name, expires_at, created_at')
    .eq('referrer_id', user.id)
    .order('created_at', { ascending: false })
    .limit(50);

  const rows = (data ?? []) as ReferralRow[];

  return (
    <PatientScreen header={<SubScreenHeader title="Refer someone" />} sheetClassName="px-[18px] pt-5 pb-6">
      <div className="flex flex-col gap-[14px]">
        <p className="text-[13px] leading-[1.55]" style={{ color: 'var(--portal-muted)' }}>
          Know someone who could use betternow, or a practice that should offer it?
          Send them your link, or tell us about them and we&rsquo;ll take it from there.
        </p>

        {'error' in codeResult && (
          // The code could not be minted. Saying so plainly beats a card that
          // is silently missing: the forms still work, because they mint the
          // code themselves when they need one.
          <section
            className="rounded-card bg-white p-[18px]"
            style={{ border: '1px solid rgba(19,41,75,.06)', boxShadow: '0 2px 6px -2px rgba(15,31,58,.07)' }}
            data-testid="referral-code-unavailable"
          >
            <p className="text-[14px] font-semibold" style={{ color: 'var(--portal-ink)' }}>
              Your referral link isn&rsquo;t ready
            </p>
            <p className="mt-1.5 text-[13px] leading-[1.55]" style={{ color: 'var(--portal-muted)' }}>
              {codeResult.error} You can still invite someone using the form below.
            </p>
          </section>
        )}

        {/* The share card lives inside the tabs, not here: it belongs to the
            friend side only. A practice is not referred by a link — see
            ReferTabs, and the referrals_link_is_patient_only constraint in
            migration 0145 that says the same thing in the database. */}
        <ReferTabs code={'code' in codeResult ? codeResult.code : null} />

        <ReferralList rows={rows} />
      </div>
    </PatientScreen>
  );
}
