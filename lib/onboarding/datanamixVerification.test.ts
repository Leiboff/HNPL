import { describe, it, expect } from 'vitest';
import { routeFromDatanamixOutcome } from './datanamixVerification';
import type { DatanamixLookupOutcome } from '@/lib/datanamix/client';
import type { DatanamixProfilePlusResponse } from '@/lib/datanamix/types';

const SUBMITTED_ID = '8402181202086';

/**
 * Verbatim from the live Datanamix sandbox on 2026-08-25, with the
 * 2.53M-char portrait replaced by a short stand-in. Using the real
 * payload rather than the OpenAPI examples is deliberate — Didit's
 * sandbox returned a response shaped nothing like its own docs, so
 * fixtures here are copied from observed traffic only.
 */
const LIVE_IDV = {
  IDNumber:             SUBMITTED_ID,
  IDNumberMatchStatus:  'Matched',
  Names:                'Amelia',
  Surname:              'Naidoo',
  Gender:               'Female',
  DateOfBirth:          '1984-02-18',
  BirthPlace:           'SOUTH AFRICA',
  DeceasedStatus:       'Alive',
  DeceasedDate:         '',
  MarriageStatus:       'Married',
  MarriageDate:         '2012-05-20',
  IDBookIssuedDate:     '',
  IDCardIndicator:      'Yes',
  IDCardDate:           '2018-04-12',
  IDSequenceNumber:     '1202',
  IDNumberBlocked:      'NO',
  OfflineIndicator:     'Yes',
  LastUpdatedIndicator: '1',
  LastUpdated:          'Less than 30 days',
};

const LIVE_BIO = {
  HasImage:     'True',
  HanisIDMatch: 'Matched',
  ImageBase64:  'ZmFrZS1wb3J0cmFpdA==',
};

function ok(
  overrides: {
    idv?: Record<string, unknown>;
    bio?: Record<string, unknown>;
    responseCode?: number;
  } = {},
): DatanamixLookupOutcome {
  const data: DatanamixProfilePlusResponse = {
    Header: { ReportReference: 'DX-SANDBOX-318003' },
    Result: {
      IDVerificationResults:        { ...LIVE_IDV, ...(overrides.idv ?? {}) },
      BiometricVerificationResults: { ...LIVE_BIO, ...(overrides.bio ?? {}) },
    },
    Success:      true,
    Messages:     ['Sandbox data'],
    ResponseCode: overrides.responseCode ?? 0,
  };
  return { kind: 'success', data, httpStatus: 200 };
}

describe('the happy path on the real observed payload', () => {
  it('a clean bureau match reaches the dha route with names carried through', () => {
    const route = routeFromDatanamixOutcome(ok(), SUBMITTED_ID);
    expect(route).toMatchObject({
      kind:         'dha',
      dhaFirstName: 'Amelia',
      dhaLastName:  'Naidoo',
      outcomeCode:  'DNX_MATCH',
      requestId:    'DX-SANDBOX-318003',
    });
  });
});

