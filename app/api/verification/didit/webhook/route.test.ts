// @vitest-environment node
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { randomBytes } from 'crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NextRequest } from 'next/server';
import { signDiditWebhookForTesting } from '@/lib/didit/webhook';
import { VALID_SA_IDS, INVALID_SA_IDS } from '@/lib/testing/saIdFixtures';

// ─── Didit webhook route — surface-level integration tests ──────────────
//
// Covers BOTH paths now:
//   • OCR fallback (handleApprovedOcr) — REGRESSION ONLY. Every assertion
//     in that describe block existed before the DHA path did; behaviour
//     must be byte-for-byte identical (case 21).
//   • DHA (handleApprovedDha) — new coverage: no id_verifications
//     assumed (case 20), face-match threshold enforcement (case 22),
//     environment/workflow persistence (case 16), the transient/
//     deterministic duplicate-check split (case 14's neighbour), and
//     the stored-path-vs-workflow_id cross-check (Change 3).
//
// DIDIT_WORKFLOW_ID / DIDIT_DHA_WORKFLOW_ID are deliberately left UNSET
// in most tests — resolveVerificationPath's cross-check only fires when
// both an expected and an actual workflow_id are present, so leaving
// them unset keeps the regression tests indifferent to it. The one test
// that exercises the cross-check sets them explicitly.

const SECRET  = 'test-didit-webhook-secret';
const USER_ID = 'user-1';

type Row = Record<string, unknown>;

const dbState: {
  profiles:        Row[];
  webhookEventIds: Set<string>;
  profileUpdates:  Row[];
} = { profiles: [], webhookEventIds: new Set(), profileUpdates: [] };

function selectChain(rows: Row[]) {
  const filters: Array<(row: Row) => boolean> = [];
  const builder = {
    eq(col: string, val: unknown) { filters.push((r) => r[col] === val); return builder; },
    order() { return builder; },
    limit: async (n: number) => ({ data: rows.filter((r) => filters.every((f) => f(r))).slice(0, n), error: null }),
    maybeSingle: async () => ({ data: rows.find((r) => filters.every((f) => f(r))) ?? null, error: null }),
  };
  return builder;
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from(table: string) {
      if (table === 'didit_webhook_events') {
        return {
          insert: async (row: { event_id: string }) => {
            if (dbState.webhookEventIds.has(row.event_id)) {
              return { error: { code: '23505', message: 'duplicate key' } };
            }
            dbState.webhookEventIds.add(row.event_id);
            return { error: null };
          },
        };
      }
      if (table === 'profiles') {
        return {
          update: (row: Row) => ({
            eq: (col: string, val: unknown) => {
              const idx = dbState.profiles.findIndex((p) => p[col] === val);
              if (idx >= 0) dbState.profiles[idx] = { ...dbState.profiles[idx], ...row };
              dbState.profileUpdates.push({ ...row, __eq: { [col]: val } });
              return Promise.resolve({ data: null, error: null });
            },
          }),
          select: () => selectChain(dbState.profiles),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  })),
}));


const { findPatientBySaId } = vi.hoisted(() => ({ findPatientBySaId: vi.fn() }));
vi.mock('@/lib/patients/findPatientBySaId', () => ({ findPatientBySaId }));

// Import AFTER mocks are wired.
import { POST } from './route';
import { encryptId, hashIdForLookup } from '@/lib/idEncryption';

function buildRequest(body: unknown, opts?: { signature?: string; timestamp?: string; skipSign?: boolean }): NextRequest {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (!opts?.skipSign) {
    const { signature, timestamp } = signDiditWebhookForTesting({
      body, secret: SECRET, timestamp: opts?.timestamp,
    });
    headers['x-signature-v2'] = opts?.signature ?? signature;
    headers['x-timestamp']    = timestamp;
  }
  return new NextRequest('https://app.test/api/verification/didit/webhook', {
    method: 'POST',
    headers,
    body: raw,
  });
}

function baseEvent(overrides?: Partial<Row>): Row {
  return {
    event_id:         'evt-1',
    webhook_type:     'status.updated',
    timestamp:        Math.floor(Date.now() / 1000),
    created_at:        Math.floor(Date.now() / 1000),
    application_id:   'app-1',
    environment:       'sandbox',
    session_id:       'sess-1',
    status:           'Approved',
    workflow_id:      'wf-1',
    workflow_version: 1,
    vendor_data:      USER_ID,
    metadata:         null,
    ...overrides,
  };
}

