import { describe, it, expect } from 'vitest';
import { routeFromDhaOutcome, type RouteDecision } from './dhaVerification';
import type { DhaLookupOutcome } from '@/lib/didit/dha';

// ─── DHA routing table — pure decision logic ────────────────────────────
//
// routeFromDhaOutcome takes a transport-layer outcome + the ID we
// submitted and decides the route. No I/O — every case here is
// synchronous. The single invariant every "adversarial" case guards:
// the OCR fallback triggers ONLY on the DHA service failing to answer,
// never on it answering "not a match".

const SUBMITTED_ID = '9001015800088';

function success(overrides: {
  outcome_code?: string;
  source_data?: Record<string, unknown>;
  service_id?: string;
  request_id?: string;
}): DhaLookupOutcome {
  return {
    kind: 'success',
    data: {
      request_id: overrides.request_id ?? 'req-1',
      database_validation: {
        status:     'Approved',
        match_type: 'full_match',
        validations: [
          {
            service_id:   overrides.service_id ?? 'zaf_dha_photo',
            outcome_code: overrides.outcome_code,
            source_data:  overrides.source_data,
          },
        ],
      },
    },
  };
}

const MATCH_ROW_BASE = {
  identification_number: SUBMITTED_ID,
  id_blocked:             false,
  deceased:                false,
  on_national_population_register: true,
  photo_base64:            'ZmFrZS1kaGEtcGhvdG8=',
  first_name:              'Jane',
  last_name:               'Doe',
};

describe('routing correctness — cases 1-8', () => {
  it('1. no_match_does_not_fall_back', () => {
    const route = routeFromDhaOutcome(success({ outcome_code: 'NO_MATCH' }), SUBMITTED_ID);
    expect(route).toEqual({ kind: 'reject', reason: 'dha_no_match' });
  });

  it('2. document_not_found_does_not_fall_back', () => {
    const route = routeFromDhaOutcome(success({ outcome_code: 'DOCUMENT_NOT_FOUND' }), SUBMITTED_ID);
    expect(route).toEqual({ kind: 'reject', reason: 'dha_document_not_found' });
  });

  it('3. registry_unavailable_outcome_code_falls_back', () => {
    const route = routeFromDhaOutcome(success({ outcome_code: 'REGISTRY_UNAVAILABLE' }), SUBMITTED_ID);
    expect(route.kind).toBe('ocr_fallback');
  });

  it('4. transport_unavailable_falls_back (timeout/connection error at the outcome layer)', () => {
    const route = routeFromDhaOutcome({ kind: 'unavailable', detail: 'timeout' }, SUBMITTED_ID);
    expect(route.kind).toBe('ocr_fallback');
  });

  it('5. transport_5xx_falls_back (HTTP 500 at the outcome layer)', () => {
    const route = routeFromDhaOutcome({ kind: 'unavailable', detail: 'HTTP 500: boom' }, SUBMITTED_ID);
    expect(route.kind).toBe('ocr_fallback');
  });

  it('6. match_with_biometric_image_unusable_falls_back', () => {
    const route = routeFromDhaOutcome(success({ outcome_code: 'BIOMETRIC_IMAGE_UNUSABLE' }), SUBMITTED_ID);
    expect(route.kind).toBe('ocr_fallback');
  });

  it('7. match_with_empty_photo_falls_back_not_crash', () => {
    const route = routeFromDhaOutcome(
      success({ outcome_code: 'MATCH', source_data: { ...MATCH_ROW_BASE, photo_base64: '' } }),
      SUBMITTED_ID,
    );
    expect(route.kind).toBe('ocr_fallback');
  });

  it('8. unrecognised_outcome_code_routes_to_review_not_fallback', () => {
    const route = routeFromDhaOutcome(success({ outcome_code: 'SOMETHING_NEW_DIDIT_ADDED' }), SUBMITTED_ID);
    expect(route).toEqual({ kind: 'review', reason: 'dha_unrecognised_outcome' });
  });

  it('unrecognised outcome also covers a missing validations row entirely', () => {
    const outcome: DhaLookupOutcome = {
      kind: 'success',
      data: { request_id: 'req-1', database_validation: { validations: [] } },
    };
    const route = routeFromDhaOutcome(outcome, SUBMITTED_ID);
    expect(route).toEqual({ kind: 'review', reason: 'dha_unrecognised_outcome' });
  });
});