describe('envelope routing — ResponseCode only, never HTTP status', () => {
  it('4 (not found) DECLINES, does not fall back', () => {
    // The whole point of the invariant: a fabricated ID must not be able
    // to route around the registry into the weaker document path.
    const outcome: DatanamixLookupOutcome = {
      kind: 'success',
      data: { Success: false, ResponseCode: 4, Messages: ['No record found'] },
      httpStatus: 404,
    };
    expect(routeFromDatanamixOutcome(outcome, SUBMITTED_ID)).toEqual({
      kind: 'reject', reason: 'dnx_not_found',
    });
  });

  it('a 404 HTTP status does not by itself decline — ResponseCode decides', () => {
    // Their 404 also means "product not activated on your account". If we
    // routed on status, switching the product off would silently decline
    // every applicant instead of alerting us.
    const outcome: DatanamixLookupOutcome = {
      kind: 'success',
      data: { Success: false, ResponseCode: 403, Messages: ['Forbidden'] },
      httpStatus: 404,
    };
    expect(routeFromDatanamixOutcome(outcome, SUBMITTED_ID).kind).toBe('error');
  });

  it('5 (timeout) and 7 (internal error) fall back — the bureau failed to answer', () => {
    for (const code of [5, 7]) {
      const outcome: DatanamixLookupOutcome = {
        kind: 'success', data: { ResponseCode: code }, httpStatus: 200,
      };
      expect(routeFromDatanamixOutcome(outcome, SUBMITTED_ID)).toEqual({
        kind: 'ocr_fallback', reason: 'registry_unavailable',
      });
    }
  });

  it('6 (validation error) DECLINES rather than erroring', () => {
    // Diverges from the Didit path, where any 4xx meant our own bug.
    // Here it is a statement about the applicant's ID.
    const outcome: DatanamixLookupOutcome = {
      kind: 'success',
      data: { ResponseCode: 6, Messages: ['Invalid RSA ID Number'] },
      httpStatus: 400,
    };
    expect(routeFromDatanamixOutcome(outcome, SUBMITTED_ID)).toEqual({
      kind: 'reject', reason: 'invalid_id',
    });
  });

  it('8 (minor) declines', () => {
    const outcome: DatanamixLookupOutcome = {
      kind: 'success', data: { ResponseCode: 8 }, httpStatus: 200,
    };
    expect(routeFromDatanamixOutcome(outcome, SUBMITTED_ID)).toEqual({
      kind: 'reject', reason: 'underage',
    });
  });

  it('an undocumented ResponseCode reviews — never falls back, never approves', () => {
    for (const code of [1, 2, 99, -1]) {
      const outcome: DatanamixLookupOutcome = {
        kind: 'success', data: { ResponseCode: code }, httpStatus: 200,
      };
      expect(routeFromDatanamixOutcome(outcome, SUBMITTED_ID)).toEqual({
        kind: 'review', reason: 'dnx_unrecognised_outcome',
      });
    }
  });
});

describe('string vocabulary — the values parseFlag alone cannot read', () => {
  it('"Alive" is not deceased; "Deceased" rejects', () => {
    expect(routeFromDatanamixOutcome(ok({ idv: { DeceasedStatus: 'Alive' } }), SUBMITTED_ID).kind)
      .toBe('dha');
    expect(routeFromDatanamixOutcome(ok({ idv: { DeceasedStatus: 'Deceased' } }), SUBMITTED_ID))
      .toEqual({ kind: 'reject', reason: 'dnx_deceased' });
  });

  it('uppercase "NO" is not blocked; "YES" rejects', () => {
    expect(routeFromDatanamixOutcome(ok({ idv: { IDNumberBlocked: 'NO' } }), SUBMITTED_ID).kind)
      .toBe('dha');
    expect(routeFromDatanamixOutcome(ok({ idv: { IDNumberBlocked: 'YES' } }), SUBMITTED_ID))
      .toEqual({ kind: 'reject', reason: 'dnx_id_blocked' });
  });

  it('an unrecognised value on ANY critical string field reviews, never approves', () => {
    const fields = ['DeceasedStatus', 'IDNumberBlocked', 'IDNumberMatchStatus'] as const;
    const junk = ['UNKNOWN', 'sample_value', '', '  ', 'Y', 'N', 'Pending'];
    for (const field of fields) {
      for (const value of junk) {
        const route = routeFromDatanamixOutcome(ok({ idv: { [field]: value } }), SUBMITTED_ID);
        expect(route.kind, `${field}=${JSON.stringify(value)}`).not.toBe('dha');
        expect(route.kind, `${field}=${JSON.stringify(value)}`).toBe('review');
      }
    }
  });

  it('a MISSING critical field reviews — absent never gets the safe reading', () => {
    for (const field of ['DeceasedStatus', 'IDNumberBlocked', 'IDNumberMatchStatus'] as const) {
      const idv: Record<string, unknown> = { ...LIVE_IDV };
      delete idv[field];
      const outcome: DatanamixLookupOutcome = {
        kind: 'success',
        data: {
          Header: { ReportReference: 'r' },
          Result: { IDVerificationResults: idv, BiometricVerificationResults: { ...LIVE_BIO } },
          ResponseCode: 0,
        },
        httpStatus: 200,
      };
      expect(routeFromDatanamixOutcome(outcome, SUBMITTED_ID).kind, field).toBe('review');
    }
  });

  it('IDNumberMatchStatus "Not Matched" DECLINES', () => {
    expect(routeFromDatanamixOutcome(ok({ idv: { IDNumberMatchStatus: 'Not Matched' } }), SUBMITTED_ID))
      .toEqual({ kind: 'reject', reason: 'dnx_no_match' });
  });
});

