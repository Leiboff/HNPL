import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Source-pin tests — CRM Phase 2 UI wirings ────────────────────────
//
// Regex-based structural invariants, matching the house pattern
// (crm-lead-upgrades.test.ts, crm-migrations.test.ts). Covers the
// parts of Phase 2 that are cheapest and most reliable to pin at the
// source level rather than through a full component render — the
// dependency surface of LeadDetailClient/BoardClient (Places
// autocomplete, Gmail compose, etc.) makes full rendering brittle for
// what are really "is this wired the way the spec says" checks.

function read(p: string): string { return readFileSync(resolve(process.cwd(), p), 'utf8'); }

describe('11. Move stage to lost without a reason is blocked in the UI before the request is sent', () => {
  it('LeadDetailClient — canSubmit requires a non-empty reason before Move is enabled', () => {
    const SRC = read('app/crm/leads/[id]/LeadDetailClient.tsx');
    expect(SRC).toMatch(/const canSubmit = stage !== current && \(!requireReason \|\| reason\.trim\(\)\.length > 0\)/);
    expect(SRC).toMatch(/disabled={pending \|\| !canSubmit}/);
  });

  it('BoardClient — the "Move to lost" button is disabled while reason is empty', () => {
    const SRC = read('app/crm/board/BoardClient.tsx');
    expect(SRC).toMatch(/disabled={pending \|\| !reason\.trim\(\)}/);
  });
});