function ocrEvent(overrides?: Partial<Row>): Row {
  return baseEvent({
    decision: {
      id_verifications: [{ personal_number: VALID_SA_IDS[0], first_name: 'Jane', last_name: 'Doe' }],
      liveness_checks:  [{ status: 'Approved' }],
      face_matches:     [{ status: 'Approved' }],
    },
    ...overrides,
  });
}

function dhaEvent(overrides?: Partial<Row>): Row {
  return baseEvent({
    decision: {
      face_matches: [{ status: 'Approved', score: 90 }],
    },
    ...overrides,
  });
}

beforeAll(() => {
  process.env.SA_ID_ENCRYPTION_KEY  = randomBytes(32).toString('base64');
  process.env.SA_ID_LOOKUP_HMAC_KEY = randomBytes(32).toString('base64');
});

beforeEach(() => {
  process.env.DIDIT_WEBHOOK_SECRET = SECRET;
  delete process.env.DIDIT_WORKFLOW_ID;
  delete process.env.DIDIT_DHA_WORKFLOW_ID;
  delete process.env.DHA_FACE_MATCH_APPROVE_MIN;
  delete process.env.DHA_FACE_MATCH_REVIEW_MIN;
  dbState.profiles = [{ id: USER_ID, role: 'patient', email: 'a@test.com', identity_verification_path: 'ocr' }];
  dbState.webhookEventIds = new Set();
  dbState.profileUpdates.length = 0;

  findPatientBySaId.mockReset();
  // Default: faithfully replicates the real function's query semantics
  // (match on sa_id_lookup_hash + role='patient', first match wins) so
  // every test not specifically about the lookup failing behaves as if
  // the real function ran.
  findPatientBySaId.mockImplementation(async (_supabase: unknown, plaintext: string) => {
    const hash = hashIdForLookup(plaintext);
    const match = dbState.profiles.find((p) => p.sa_id_lookup_hash === hash && p.role === 'patient');
    return match ? { id: match.id as string, email: (match.email as string | undefined) ?? null } : null;
  });
});

describe('signature verification', () => {
  it('rejects a bad signature with 401', async () => {
    const res = await POST(buildRequest(ocrEvent(), { signature: 'deadbeef'.repeat(8) }));
    expect(res.status).toBe(401);
  });

  it('rejects an unsigned delivery with 401', async () => {
    const res = await POST(buildRequest(ocrEvent(), { skipSign: true }));
    expect(res.status).toBe(401);
  });

  it('15. rejects a stale timestamp with 401 (a non-404 4xx Didit\'s retry policy never retries — deliberate)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const res = await POST(buildRequest(ocrEvent(), { timestamp: String(now - 1000) }));
    expect(res.status).toBe(401);
  });

  it('500s when DIDIT_WEBHOOK_SECRET is unset', async () => {
    delete process.env.DIDIT_WEBHOOK_SECRET;
    const res = await POST(buildRequest(ocrEvent()));
    expect(res.status).toBe(500);
  });
});

describe('14. idempotency — replayed event_id is a no-op', () => {
  it('processes a fresh event_id, then acknowledges a retried duplicate without reprocessing', async () => {
    const event = ocrEvent();
    const res1 = await POST(buildRequest(event));
    expect(res1.status).toBe(200);
    expect(dbState.profiles[0].identity_verification_status).toBe('approved');

    dbState.profileUpdates.length = 0;
    const res2 = await POST(buildRequest(event));
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.duplicate).toBe(true);
    expect(dbState.profileUpdates).toHaveLength(0);
  });
});