describe('identity binding — the bureau must have matched OUR id', () => {
  it('a different echoed IDNumber rejects', () => {
    expect(routeFromDatanamixOutcome(ok({ idv: { IDNumber: '9001015800088' } }), SUBMITTED_ID))
      .toEqual({ kind: 'reject', reason: 'dnx_id_mismatch' });
  });

  it('an absent echoed IDNumber rejects, same as a mismatch', () => {
    const idv: Record<string, unknown> = { ...LIVE_IDV };
    delete idv.IDNumber;
    const outcome: DatanamixLookupOutcome = {
      kind: 'success',
      data: {
        Result: { IDVerificationResults: idv, BiometricVerificationResults: { ...LIVE_BIO } },
        ResponseCode: 0,
      },
      httpStatus: 200,
    };
    expect(routeFromDatanamixOutcome(outcome, SUBMITTED_ID))
      .toEqual({ kind: 'reject', reason: 'dnx_id_mismatch' });
  });

  it('whitespace in the submitted id does not cause a false mismatch', () => {
    expect(routeFromDatanamixOutcome(ok(), ' 8402181202086 ').kind).toBe('dha');
  });
});

describe('biometric provenance and availability', () => {
  it('HanisIDMatch "Not Matched" reviews — portrait provenance unproven', () => {
    expect(routeFromDatanamixOutcome(ok({ bio: { HanisIDMatch: 'Not Matched' } }), SUBMITTED_ID))
      .toEqual({ kind: 'review', reason: 'dnx_hanis_not_matched' });
  });

  it('HasImage "False" falls back — real person, no usable biometric', () => {
    expect(routeFromDatanamixOutcome(ok({ bio: { HasImage: 'False' } }), SUBMITTED_ID))
      .toEqual({ kind: 'ocr_fallback', reason: 'biometric_image_unusable' });
  });

  it('HasImage "True" but an empty ImageBase64 also falls back, not approves', () => {
    expect(routeFromDatanamixOutcome(ok({ bio: { ImageBase64: '' } }), SUBMITTED_ID))
      .toEqual({ kind: 'ocr_fallback', reason: 'biometric_image_unusable' });
  });

  it('a missing biometric block entirely reviews rather than approving', () => {
    const outcome: DatanamixLookupOutcome = {
      kind: 'success',
      data: { Result: { IDVerificationResults: { ...LIVE_IDV } }, ResponseCode: 0 },
      httpStatus: 200,
    };
    expect(routeFromDatanamixOutcome(outcome, SUBMITTED_ID).kind).toBe('review');
  });
});

describe('transport layer', () => {
  it('unavailable falls back', () => {
    expect(routeFromDatanamixOutcome(
      { kind: 'unavailable', detail: 'datanamix_transport: timeout' }, SUBMITTED_ID,
    )).toEqual({ kind: 'ocr_fallback', reason: 'registry_unavailable' });
  });

  it('request_error errors — never falls back, never approves', () => {
    const route = routeFromDatanamixOutcome(
      { kind: 'request_error', status: 401, detail: 'bad token' }, SUBMITTED_ID,
    );
    expect(route.kind).toBe('error');
    expect(['dha', 'ocr_fallback', 'reject', 'review']).not.toContain(route.kind);
  });

  it('a null Result with ResponseCode 0 reviews rather than crashing', () => {
    const outcome: DatanamixLookupOutcome = {
      kind: 'success', data: { Result: null, ResponseCode: 0 }, httpStatus: 200,
    };
    expect(routeFromDatanamixOutcome(outcome, SUBMITTED_ID))
      .toEqual({ kind: 'review', reason: 'dnx_unrecognised_outcome' });
  });
});
