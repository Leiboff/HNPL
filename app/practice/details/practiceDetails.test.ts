import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── The two legacy settings routes are REDIRECTS, not 404s ───────────────
//
// /practice/details and /practice/pos/devices are sections of
// /practice/settings now. This file used to pin the CONTENT of
// /practice/details; those invariants moved wholesale to
// app/practice/settings/practiceSettings.test.ts, which is where the forms
// now render. What is pinned here is the thing the move created: both old
// URLs must still resolve, because several live inbound links and any number
// of bookmarks point at them.
//
// The inbound links, enumerated so a future change cannot quietly break one:
//
//   /practice/details
//     • lib/practice/setupChecklist.ts — "Add your address" (bare) and
//       "Add bank details" (carries #banking)
//     • app/practice/page.tsx — the trading-gate panel's "Go to Banking →",
//       also #banking
//     • app/brand/actions.ts — revalidatePath('/practice/details')
//
//   /practice/pos/devices
//     • lib/practice/setupChecklist.ts — the till suggestion
//     • app/brand/GroupDashboard.tsx — per-branch "Till devices", scoped by
//       that branch's id
//
// Two of those carry a #banking fragment, which is why the details stub must
// NOT name a fragment of its own: a redirect whose Location has no fragment
// lets the browser re-apply the caller's, so #banking still lands on the
// banking section. Naming one here would override it.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

// Shared helper — see lib/testing/stripComments.ts. These sources discuss
// paths like `app/practice/pos/devices/**` inside `//` prose, which a
// hand-rolled strip mis-reads as a comment opener.
const codeOf = (src: string) => stripComments(src);

const DETAILS = codeOf(read('app/practice/details/page.tsx'));
const DEVICES = codeOf(read('app/practice/pos/devices/page.tsx'));

describe('/practice/details redirects into the Settings page', () => {
  it('redirects rather than rendering or 404ing', () => {
    expect(DETAILS).toMatch(/redirect\(`\/practice\/settings\$\{suffix\}`\)/);
    expect(DETAILS).not.toMatch(/notFound\(\)/);
    expect(DETAILS).not.toMatch(/<PracticeShell/);
  });

  it('names NO fragment, so an inbound #banking survives the hop', () => {
    // The load-bearing detail. Per RFC 7231 a redirect target without a
    // fragment inherits the request's, and both #banking links depend on it.
    expect(DETAILS).not.toMatch(/\/practice\/settings[^`'"]*#/);
  });

  it('preserves ?practiceId= so a brand-admin lands on the branch they meant', () => {
    expect(DETAILS).toMatch(/params\.practiceId/);
    expect(DETAILS).toMatch(/encodeURIComponent\(params\.practiceId\)/);
  });

  it('still requires a normal login', () => {
    // Dropping it would make this a third /practice/** route reachable
    // without one — see app/practice/practice-routes-auth.test.ts, which
    // pins that boundary at exactly two (the till kiosk and its
    // registration screen).
    expect(DETAILS).toMatch(/requireConfirmedUser/);
  });

  it('carries no gate of its own — the destination decides', () => {
    // A second, narrower gate on a redirect stub is how a legitimate viewer
    // ends up bounced before the real check ever runs.
    expect(DETAILS).not.toMatch(/isBrandAdmin/);
    expect(DETAILS).not.toMatch(/resolvePracticeShellAuthority/);
    expect(DETAILS).not.toMatch(/from\('practices'\)/);
  });
});

describe('/practice/pos/devices redirects into the till section', () => {
  it('redirects straight to #till', () => {
    // Nothing links here with a fragment of its own, so there is none to
    // preserve — and landing on the section beats landing at the top of a
    // page whose first two sections a plain manager cannot even see.
    expect(DEVICES).toMatch(/redirect\(`\/practice\/settings\$\{suffix\}#till`\)/);
    expect(DEVICES).not.toMatch(/<PracticeShell/);
  });

  it('preserves ?practiceId= — the brand dashboard link identifies the branch', () => {
    expect(DEVICES).toMatch(/encodeURIComponent\(params\.practiceId\)/);
  });

  it('still requires a normal login', () => {
    expect(DEVICES).toMatch(/requireConfirmedUser/);
  });

  it('does NOT re-implement the manager check', () => {
    // Authorization still belongs to listDevices()'s guardTillManager, which
    // the Settings page calls. A narrower duplicate gate on this route is
    // exactly what made the brand-admin path 404 here once before.
    expect(DEVICES).not.toMatch(/listDevices/);
    expect(DEVICES).not.toMatch(/can_manage_practice/);
    expect(DEVICES).not.toMatch(/resolvePracticeShellAuthority/);
  });
});

describe('the inbound links still point somewhere that resolves', () => {
  it('the setup checklist still targets both legacy routes, and they redirect', () => {
    // The checklist is deliberately untouched by the restructure: its two
    // hrefs keep working precisely because the stubs above exist.
    const CHECKLIST = codeOf(read('lib/practice/setupChecklist.ts'));
    expect(CHECKLIST).toMatch(/'\/practice\/details#banking'/);
    expect(CHECKLIST).toMatch(/'\/practice\/details'/);
    expect(CHECKLIST).toMatch(/'\/practice\/pos\/devices'/);
  });

  it('the dashboard’s banking CTA still targets the #banking anchor', () => {
    const DASH = codeOf(read('app/practice/page.tsx'));
    expect(DASH).toMatch(/\/practice\/details\?practiceId=\$\{practiceId\}#banking/);
  });

  it('the brand surface’s per-practice till link still resolves', () => {
    // RELOCATED, not weakened. This link used to live on the brand dashboard's
    // per-branch performance strip; the brand-portal restructure retired that
    // strip and moved the link onto /brand/practices' till column, which is
    // where the till's STATE is now reported. Same route, same per-practice
    // scoping — so the obligation on the /practice/pos/devices stub is
    // unchanged, which is the only thing this file cares about.
    const TABLE = codeOf(read('app/brand/practices/PracticesTable.tsx'));
    expect(TABLE).toMatch(/\/practice\/pos\/devices\?practiceId=\$\{p\.practiceId\}/);
    // And it is gone from where it used to be, so there is only one of it.
    const GROUP = codeOf(read('app/brand/GroupDashboard.tsx'));
    expect(GROUP).not.toMatch(/\/practice\/pos\/devices/);
  });

  it('the Settings page renders the anchors all of those depend on', () => {
    const SETTINGS = codeOf(read('app/practice/settings/page.tsx'));
    expect(SETTINGS).toMatch(/id="banking"/);
    expect(SETTINGS).toMatch(/id="till"/);
  });
});