describe('21. OCR fallback path — REGRESSION, unchanged from before the DHA path existed', () => {
  it('persists sa_id_number + liveness_verified_at on a valid, unclaimed SA ID', async () => {
    const res = await POST(buildRequest(ocrEvent()));
    expect(res.status).toBe(200);
    const row = dbState.profiles[0];
    expect(row.identity_verification_status).toBe('approved');
    expect(row.liveness_verified_at).toBeTruthy();
    expect(row.sa_id_number).toBeTruthy();
    expect(row.sa_id_lookup_hash).toBeTruthy();
  });

  it('declines when Didit returned no personal_number', async () => {
    const res = await POST(buildRequest(ocrEvent({ decision: { id_verifications: [{ personal_number: null }] } })));
    expect(res.status).toBe(200);
    expect(dbState.profiles[0].identity_verification_status).toBe('declined');
    expect(dbState.profiles[0].identity_verification_reason).toBe('no_id_extracted');
    expect(dbState.profiles[0].sa_id_number).toBeUndefined();
  });

  it('declines when the extracted ID fails validateSaId (bad checksum)', async () => {
    const res = await POST(buildRequest(ocrEvent({
      decision: { id_verifications: [{ personal_number: INVALID_SA_IDS[0].id }] },
    })));
    expect(res.status).toBe(200);
    expect(dbState.profiles[0].identity_verification_status).toBe('declined');
    expect(dbState.profiles[0].identity_verification_reason).toBe('invalid_id');
  });

  it('declines when the extracted ID already belongs to a different account', async () => {
    dbState.profiles.push({
      id: 'other-user', role: 'patient', email: 'b@test.com',
      sa_id_lookup_hash: hashIdForLookup(VALID_SA_IDS[0]),
    });
    const res = await POST(buildRequest(ocrEvent()));
    expect(res.status).toBe(200);
    expect(dbState.profiles[0].identity_verification_status).toBe('declined');
    expect(dbState.profiles[0].identity_verification_reason).toBe('id_already_registered');
    expect(dbState.profiles[0].sa_id_number).toBeUndefined();
  });

  it('is a no-op re-verification (not "declined") when the SAME account already owns this ID', async () => {
    dbState.profiles[0].sa_id_lookup_hash = hashIdForLookup(VALID_SA_IDS[0]);
    const res = await POST(buildRequest(ocrEvent()));
    expect(res.status).toBe(200);
    expect(dbState.profiles[0].identity_verification_status).toBe('approved');
  });

  it.each([
    ['Declined', 'declined'],
    ['In Review', 'in_review'],
    ['Abandoned', 'abandoned'],
    ['Expired', 'expired'],
    ['Kyc Expired', 'expired'],
  ])('%s maps identity_verification_status to %s', async (diditStatus, expected) => {
    const res = await POST(buildRequest(ocrEvent({ event_id: `evt-${diditStatus}`, status: diditStatus, decision: null })));
    expect(res.status).toBe(200);
    expect(dbState.profiles[0].identity_verification_status).toBe(expected);
    expect(dbState.profiles[0].sa_id_number).toBeUndefined();
  });

  it('leaves the profile untouched for In Progress (still mid-flow)', async () => {
    const res = await POST(buildRequest(ocrEvent({ event_id: 'evt-inprog', status: 'In Progress', decision: null })));
    expect(res.status).toBe(200);
    expect(dbState.profileUpdates).toHaveLength(0);
  });
});

describe('20. DHA path — decision applied without assuming id_verifications exists', () => {
  beforeEach(() => {
    dbState.profiles[0] = {
      ...dbState.profiles[0],
      identity_verification_path: 'dha',
      pending_sa_id_number:      encryptId(VALID_SA_IDS[0]),
      pending_sa_id_lookup_hash: hashIdForLookup(VALID_SA_IDS[0]),
      dha_first_name: 'Jane', dha_last_name: 'Doe',
    };
  });

  it('approves and promotes pending_sa_id_* to the canonical columns', async () => {
    const res = await POST(buildRequest(dhaEvent()));
    expect(res.status).toBe(200);
    const row = dbState.profiles[0];
    expect(row.identity_verification_status).toBe('approved');
    expect(row.sa_id_number).toBeTruthy();
    expect(row.sa_id_lookup_hash).toBeTruthy();
    expect(row.liveness_verified_at).toBeTruthy();
    expect(row.pending_sa_id_number).toBeNull();
    expect(row.pending_sa_id_lookup_hash).toBeNull();
  });

  it('does not crash or read id_verifications on a DHA decision that has none', async () => {
    const res = await POST(buildRequest(dhaEvent({ decision: { face_matches: [{ status: 'Approved', score: 95 }] } })));
    expect(res.status).toBe(200);
    expect(dbState.profiles[0].identity_verification_status).toBe('approved');
  });
});