describe('adversarial — cases 9-12', () => {
  it('9. no_match_with_photo_present_still_rejects (guards against if(photo) useDhaPath())', () => {
    const route = routeFromDhaOutcome(
      success({ outcome_code: 'NO_MATCH', source_data: { ...MATCH_ROW_BASE } }),
      SUBMITTED_ID,
    );
    expect(route).toEqual({ kind: 'reject', reason: 'dha_no_match' });
  });

  it('10a. deceased_string_false_is_not_truthy', () => {
    const route = routeFromDhaOutcome(
      success({ outcome_code: 'MATCH', source_data: { ...MATCH_ROW_BASE, deceased: 'false' } }),
      SUBMITTED_ID,
    );
    // 'false' the string must NOT be treated as deceased=true.
    expect(route.kind).not.toBe('reject');
  });

  it('10b. deceased_boolean_false_is_not_truthy', () => {
    const route = routeFromDhaOutcome(
      success({ outcome_code: 'MATCH', source_data: { ...MATCH_ROW_BASE, deceased: false } }),
      SUBMITTED_ID,
    );
    expect(route.kind).not.toBe('reject');
  });

  it('10c. deceased_string_true_and_boolean_true_are_both_treated_as_deceased', () => {
    const routeString = routeFromDhaOutcome(
      success({ outcome_code: 'MATCH', source_data: { ...MATCH_ROW_BASE, deceased: 'true' } }),
      SUBMITTED_ID,
    );
    const routeBool = routeFromDhaOutcome(
      success({ outcome_code: 'MATCH', source_data: { ...MATCH_ROW_BASE, deceased: true } }),
      SUBMITTED_ID,
    );
    expect(routeString).toEqual({ kind: 'reject', reason: 'dha_deceased' });
    expect(routeBool).toEqual({ kind: 'reject', reason: 'dha_deceased' });
  });

  it('11. id_blocked_true_with_match_and_valid_photo_rejects', () => {
    const route = routeFromDhaOutcome(
      success({ outcome_code: 'MATCH', source_data: { ...MATCH_ROW_BASE, id_blocked: true } }),
      SUBMITTED_ID,
    );
    expect(route).toEqual({ kind: 'reject', reason: 'dha_id_blocked' });
  });

  it('12. echoed_id_differs_from_submitted_rejects_does_not_trust_registry_value', () => {
    const route = routeFromDhaOutcome(
      success({ outcome_code: 'MATCH', source_data: { ...MATCH_ROW_BASE, identification_number: '8506155001082' } }),
      SUBMITTED_ID,
    );
    expect(route).toEqual({ kind: 'reject', reason: 'dha_id_mismatch' });
  });

  it('12b. missing echoed id is treated the same as a mismatch (reject, not review)', () => {
    const { identification_number: _drop, ...withoutId } = MATCH_ROW_BASE;
    void _drop;
    const route = routeFromDhaOutcome(
      success({ outcome_code: 'MATCH', source_data: withoutId }),
      SUBMITTED_ID,
    );
    expect(route).toEqual({ kind: 'reject', reason: 'dha_id_mismatch' });
  });
});

describe('unrecognised-by-default — a flag PRESENT but in an unknown vocabulary routes to review, never the safe value', () => {
  // The flag vocabulary is unverified (see lib/didit/dha.ts). Didit's own
  // sample response types `deceased` as a string, so 'Y'/'N' is plausible.
  // A parser that defaults unrecognised input to false would approve a
  // deceased or blocked ID — these cases pin that shut.

  it('deceased: "Y" routes to review, does NOT approve', () => {
    const route = routeFromDhaOutcome(
      success({ outcome_code: 'MATCH', source_data: { ...MATCH_ROW_BASE, deceased: 'Y' } }),
      SUBMITTED_ID,
    );
    expect(route).toEqual({ kind: 'review', reason: 'dha_unrecognised_outcome' });
    expect(route.kind).not.toBe('dha');
  });

  it('id_blocked: "Y" routes to review, does NOT approve', () => {
    const route = routeFromDhaOutcome(
      success({ outcome_code: 'MATCH', source_data: { ...MATCH_ROW_BASE, id_blocked: 'Y' } }),
      SUBMITTED_ID,
    );
    expect(route).toEqual({ kind: 'review', reason: 'dha_unrecognised_outcome' });
    expect(route.kind).not.toBe('dha');
  });

  it('on_national_population_register: "N" routes to review, does NOT approve', () => {
    const route = routeFromDhaOutcome(
      success({
        outcome_code: 'MATCH',
        source_data: { ...MATCH_ROW_BASE, on_national_population_register: 'N' },
      }),
      SUBMITTED_ID,
    );
    expect(route).toEqual({ kind: 'review', reason: 'dha_unrecognised_outcome' });
    expect(route.kind).not.toBe('dha');
  });

  it('an arbitrary unrecognised value on any critical flag never reaches the dha route', () => {
    for (const field of ['deceased', 'id_blocked', 'on_national_population_register'] as const) {
      for (const value of ['sample_value', 'UNKNOWN', '', '  ', 'maybe', NaN, {}]) {
        const route = routeFromDhaOutcome(
          success({ outcome_code: 'MATCH', source_data: { ...MATCH_ROW_BASE, [field]: value } }),
          SUBMITTED_ID,
        );
        expect(route.kind, `${field}=${String(value)}`).toBe('review');
      }
    }
  });
});

