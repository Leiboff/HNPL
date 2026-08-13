import type { SetupChecklist, SetupChecklistItem } from '@/lib/practice/setupChecklist';
import { AWAITING_APPROVAL_NOTE, ASK_A_MANAGER_NOTE } from '@/lib/practice/setupChecklist';

// ─── "Finish setting up" — the practice onboarding checklist ───────────────
//
// Replaces a flat pile of sidebar links with something finishable: what is
// done, what is next, and why any of it matters. Every judgement in here is
// the same test — could someone's grandmother, with no training and no
// manual, work out what to do next unaided?
//
// IT DISAPPEARS. That is a feature, not an optimisation.
// ─────────────────────────────────────────────────────
// A checklist that stays put showing four ticks is decoration: it costs the
// most valuable strip of the dashboard forever to tell a practice something
// they already know. `complete` returns null — no collapsed stub, no "setup
// complete" badge, no empty shell. The dashboard goes back to being about
// money the moment it can be.
//
// ONE emphasised action, always.
// ──────────────────────────────
// Only the FIRST outstanding item gets the filled button; later ones get a
// quiet link. Four equally-loud buttons is the flat pile of sidebar links
// again, just in a nicer box — the whole point is that there is exactly one
// obvious next thing.
//
// The order is FIXED (see buildSetupChecklist) and never re-sorts as items
// are completed. A list that rearranges itself under someone who is working
// down it is disorienting in a way that a stable list with ticks is not.
//
// No state, no effects, no interactivity — it renders on the server as part
// of the dashboard, which is why every item's state is as fresh as the page.

const NAVY = '#13294B';

export type PracticeSetupChecklistProps = {
  checklist:  SetupChecklist;
  /** Appended to every action link so the target screen scopes correctly. */
  practiceId: string;
};

export default function PracticeSetupChecklist({
  checklist,
  practiceId,
}: PracticeSetupChecklistProps) {
  // The disappearing act. Deliberately the first thing in the component: it
  // must be impossible to render a completed checklist by mistake.
  if (checklist.complete) return null;

  const { items, doneCount, total, awaitingApproval } = checklist;
  const firstTodoKey = items.find((i) => !i.done)?.key ?? null;
  const pct = Math.round((doneCount / total) * 100);

  return (
    <section
      data-testid="practice-setup-checklist"
      // Same card shell as NextPayoutHero — this belongs to the page rather
      // than sitting on top of it.
      className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden"
      aria-labelledby="setup-checklist-heading"
    >
      <div className="p-5 sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2
            id="setup-checklist-heading"
            className="text-base sm:text-lg font-semibold"
            style={{ color: NAVY }}
          >
            Finish setting up your practice
          </h2>
          <p
            data-testid="setup-progress"
            className="text-sm font-semibold text-gray-500 tabular-nums"
          >
            {doneCount} of {total} done
          </p>
        </div>

        {/* Progress is stated in words above; the bar is the at-a-glance
            version of the same fact, so it is aria-hidden rather than
            announced twice. */}
        <div
          aria-hidden="true"
          className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-gray-100"
        >
          <div
            data-testid="setup-progress-bar"
            className="h-full rounded-full transition-[width]"
            style={{
              width: `${pct}%`,
              background: 'linear-gradient(90deg, #13294B 0%, #15A89E 145%)',
            }}
          />
        </div>

        {awaitingApproval && (
          <p
            data-testid="setup-awaiting-approval"
            className="mt-4 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900"
          >
            {AWAITING_APPROVAL_NOTE}
          </p>
        )}

        <ul className="mt-4 divide-y divide-gray-100">
          {items.map((item) => (
            <Row
              key={item.key}
              item={item}
              practiceId={practiceId}
              emphasised={item.key === firstTodoKey}
            />
          ))}
        </ul>
      </div>
    </section>
  );
}

function Row({
  item,
  practiceId,
  emphasised,
}: {
  item:       SetupChecklistItem;
  practiceId: string;
  emphasised: boolean;
}) {
  // Every target screen scopes by ?practiceId= — a brand owner is a member of
  // several practices, so a bare link would land them on whichever one the
  // fallback picks rather than the one they are looking at.
  const href = item.href
    ? item.href.includes('#')
      ? `${item.href.split('#')[0]}?practiceId=${practiceId}#${item.href.split('#')[1]}`
      : `${item.href}?practiceId=${practiceId}`
    : null;

  return (
    <li
      data-testid={`setup-item:${item.key}`}
      data-state={item.done ? 'done' : 'todo'}
      className="flex items-start gap-3 py-3"
    >
      <StateMark done={item.done} itemKey={item.key} />

      <div className="min-w-0 flex-1">
        <p
          className={`text-sm font-semibold ${item.done ? 'text-gray-400' : ''}`}
          style={item.done ? undefined : { color: NAVY }}
        >
          {item.title}
        </p>

        {/* The reason is only useful while the thing is undone. Once it is
            ticked, restating why it mattered is noise. */}
        {!item.done && (
          <>
            <p data-testid={`setup-item-why:${item.key}`} className="mt-0.5 text-sm text-gray-600">
              {item.why}
            </p>
            {item.hint && (
              <p
                data-testid={`setup-item-hint:${item.key}`}
                className="mt-1 text-sm text-gray-500"
              >
                {item.hint}
              </p>
            )}
          </>
        )}
      </div>

      {!item.done && (
        <div className="shrink-0 pt-0.5">
          {href ? (
            <a
              href={href}
              data-testid={`setup-item-action:${item.key}`}
              className={
                emphasised
                  ? 'inline-block rounded-lg px-3.5 py-2 text-xs font-semibold text-white transition-all hover:shadow-lg'
                  : 'inline-block text-xs font-semibold underline underline-offset-2'
              }
              style={
                emphasised
                  ? { background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }
                  : { color: NAVY }
              }
            >
              {item.actionLabel}
            </a>
          ) : (
            // No authority for the screen that completes this item, so there
            // is no link to give: /practice/details answers a non-brand-admin
            // with notFound(), and the add-practitioner control is
            // manager-only. Naming who CAN do it beats a button that fails.
            <span
              data-testid={`setup-item-ask-manager:${item.key}`}
              className="inline-block max-w-[10rem] text-xs text-gray-500"
            >
              {ASK_A_MANAGER_NOTE}
            </span>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Tick or empty circle. The done state carries a shape as well as a colour —
 * a green-vs-grey-only distinction disappears entirely for the most common
 * form of colour blindness, and "which of these is finished" is the one thing
 * this card has to communicate.
 */
function StateMark({ done, itemKey }: { done: boolean; itemKey: string }) {
  if (done) {
    return (
      <span
        data-testid={`setup-item-mark-done:${itemKey}`}
        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-100"
      >
        <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
          <path
            d="M4.5 10.5l3.5 3.5 7.5-8"
            stroke="#047857"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="sr-only">Done</span>
      </span>
    );
  }
  return (
    <span
      data-testid={`setup-item-mark-todo:${itemKey}`}
      className="mt-0.5 h-5 w-5 shrink-0 rounded-full border-2 border-gray-300"
    >
      <span className="sr-only">Still to do</span>
    </span>
  );
}