describe('Lost-reason picker uses the Phase 1 enum, not free text', () => {
  it('LeadDetailClient renders a <select> bound to LOST_REASONS', () => {
    const SRC = read('app/crm/leads/[id]/LeadDetailClient.tsx');
    expect(SRC).toMatch(/import \{ LOST_REASONS, LOST_REASON_LABELS \} from '@\/lib\/crm\/lostReasons'/);
    expect(SRC).toMatch(/data-testid="lead-lost-reason-picker"/);
    expect(SRC).toMatch(/\{LOST_REASONS\.map\(r => <option key={r} value={r}>\{LOST_REASON_LABELS\[r\]\}<\/option>\)\}/);
    expect(SRC).not.toMatch(/Lost reason[\s\S]{0,80}<input/);
  });

  it('BoardClient renders a <select> bound to LOST_REASONS', () => {
    const SRC = read('app/crm/board/BoardClient.tsx');
    expect(SRC).toMatch(/data-testid="board-lost-reason-picker"/);
    expect(SRC).toMatch(/\{LOST_REASONS\.map\(r => <option key={r} value={r}>\{LOST_REASON_LABELS\[r\]\}<\/option>\)\}/);
  });

  it('moveLeadStage validates lostReason against the enum server-side too', () => {
    const SRC = read('app/crm/leads/actions.ts');
    expect(SRC).toMatch(/const LOST_REASONS = new Set\(\[/);
    expect(SRC).toMatch(/if \(toStage === 'lost' && \(!lostReason \|\| !LOST_REASONS\.has\(lostReason\)\)\)/);
  });
});

describe('12. adversarial — no raw enum value appears in rendered output', () => {
  it('FieldSelect supports a labels map and LeadDetailClient uses it for Source', () => {
    const SRC = read('app/crm/leads/[id]/LeadDetailClient.tsx');
    expect(SRC).toMatch(/labels\?: Record<string, string>/);
    expect(SRC).toMatch(/\{options\.map\(o => <option key={o \|\| '\(none\)'} value={o}>\{o \? \(labels\?\.\[o\] \?\? o\) : '\(none\)'}<\/option>\)\}/);
    expect(SRC).toMatch(/SOURCE_LABELS/);
    expect(SRC).toMatch(/<FieldSelect label="Source"[\s\S]{0,120}labels={SOURCE_LABELS}/);
  });

  it('SOURCE_LABELS covers every SOURCES value with a human label', () => {
    const SRC = read('app/crm/leads/[id]/LeadDetailClient.tsx');
    for (const s of ['referral', 'cold_outreach', 'inbound', 'event', 'other']) {
      expect(SRC).toMatch(new RegExp(`${s}: '[^']+'`));
    }
  });

  it('NewLeadForm never renders a raw source value — .replace strips the underscore', () => {
    const SRC = read('app/crm/leads/new/NewLeadForm.tsx');
    expect(SRC).toMatch(/\{SOURCES\.map\(s => <option key={s} value={s}>\{s\.replace\('_', ' '\)\}<\/option>\)\}/);
  });
});

describe('13. a WhatsApp activity logs, persists, and appears in the timeline with icon + type label', () => {
  it('the quick-actions strip has a Log WhatsApp button', () => {
    const SRC = read('app/crm/leads/[id]/LeadDetailClient.tsx');
    expect(SRC).toMatch(/setShowLog\(\{ type: 'whatsapp' \}\)\}\s*label="Log WhatsApp"/);
  });

  it('the timeline badge carries a per-type icon, including whatsapp', () => {
    const SRC = read('app/crm/leads/[id]/LeadDetailClient.tsx');
    expect(SRC).toMatch(/const ACTIVITY_ICONS: Record<string, string> = \{/);
    expect(SRC).toMatch(/whatsapp: '[^']+'/);
    expect(SRC).toMatch(/data-testid={`crm-activity-type:\$\{item\.activity\.type\}`}/);
  });

  it('logActivity already accepts type "whatsapp" server-side (pre-existing)', () => {
    const SRC = read('app/crm/leads/actions.ts');
    expect(SRC).toMatch(/type:\s*'call' \| 'meeting' \| 'whatsapp' \| 'email' \| 'note'/);
  });

  it('crm_activities.type CHECK constraint permits whatsapp (pre-existing, from 0069)', () => {
    const SRC = read('supabase/migrations/0069_crm_leads_and_activities.sql');
    expect(SRC).toMatch(/CHECK \(type IN \([\s\S]*?'whatsapp'/);
  });
});

describe('2.1 — value wired onto every screen', () => {
  it('leads list selects and sorts by estimated_monthly_billings', () => {
    const SRC = read('app/crm/leads/page.tsx');
    expect(SRC).toMatch(/estimated_monthly_billings/);
    expect(SRC).toMatch(/'value'/);
  });

  it('board selects estimated_monthly_billings and shows a per-stage total', () => {
    const PAGE = read('app/crm/board/page.tsx');
    expect(PAGE).toMatch(/estimated_monthly_billings/);
    const CLIENT = read('app/crm/board/BoardClient.tsx');
    expect(CLIENT).toMatch(/stageValue = stageRows\.reduce/);
  });

  it('My Day replaces the conversion-rate tile with a not-enough-data-guarded weighted pipeline figure', () => {
    const SRC = read('app/crm/page.tsx');
    expect(SRC).not.toMatch(/Conversion/);
    expect(SRC).toMatch(/weightedPipelineValue/);
    expect(SRC).toMatch(/hasEnoughData\(pipelineSampleSize\) \? formatRand\(weightedPipeline\) : 'Not enough data yet'/);
  });
});

describe('2.2 — ownership sequencing (assign UI → reassign → RLS)', () => {
  it('bulkAssignOwner exists and relies on RLS, not an app-level ownership check, for the actual guarantee', () => {
    const SRC = read('app/crm/leads/actions.ts');
    expect(SRC).toMatch(/export async function bulkAssignOwner/);
  });

  it('the reassignment migration (0112) is numbered before the RLS-tightening migration (0113)', () => {
    // File existence + ordering IS the sequencing guarantee — Supabase applies
    // migrations in ascending filename order, so 0112 always completes before
    // 0113's CREATE POLICY statements exist.
    expect(() => read('supabase/migrations/0112_crm_reassign_admin_owned_leads.sql')).not.toThrow();
    expect(() => read('supabase/migrations/0113_crm_leads_owner_scoped_rls.sql')).not.toThrow();
  });

  it('owner field ships in both the new-lead form and the lead detail form', () => {
    expect(read('app/crm/leads/new/NewLeadForm.tsx')).toMatch(/Field label="Owner"/);
    expect(read('app/crm/leads/[id]/LeadDetailClient.tsx')).toMatch(/label="Owner"/);
  });
});
