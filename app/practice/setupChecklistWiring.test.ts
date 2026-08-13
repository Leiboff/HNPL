import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Setup checklist — wiring pins ────────────────────────────────────────
//
// Behaviour is covered by the derivation tests (lib/practice/
// setupChecklist.test.ts + .pglite.test.ts) and the card tests
// (./PracticeSetupChecklist.test.tsx). What is pinned HERE is the set of
// properties that no rendering test can see:
//
//   1. NO STORED STATE. The whole feature rests on being derived, so the
//      derivation module must never write, and no migration may add a
//      completion column for someone to "optimise" into later.
//   2. SHARED SOURCES with the trading gate — same banking resolver, same
//      provider predicate. A checklist that disagrees with the gate tells a
//      practice they are ready when billing will still refuse them.
//   3. checkTradingGate is consumed READ-ONLY, and its own logic is untouched.
//   4. PLACEMENT, and that nothing else on the dashboard was displaced.
//   5. ONE INSTRUCTION PER TASK. The gate panel and this card both had things
//      to say about missing providers and missing banking. The de-duplication
//      is a source-level property of the dashboard — which branch renders
//      when — so it is pinned here rather than in a render test.
//
// Every absence assertion runs against comment-STRIPPED source: these files
// discuss the exact columns, flags and predicates they must not use, and a
// naive substring check would match the prose explaining why.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const codeOf = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '')
     .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

const DASH_SRC  = read('app/practice/page.tsx');
const DASH      = codeOf(DASH_SRC);
const LIB_SRC   = read('lib/practice/setupChecklist.ts');
const LIB       = codeOf(LIB_SRC);
const CARD      = codeOf(read('app/practice/PracticeSetupChecklist.tsx'));
const GATE      = codeOf(read('lib/practice/tradingGate.ts'));

// ─── 1. Nothing is stored ─────────────────────────────────────────────────