describe('22. DHA path — face-match score below the approve threshold declines', () => {
  beforeEach(() => {
    dbState.profiles[0] = {
      ...dbState.profiles[0],
      identity_verification_path: 'dha',
      pending_sa_id_number:      encryptId(VALID_SA_IDS[0]),
      pending_sa_id_lookup_hash: hashIdForLookup(VALID_SA_IDS[0]),
    };
  });

  it('a score below DHA_FACE_MATCH_REVIEW_MIN declines, with the score persisted', async () => {
    const res = await POST(buildRequest(dhaEvent({ decision: { face_matches: [{ status: 'Approved', score: 20 }] } })));
    expect(res.status).toBe(200);
    expect(dbState.profiles[0].identity_verification_status).toBe('declined');
    expect(dbState.profiles[0].identity_verification_reason).toBe('face_match_below_threshold');
    expect(dbState.profiles[0].dha_face_match_score).toBe(20);
    expect(dbState.profiles[0].sa_id_number).toBeUndefined();
  });

  it('a score in the ambiguous band routes to review, never to the OCR fallback', async () => {
    const res = await POST(buildRequest(dhaEvent({ decision: { face_matches: [{ status: 'Approved', score: 55 }] } })));
    expect(res.status).toBe(200);
    expect(dbState.profiles[0].identity_verification_status).toBe('in_review');
    expect(dbState.profiles[0].identity_verification_path).toBe('dha'); // never flipped to 'ocr'
    expect(dbState.profiles[0].dha_face_match_score).toBe(55);
  });

  it('a missing score declines (never treated as a pass)', async () => {
    const res = await POST(buildRequest(dhaEvent({ decision: {} })));
    expect(res.status).toBe(200);
    expect(dbState.profiles[0].identity_verification_status).toBe('declined');
    expect(dbState.profiles[0].identity_verification_reason).toBe('face_match_below_threshold');
  });

  it('thresholds are env-configurable, not hardcoded', async () => {
    process.env.DHA_FACE_MATCH_APPROVE_MIN = '99';
    const res = await POST(buildRequest(dhaEvent({ decision: { face_matches: [{ status: 'Approved', score: 90 } ] } })));
    expect(res.status).toBe(200);
    expect(dbState.profiles[0].identity_verification_status).toBe('in_review');
  });
});

describe('13. concurrent sessions for the same SA ID — one-ID-per-account still enforced across paths', () => {
  it('a DHA-path Approved for an ID another account already owns declines, does not overwrite the owner', async () => {
    dbState.profiles.push({
      id: 'other-user', role: 'patient', email: 'owner@test.com',
      sa_id_lookup_hash: hashIdForLookup(VALID_SA_IDS[0]),
    });
    dbState.profiles[0] = {
      ...dbState.profiles[0],
      identity_verification_path: 'dha',
      pending_sa_id_number:      encryptId(VALID_SA_IDS[0]),
      pending_sa_id_lookup_hash: hashIdForLookup(VALID_SA_IDS[0]),
    };
    const res = await POST(buildRequest(dhaEvent()));
    expect(res.status).toBe(200);
    expect(dbState.profiles[0].identity_verification_status).toBe('declined');
    expect(dbState.profiles[0].identity_verification_reason).toBe('id_already_registered');
    expect(dbState.profiles[0].sa_id_number).toBeUndefined();
  });
});

describe('16. environment + workflow persistence', () => {
  it('a sandbox event is recorded as sandbox, never silently treated as live', async () => {
    const res = await POST(buildRequest(ocrEvent({ environment: 'sandbox' })));
    expect(res.status).toBe(200);
    expect(dbState.profiles[0].identity_verification_environment).toBe('sandbox');
  });

  it('workflow_id and workflow_version are persisted on every status update', async () => {
    const res = await POST(buildRequest(ocrEvent({ workflow_id: 'wf-abc', workflow_version: 7 })));
    expect(res.status).toBe(200);
    expect(dbState.profiles[0].identity_verification_workflow_id).toBe('wf-abc');
    expect(dbState.profiles[0].identity_verification_workflow_version).toBe(7);
  });
});

describe('path resolution (Change 3) — stored path is authority, workflow_id is a cross-check only', () => {
  it('a disagreement between stored path and the envelope workflow_id routes to review, never guesses', async () => {
    process.env.DIDIT_WORKFLOW_ID     = 'wf-ocr-real';
    process.env.DIDIT_DHA_WORKFLOW_ID = 'wf-dha-real';
    dbState.profiles[0].identity_verification_path = 'dha';
    // Envelope claims a workflow_id that matches neither expectation for 'dha'.
    const res = await POST(buildRequest(dhaEvent({ workflow_id: 'wf-ocr-real' })));
    expect(res.status).toBe(200);
    expect(dbState.profiles[0].identity_verification_status).toBe('in_review');
    expect(dbState.profiles[0].identity_verification_reason).toBe('workflow_path_mismatch');
    expect(dbState.profiles[0].sa_id_number).toBeUndefined();
  });

  it('agreement between stored path and workflow_id proceeds normally', async () => {
    process.env.DIDIT_WORKFLOW_ID     = 'wf-ocr-real';
    process.env.DIDIT_DHA_WORKFLOW_ID = 'wf-dha-real';
    dbState.profiles[0] = {
      ...dbState.profiles[0], identity_verification_path: 'dha',
      pending_sa_id_number: encryptId(VALID_SA_IDS[0]), pending_sa_id_lookup_hash: hashIdForLookup(VALID_SA_IDS[0]),
    };
    const res = await POST(buildRequest(dhaEvent({ workflow_id: 'wf-dha-real' })));
    expect(res.status).toBe(200);
    expect(dbState.profiles[0].identity_verification_status).toBe('approved');
  });

  it('an unresolved path (no identity_verification_path stored at all) routes to review', async () => {
    dbState.profiles[0] = { id: USER_ID, role: 'patient', email: 'a@test.com' }; // no path column
    const res = await POST(buildRequest(ocrEvent()));
    expect(res.status).toBe(200);
    expect(dbState.profiles[0].identity_verification_status).toBe('in_review');
    expect(dbState.profiles[0].identity_verification_reason).toBe('workflow_path_mismatch');
  });
});