describe('absent-by-default — every DHA signal missing a field routes to review, never the safe value', () => {
  it('missing id_blocked routes to review', () => {
    const { id_blocked: _drop, ...rest } = MATCH_ROW_BASE;
    void _drop;
    const route = routeFromDhaOutcome(success({ outcome_code: 'MATCH', source_data: rest }), SUBMITTED_ID);
    expect(route).toEqual({ kind: 'review', reason: 'dha_unrecognised_outcome' });
  });

  it('missing deceased routes to review', () => {
    const { deceased: _drop, ...rest } = MATCH_ROW_BASE;
    void _drop;
    const route = routeFromDhaOutcome(success({ outcome_code: 'MATCH', source_data: rest }), SUBMITTED_ID);
    expect(route).toEqual({ kind: 'review', reason: 'dha_unrecognised_outcome' });
  });

  it('missing on_national_population_register routes to review (dha_not_on_register)', () => {
    const { on_national_population_register: _drop, ...rest } = MATCH_ROW_BASE;
    void _drop;
    const route = routeFromDhaOutcome(success({ outcome_code: 'MATCH', source_data: rest }), SUBMITTED_ID);
    expect(route).toEqual({ kind: 'review', reason: 'dha_not_on_register' });
  });

  it('on_national_population_register explicitly false routes to review', () => {
    const route = routeFromDhaOutcome(
      success({ outcome_code: 'MATCH', source_data: { ...MATCH_ROW_BASE, on_national_population_register: false } }),
      SUBMITTED_ID,
    );
    expect(route).toEqual({ kind: 'review', reason: 'dha_not_on_register' });
  });
});

describe('transport-layer request_error never falls back and never approves', () => {
  it('routes to a distinct "error" kind, not reject/review/ocr_fallback/dha', () => {
    const route: RouteDecision = routeFromDhaOutcome(
      { kind: 'request_error', status: 400, detail: 'bad field name' },
      SUBMITTED_ID,
    );
    expect(route.kind).toBe('error');
  });
});

describe('the DHA route on a clean MATCH', () => {
  it('carries the photo + registry name through', () => {
    const route = routeFromDhaOutcome(success({ outcome_code: 'MATCH', source_data: MATCH_ROW_BASE }), SUBMITTED_ID);
    expect(route).toMatchObject({
      kind: 'dha',
      photoBase64: MATCH_ROW_BASE.photo_base64,
      dhaFirstName: 'Jane',
      dhaLastName: 'Doe',
    });
  });
});

describe('response envelope — validations live under database_validation, not top level', () => {
  // Regression: an earlier draft read outcome.data.validations directly.
  // Against the real API that finds nothing, so EVERY lookup — including
  // clean approvals — routed to the (unstaffed) review queue. Verified
  // against live on 2026-08-24. Sandbox returns a different shape and
  // must not be used to develop this endpoint.

  it('a MATCH nested correctly under database_validation reaches the dha route', () => {
    const route = routeFromDhaOutcome(
      {
        kind: 'success',
        data: {
          request_id: 'req-live',
          database_validation: {
            status: 'Approved',
            match_type: 'full_match',
            validations: [
              { service_id: 'zaf_dha_photo', outcome_code: 'MATCH', source_data: { ...MATCH_ROW_BASE } },
            ],
          },
        },
      },
      SUBMITTED_ID,
    );
    expect(route.kind).toBe('dha');
  });

  it('the same payload placed at the TOP level is not read (guards the old bug)', () => {
    const route = routeFromDhaOutcome(
      {
        kind: 'success',
        // Deliberately the old, wrong shape — cast because the corrected
        // type no longer permits it, which is itself the point.
        data: {
          request_id: 'req-old',
          validations: [
            { service_id: 'zaf_dha_photo', outcome_code: 'MATCH', source_data: { ...MATCH_ROW_BASE } },
          ],
        } as unknown as import('@/lib/didit/types').DhaLookupResponse,
      },
      SUBMITTED_ID,
    );
    // Must not crash, and must not approve — review is the safe answer.
    expect(route).toEqual({ kind: 'review', reason: 'dha_unrecognised_outcome' });
  });

  it('real live source_data flags are plain booleans — parseFlag never sees unknown', () => {
    const liveSourceData = {
      deceased: false,
      last_name: 'LEIBOFF',
      first_name: 'JESS NATHAN',
      id_blocked: false,
      photo_base64: 'ZmFrZQ==',
      marital_status: 'MARRIED',
      smart_card_issued: true,
      identification_number: SUBMITTED_ID,
      on_hanis_biometric_register: true,
      on_national_population_register: true,
    };
    const route = routeFromDhaOutcome(
      success({ outcome_code: 'MATCH', source_data: liveSourceData }),
      SUBMITTED_ID,
    );
    expect(route).toMatchObject({ kind: 'dha', dhaFirstName: 'JESS NATHAN', dhaLastName: 'LEIBOFF' });
  });
});