describe('the checklist stores nothing', () => {
  it('the derivation module never writes to the database', () => {
    // The property the feature depends on. A flag written here would go stale
    // silently the moment the underlying row changed behind it.
    expect(LIB).not.toMatch(/\.insert\(/);
    expect(LIB).not.toMatch(/\.update\(/);
    expect(LIB).not.toMatch(/\.upsert\(/);
    expect(LIB).not.toMatch(/\.delete\(/);
    expect(LIB).not.toMatch(/\.rpc\(/);
  });

  it('the card is presentation only — it neither reads nor writes', () => {
    expect(CARD).not.toMatch(/\.from\(/);
    expect(CARD).not.toMatch(/createClient/);
  });

  it('no migration puts a setup-completion column on the practices table', () => {
    // Scans the whole migration tree, not just the newest file — the point is
    // that this feature added no schema at all, and that a later one adding a
    // flag has to break this test to do it.
    //
    // Scoped to statements about `practices` on purpose. profiles carries a
    // real onboarding_completed column (0066), but that is the PATIENT
    // identity gate — a different flow with a different lifecycle, and not
    // something this test has any business forbidding.
    const FLAG = /onboarding_completed|setup_completed|onboarding_step|checklist_/i;
    const dir = resolve(ROOT, 'supabase/migrations');
    const offenders: string[] = [];

    for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
      const sql = readFileSync(resolve(dir, f), 'utf8')
        // Strip SQL comments first: 0066's header DISCUSSES the column, and
        // matching prose would report a file that declares nothing.
        .split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

      for (const stmt of sql.split(';')) {
        // \bpractices\b so practice_members / practice_groups don't match.
        if (/\bpractices\b/.test(stmt) && FLAG.test(stmt)) { offenders.push(f); break; }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the feature ships no migration of its own', () => {
    // The highest migration is still 0094 (the previous task). If this
    // feature ever needs schema, that is a decision to make deliberately.
    const versions = readdirSync(resolve(ROOT, 'supabase/migrations'))
      .filter((f) => /^\d+_.*\.sql$/.test(f))
      .map((f) => parseInt(f.slice(0, 4), 10));
    expect(Math.max(...versions)).toBe(94);
  });
});

// ─── 2. Same sources as the trading gate ──────────────────────────────────

describe('the checklist reads the same sources as the trading gate', () => {
  it('resolves banking through resolvePayoutBanking, exactly as the gate does', () => {
    expect(LIB).toMatch(/import \{ resolvePayoutBanking \} from '\.\/banking'/);
    expect(GATE).toMatch(/resolvePayoutBanking/);
  });

  it('never reads the practices bank columns directly', () => {
    // A direct read would report "no banking" for a branch that settles
    // through its BRAND's central account — permanently nagging a practice
    // about something already correct. This is the drift the resolver exists
    // to prevent, and the reason the item is not keyed on the columns.
    expect(LIB).not.toMatch(/bank_name/);
    expect(LIB).not.toMatch(/bank_account_number/);
  });

  it('uses the same provider predicate as the gate — active + role=provider', () => {
    for (const src of [LIB, GATE]) {
      expect(src).toMatch(/\.eq\('active', true\)/);
      expect(src).toMatch(/\.eq\('role', 'provider'\)/);
    }
    // And no login requirement in either — a roster practitioner counts.
    expect(LIB).not.toMatch(/\.not\('user_id', 'is', null\)/);
  });

  it('excludes revoked till devices', () => {
    expect(LIB).toMatch(/\.is\('revoked_at', null\)/);
  });

  it('does not read practices.status at all — approval is the gate’s alone', () => {
    // The card says nothing about approval (the panel does, unconditionally),
    // so it has no business forming an opinion about whether a practice is
    // approved. Not selecting the column is what keeps that true.
    expect(LIB).not.toMatch(/\bstatus\b/);
    expect(LIB).not.toMatch(/awaitingApproval/);
    expect(CARD).not.toMatch(/awaitingApproval|AWAITING_APPROVAL/);
  });
});

// ─── The till is not a requirement ────────────────────────────────────────

describe('the till cannot hold the card open', () => {
  it('is not one of the required item keys', () => {
    // A practice that bills from one laptop is correctly configured. An item
    // they can never complete would make the card unfinishable, which breaks
    // the only promise it makes.
    expect(LIB).toMatch(/SetupChecklistItemKey =\s*'banking' \| 'provider' \| 'details'/);
  });

  it('completeness is decided by the required items alone', () => {
    // Not "&& suggestion === null" or any variant that lets the optional half
    // vote. The count and `complete` come off `items`, which the till is not in.
    expect(LIB).toMatch(/const complete\s*=\s*doneCount === items\.length/);
    expect(LIB).toMatch(/total:\s*items\.length/);
  });

  it('the suggestion is suppressed once the required items are done', () => {
    expect(LIB).toMatch(/suggestion:\s*complete \? null :/);
  });

  it('the suggestion has no done state, so it cannot look outstanding forever', () => {
    const type = LIB_SRC.match(/export type SetupChecklistSuggestion = \{[\s\S]*?\n\};/)?.[0] ?? '';
    expect(type.length).toBeGreaterThan(50);
    expect(type).not.toMatch(/\bdone\b/);
  });

  it('the card renders it outside the list of required items', () => {
    // Structural, not just visual: a reader (or a screen reader) walking the
    // list of things to do must not meet an optional one inside it.
    const ulEnd      = CARD.indexOf('</ul>');
    const suggestion = CARD.indexOf('{suggestion &&');
    expect(ulEnd).toBeGreaterThan(-1);
    expect(suggestion).toBeGreaterThan(ulEnd);
  });
});

// ─── 3. checkTradingGate is untouched ─────────────────────────────────────

describe('checkTradingGate is a read-only dependency', () => {
  it('still checks its three conditions in order, unchanged', () => {
    // This feature is a consumer. If the gate's own logic ever needs to
    // change, it should not be as a side effect of a dashboard card.
    expect(GATE).toMatch(/practice\.status !== 'approved'/);
    expect(GATE).toMatch(/reason: 'no_providers'/);
    expect(GATE).toMatch(/reason: 'no_banking'/);
    expect(GATE).toMatch(/banking\.source === 'none'/);
  });

  it('the checklist does not call, wrap, or re-export the gate', () => {
    // Deliberately independent: the checklist needs per-item states, and the
    // gate returns the FIRST unmet condition only. It re-derives from the
    // same sources instead of trying to invert the gate's answer.
    expect(LIB).not.toMatch(/checkTradingGate/);
  });

  it('the dashboard still runs the gate for the bill CTA and its panel', () => {
    expect(DASH).toMatch(/const gate: TradingGateResult = await checkTradingGate\(svc, practiceId\)/);
    expect(DASH).toMatch(/data-testid="trading-gate-panel"/);
    expect(DASH).toMatch(/data-testid="trading-gate-bounce-banner"/);
  });
});

// ─── 4. Placement and regression ──────────────────────────────────────────

describe('placement on the dashboard', () => {
  it('renders the checklist ABOVE the next-payout hero', () => {
    const checklist = DASH.indexOf('<PracticeSetupChecklist');
    const hero      = DASH.indexOf('<NextPayoutHero');
    expect(checklist).toBeGreaterThan(-1);
    expect(hero).toBeGreaterThan(-1);
    expect(checklist).toBeLessThan(hero);
  });

  it('leaves the hero, the dashboard body and the bill CTA in place', () => {
    // Regression: this task added a sibling section and displaced nothing.
    expect(DASH).toMatch(/<NextPayoutHero data=\{nextPayout\} dates=\{payoutDates\} \/>/);
    expect(DASH).toMatch(/<PracticeDashboardClient/);
    expect(DASH).toMatch(/<CreateBillButton/);
    expect(DASH).toMatch(/data-testid="next-payout-hero"|<NextPayoutHero/);
  });

  it('does not modify the hero or the bills table', () => {
    const hero  = read('app/practice/NextPayoutHero.tsx');
    const bills = read('app/practice/BillsTable.tsx');
    expect(hero).not.toMatch(/setupChecklist|SetupChecklist/);
    expect(bills).not.toMatch(/setupChecklist|SetupChecklist/);
  });

  it('renders the card only when there is something outstanding', () => {
    // Two independent guards, because a permanently-present checklist of
    // ticks is the failure mode: the component returns null when complete,
    // and the page renders nothing when the viewer cannot act on any of it.
    expect(CARD).toMatch(/if \(checklist\.complete\) return null/);
    expect(DASH).toMatch(/\{setupChecklist && \(/);
  });
});

// ─── Authority wiring ─────────────────────────────────────────────────────

describe('the dashboard wires authority through without widening it', () => {
  it('reads the facts with service-role, matching the gate', () => {
    // Setup state is a property of the PRACTICE. Reading it as the viewer
    // would make a brand-admin with no practice_members row see "no till" for
    // a practice that has one.
    expect(DASH).toMatch(/loadSetupChecklistFacts\(svc, practiceId\)/);
  });

  it('takes link authority from the flags already resolved for the nav shell', () => {
    expect(DASH).toMatch(/canEditDetails:\s*isBrandAdmin/);
    expect(DASH).toMatch(/canManageTeam:\s*canManagePractice/);
    expect(DASH).toMatch(/canManageTill,/);
  });

  it('shows the card only to someone who can action at least one item', () => {
    expect(DASH).toMatch(/canSeeChecklist\s*=\s*\n?\s*checklistAuthority\.canEditDetails/);
  });

  it('never collapses brand authority and manager rights into one flag', () => {
    // The constraint app/practice/practiceViewer.test.ts enforces on this
    // file: canManagePractice is false on the brand path, and a literal
    // `canManagePractice || isBrandAdmin` would let brand authority stand in
    // for practice-member capability. Visibility is a disjunction over the
    // three per-SCREEN rights instead, so each stays attached to the screen
    // that enforces it.
    expect(DASH).not.toMatch(/canManagePractice\s*\|\|\s*isBrandAdmin/);
    expect(DASH).not.toMatch(/canEditDetails:\s*(isBrandAdmin\s*\|\||canManagePractice)/);
    expect(DASH).not.toMatch(/canManageTeam:\s*(canManagePractice\s*\|\||isBrandAdmin)/);
  });

  it('adds no authority query of its own', () => {
    // canManagePractice and isBrandAdmin were both already resolved for the
    // nav shell; re-querying them would be a second source of truth for the
    // same permission.
    const callSites = (DASH.match(/await resolvePracticeShellAuthority\(/g) ?? []).length;
    expect(callSites).toBe(1);
    expect(DASH).not.toMatch(/practice_group_members/);
  });
});

// ─── One instruction per task ──────────────────────────────────────────────

describe('the gate panel and the checklist do not both instruct', () => {
  it('the panel is suppressed for the two reasons the checklist covers', () => {
    // no_providers and no_banking were a panel paragraph AND a checklist row,
    // in different words, stacked. Two wordings for one task read as two tasks.
    expect(DASH).toMatch(
      /const showGatePanel\s*=\s*\n?\s*!gate\.ok && \(gate\.reason === 'pending_approval' \|\| !checklistShown\)/,
    );
    expect(DASH).toMatch(/\{showGatePanel && \(/);
  });

  it('pending_approval survives regardless of the checklist', () => {
    // The one gate reason the card says nothing about, and the one nobody at
    // the practice can action. It must never be conditional on the card.
    const cond = DASH.match(/const showGatePanel\s*=[\s\S]*?;/)?.[0] ?? '';
    expect(cond).toMatch(/gate\.reason === 'pending_approval' \|\|/);
    // Written as a disjunction, so no value of checklistShown can remove it.
    expect(cond).not.toMatch(/pending_approval'\s*&&/);
  });

  it('suppression is conditional on the card actually being on the page', () => {
    // Not a permanent narrowing of the panel. A reception-level member gets no
    // card (canSeeChecklist is false), and a complete checklist renders nothing
    // — on both of those surfaces the panel must be exactly what it was.
    expect(DASH).toMatch(
      /const checklistShown\s*=\s*!!setupChecklist && !setupChecklist\.complete/,
    );
  });

  it('the panel still keeps its own actionable links for the unsuppressed cases', () => {
    // Regression: the surfaces that DO fall through to the panel must not have
    // lost the "Go to Team" / "Go to Banking" links with the de-duplication.
    expect(DASH).toMatch(/gate\.reason === 'no_providers' && \(/);
    expect(DASH).toMatch(/gate\.reason === 'no_banking' && \(/);
    expect(DASH).toMatch(/Go to Team/);
    expect(DASH).toMatch(/Go to Banking/);
  });

  it('the bounce-back banner explains the redirect without restating the fix', () => {
    // It still renders — it is the only thing that says "you asked for the bill
    // form and got sent back" — but when the card is up it points at the list
    // instead of repeating one row of it in the gate's words.
    expect(DASH).toMatch(/data-testid="trading-gate-bounce-banner"/);
    expect(DASH).toMatch(/cameFromGatedBillsPage && !gate\.ok/);
    expect(DASH).toMatch(/checklistShown\s*\n?\s*\?\s*'Everything that/);
    expect(DASH).toMatch(/:\s*gate\.message/);
  });

  it('leaves every OTHER consumer of the gate alone', () => {
    // The gate result has five other consumers. None of them renders the
    // checklist, so none of them had a duplication to fix — and touching them
    // is how a de-duplication breaks something nobody was looking at.
    const BILLS_NEW = codeOf(read('app/practice/bills/new/page.tsx'));
    const DETAILS   = codeOf(read('app/practice/details/page.tsx'));
    const POS       = codeOf(read('app/practice/pos/actions.ts'));
    const CTA       = codeOf(read('app/practice/CreateBillButton.tsx'));

    // /practice/bills/new still bounces with the reason param.
    expect(BILLS_NEW).toMatch(/redirect\(`\/practice\?reason=trading_gate/);
    // /practice/details keeps its own co-located banking hint.
    expect(DETAILS).toMatch(/gate\.reason === 'no_banking'/);
    expect(DETAILS).toMatch(/branch-banking-hint/);
    // The POS action still enforces the gate.
    expect(POS).toMatch(/checkTradingGate/);
    // Every "Create a bill" entry point still carries the gate's own message.
    expect(CTA).toMatch(/title=\{gate\.message\}/);
    // And none of them knows the checklist exists.
    for (const src of [BILLS_NEW, DETAILS, POS, CTA]) {
      expect(src).not.toMatch(/SetupChecklist|checklistShown/);
    }
  });
});

// ─── Copy — the gogo test ─────────────────────────────────────────────────

describe('the copy explains why, in plain language', () => {
  it('every item states a benefit, not a feature', () => {
    // Pinned on the lib, which owns the strings — the card only renders them.
    expect(LIB).toMatch(/So we can pay you/);
    expect(LIB).toMatch(/who treated the patient/);
    expect(LIB).toMatch(/patients can find you/);
  });

  it('no user-facing string names a column, a table, or a role', () => {
    // Extract the copy blocks and check them in isolation, so the surrounding
    // implementation comments cannot mask a leak into the actual strings.
    const JARGON = /practice_members|till_pin_hash|bank_account_number|provider_id|RLS|payout|can_manage_practice/i;

    const copy = LIB_SRC.match(/const COPY[\s\S]*?\n\};/)?.[0] ?? '';
    expect(copy.length).toBeGreaterThan(100);
    expect(copy).not.toMatch(JARGON);

    const nudge = LIB_SRC.match(/export const TILL_SUGGESTION[\s\S]*?\n\} as const;/)?.[0] ?? '';
    expect(nudge.length).toBeGreaterThan(100);
    expect(nudge).not.toMatch(JARGON);
  });

  it('the till nudge says it is optional, and makes both halves of the case', () => {
    const nudge = LIB_SRC.match(/export const TILL_SUGGESTION[\s\S]*?\n\} as const;/)?.[0] ?? '';
    // Optional, said outright rather than implied by styling alone.
    expect(nudge).toMatch(/Optional/);
    // Ease of use — reception is not waiting on the manager.
    expect(nudge).toMatch(/without waiting for you/i);
    // Security, made concrete: a PIN of their own instead of a shared login.
    expect(nudge).toMatch(/PIN/);
    expect(nudge).toMatch(/login never has to be shared/i);
    // Fresh wording, not the required-item line it replaced.
    expect(nudge).not.toMatch(/borrowing your login/i);
    // And it does not read as a demand.
    expect(nudge).not.toMatch(/you must|required|before you can/i);
  });
});