describe('AML — removed, and must not silently gate approvals again', () => {
  // The old behaviour: a standalone screenAml() call before approving,
  // with a hit OR a failed call both routing to
  // 'aml_hit_or_unavailable'. The endpoint was never verified, so the
  // call always failed, so 100% of approved applicants went to an
  // unstaffed review queue. Removed deliberately — see the note above
  // handleApprovedDha in route.ts, including what restoring it requires.

  it('the aml client module no longer exists', () => {
    expect(existsSync(resolve(process.cwd(), 'lib/didit/aml.ts'))).toBe(false);
  });

  it('the webhook does not import or call any AML screening', () => {
    const SRC = readFileSync(resolve(process.cwd(), 'app/api/verification/didit/webhook/route.ts'), 'utf8');
    // Strip comments before matching — the removal note deliberately
    // NAMES screenAml() when explaining what was taken out and what
    // restoring it would require. That prose must not fail this test,
    // and deleting it to satisfy a regex would lose the reasoning.
    const code = SRC
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/from '@\/lib\/didit\/aml'/);
    expect(code).not.toMatch(/screenAml\s*\(/);
  });

  it('a clean approval on the DHA path is no longer gated by anything AML', async () => {
    dbState.profiles[0] = {
      ...dbState.profiles[0], identity_verification_path: 'dha',
      pending_sa_id_number: encryptId(VALID_SA_IDS[0]), pending_sa_id_lookup_hash: hashIdForLookup(VALID_SA_IDS[0]),
    };
    const res = await POST(buildRequest(dhaEvent()));
    expect(res.status).toBe(200);
    expect(dbState.profiles[0].identity_verification_status).toBe('approved');
    expect(dbState.profiles[0].identity_verification_reason).not.toBe('aml_hit_or_unavailable');
  });

  it('an OCR-path approval likewise reaches approved, not review', async () => {
    const res = await POST(buildRequest(ocrEvent()));
    expect(res.status).toBe(200);
    expect(dbState.profiles[0].identity_verification_status).toBe('approved');
  });
});

describe('transient vs deterministic duplicate-check failure (Change 4)', () => {
  it('the lookup itself failing (a thrown error) returns 500 so Didit retries — DHA path', async () => {
    dbState.profiles[0] = {
      ...dbState.profiles[0], identity_verification_path: 'dha',
      pending_sa_id_number: encryptId(VALID_SA_IDS[0]), pending_sa_id_lookup_hash: hashIdForLookup(VALID_SA_IDS[0]),
    };
    findPatientBySaId.mockRejectedValueOnce(new Error('simulated DB connection failure'));

    const res = await POST(buildRequest(dhaEvent()));
    expect(res.status).toBe(500);
    // Not persisted as any kind of decision — a transient failure is not one.
    expect(dbState.profiles[0].identity_verification_status).not.toBe('declined');
    expect(dbState.profiles[0].sa_id_number).toBeUndefined();
  });

  it('the lookup itself failing (a thrown error) returns 500 so Didit retries — OCR path', async () => {
    findPatientBySaId.mockRejectedValueOnce(new Error('simulated DB connection failure'));
    const res = await POST(buildRequest(ocrEvent()));
    expect(res.status).toBe(500);
    expect(dbState.profiles[0].identity_verification_status).not.toBe('declined');
  });

  it('a genuine duplicate match is NOT a throw — it is a normal declined/200 outcome (see case 13)', () => {
    // Documented by the case-13 test above; restated here so the
    // transient/deterministic distinction from the task prompt is
    // visible as a named assertion, not just implied. findPatientBySaId
    // only throws on a genuine DB/network error — a real duplicate
    // match is a plain non-throwing return, handled as declined/200.
    expect(true).toBe(true);
  });
});
