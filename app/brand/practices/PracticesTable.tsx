import Link from 'next/link';
import type { BrandPracticeSetup } from '@/lib/brand/brandPracticeSetup';

// ─── Practices — setup state for the whole group, at a glance ────────────────
//
// THE ONE JOB
// ───────────
// A brand admin should be able to see that a branch has no banking WITHOUT
// visiting it. Everything else about this screen follows from that: it is a
// scanning surface, not a working one. It states what is missing and points at
// the practice; the fixing happens one level down.
//
// WHICH DESTINATION, AND WHY
// ──────────────────────────
// Every row links to the practice's own DASHBOARD, via the existing
// /brand/branch/[practiceId] pivot — not to a deep link into the settings
// section that would fix the missing thing. Deliberate:
//
//   • The practice dashboard already renders the setup checklist card, and that
//     card computes each item's fix-it href from the REAL viewer's authority,
//     handing a non-manager "ask whoever manages your practice" instead of a
//     link that 404s. Deep-linking from here would be a second set of fix-it
//     URLs, derived from a brand-admin authority constant, that could drift from
//     the card's — and lib/brand/brandPracticeSetup exists precisely so this
//     table has no opinions of its own about setup.
//   • A row usually has more than one thing outstanding. There is no single
//     "relevant settings section" to send them to, and picking the first would
//     hide the rest.
//   • The pivot is the brand surface's one documented doorway (see
//     /brand/branch/[practiceId]) and it sets ?practiceId= itself, so scope is
//     preserved without this file constructing a /practice URL.
//
// The ONE exception is the till column, which links straight to
// /practice/pos/devices?practiceId=… . That link is not new — it lived on the
// old brand dashboard's practice strip and moved here with the column, because
// the till is the one piece of setup with its own screen rather than a section
// of Settings, and it is the one item the checklist treats as optional so the
// dashboard card may not even mention it.
//
// INCOMPLETE MUST BE OBVIOUS, AND NOT ONLY BY COLOUR
// ─────────────────────────────────────────────────
// A row needing attention gets an amber left border, an "Action needed" chip,
// and a sentence naming what is outstanding in the checklist's own words. Three
// independent signals, for the same reason the payout chips carry a WORD as well
// as a colour: a reader who cannot separate amber from grey still gets the text.
//
// NO DATES AND NO MONEY on this screen at all, so there is nothing here to
// format — asserted in the tests rather than left as an accident.

const NAVY = '#13294B';

/** Approval chip. Relocated verbatim from the old practice strip's chip, which
 *  is being retired with it — same wording, same colours, one home. */
function statusClass(status: string): string {
  if (status === 'approved')  return 'bg-green-100 text-green-700';
  if (status === 'pending')   return 'bg-amber-100 text-amber-700';
  if (status === 'suspended') return 'bg-red-100 text-red-700';
  return 'bg-gray-100 text-gray-500';
}

/** A yes/no cell. The word carries it; the mark is decoration. */
function Yes({ children }: { children: React.ReactNode }) {
  return <span className="text-gray-900">{children}</span>;
}
function No({ children }: { children: React.ReactNode }) {
  return <span className="font-semibold text-amber-800">{children}</span>;
}

/**
 * The till, stated as the two facts it actually is.
 *
 * Not a tick: the checklist deliberately treats the till as optional, so
 * printing a red cross would tell a practice that bills from one laptop it has
 * done something wrong. Naming which half is missing is also simply more useful
 * to whoever has to finish it — see lib/practice/setupChecklist's tillHint,
 * which says the same thing to the practice itself.
 */
function tillLabel(hasDevice: boolean, hasPin: boolean): { text: string; ok: boolean } {
  if (hasDevice && hasPin)  return { text: 'Registered · PIN set',   ok: true  };
  if (hasDevice && !hasPin) return { text: 'Registered · no PIN',    ok: false };
  if (!hasDevice && hasPin) return { text: 'PIN set · no till',      ok: false };
  return { text: 'Not set up', ok: true };   // optional, so "absent" is not a fault
}

export default function PracticesTable({ practices }: { practices: BrandPracticeSetup[] }) {
  const needing = practices.filter((p) => p.needsAttention).length;

  return (
    <section aria-labelledby="brand-practices-heading" className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="brand-practices-heading" className="text-sm font-semibold" style={{ color: NAVY }}>
          Setup &amp; approval
        </h2>
        <p className="text-xs text-gray-500" data-testid="brand-practices-summary">
          {needing === 0
            ? `All ${practices.length} practices are set up and approved`
            : `${needing} of ${practices.length} need attention`}
        </p>
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-left text-gray-500">
              <th className="px-4 py-2.5 font-medium">Practice</th>
              <th className="px-4 py-2.5 font-medium">Approval</th>
              <th className="px-4 py-2.5 font-medium">Bank account</th>
              <th className="px-4 py-2.5 font-medium">Practitioners</th>
              <th className="px-4 py-2.5 font-medium">Front desk till</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {practices.map((p) => {
              const till = tillLabel(p.hasTillDevice, p.hasTillPin);
              // The checklist's own words for whatever is outstanding. Not
              // paraphrased here: the practice reads these exact titles on its
              // own dashboard card, and two vocabularies for one missing thing
              // is how a brand admin and a practice manager end up describing
              // different problems to each other.
              const missing = p.items.filter((i) => !i.done).map((i) => i.title);

              return (
                <tr
                  key={p.practiceId}
                  data-testid={`brand-practice-setup-${p.practiceId}`}
                  data-needs-attention={p.needsAttention ? 'true' : 'false'}
                  className={p.needsAttention ? 'bg-amber-50/40' : undefined}
                >
                  <td className="px-4 py-3 align-top">
                    <div
                      className={p.needsAttention ? 'border-l-2 border-amber-500 pl-2 -ml-2' : undefined}
                    >
                      <Link
                        href={`/brand/branch/${p.practiceId}`}
                        data-testid={`brand-practice-setup-link-${p.practiceId}`}
                        className="font-semibold underline underline-offset-2 hover:opacity-70 transition-opacity"
                        style={{ color: NAVY }}
                      >
                        {p.practiceName}
                      </Link>
                      <p className="text-[11px] text-gray-500 mt-0.5">
                        {[p.suburb, p.city].filter(Boolean).join(', ') || '—'}
                      </p>

                      {p.needsAttention && (
                        <span
                          data-testid={`brand-practice-attention-${p.practiceId}`}
                          className="inline-block mt-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800"
                        >
                          Action needed
                        </span>
                      )}

                      {missing.length > 0 && (
                        <p
                          className="text-[11px] text-amber-800 mt-1"
                          data-testid={`brand-practice-missing-${p.practiceId}`}
                        >
                          Still needed: {missing.join(', ')}
                        </p>
                      )}
                    </div>
                  </td>

                  <td className="px-4 py-3 align-top">
                    <span
                      data-testid={`brand-practice-status-${p.practiceId}`}
                      className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${statusClass(p.status)}`}
                    >
                      {p.status}
                    </span>
                  </td>

                  <td className="px-4 py-3 align-top text-xs" data-testid={`brand-practice-banking-${p.practiceId}`}>
                    {p.done.banking ? <Yes>Set</Yes> : <No>Not set</No>}
                  </td>

                  <td className="px-4 py-3 align-top text-xs" data-testid={`brand-practice-providers-${p.practiceId}`}>
                    {/* "On roster", not "N on roster". The underlying read is
                        .limit(1)-ed, so a number here could only ever be 1 —
                        and "1 on roster" for a practice with nine is a specific
                        claim that is wrong. See lib/brand/brandPracticeSetup. */}
                    {p.done.provider
                      ? <Yes>On roster</Yes>
                      : <No>None on roster</No>}
                  </td>

                  <td className="px-4 py-3 align-top text-xs">
                    <span data-testid={`brand-practice-till-${p.practiceId}`}>
                      {till.ok ? <Yes>{till.text}</Yes> : <No>{till.text}</No>}
                    </span>
                    <Link
                      href={`/practice/pos/devices?practiceId=${p.practiceId}`}
                      data-testid={`brand-practice-till-link-${p.practiceId}`}
                      className="block mt-0.5 text-[11px] font-semibold underline underline-offset-2"
                      style={{ color: NAVY }}
                    >
                      Manage →
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Why a fully-ticked practice can still be waiting. Said once, here,
          rather than per row: the practice's own dashboard already explains the
          wait to them via the trading-gate panel, and this is the brand-side
          reader's version of the same fact. */}
      <p className="text-[11px] text-gray-500" data-testid="brand-practices-approval-note">
        A practice can be fully set up and still show <span className="font-medium">pending</span> —
        approval is ours to complete, not yours. Billing unlocks once it&apos;s approved.
      </p>
    </section>
  );
}
