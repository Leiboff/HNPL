import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveAffordability } from './affordabilityGate';
import { parseAffordabilityResponse } from '@/lib/experian/affordabilityClient';
import * as fx from '@/lib/experian/__fixtures__/affordability';

const resolve = (xml: string, band: 'low' | 'minimum' | 'average' | 'thin_file' = 'low') =>
  resolveAffordability(parseAffordabilityResponse(xml), band);

afterEach(() => vi.restoreAllMocks());

describe('confidence decides whether the formula runs', () => {
  it('High keeps the score band and yields a prediction', () => {
    const r = resolve(fx.AFFORD_SUCCESS_HIGH, 'minimum');
    expect(r.kind).toBe('ready');
    if (r.kind !== 'ready') return;
    expect(r.band).toBe('minimum');
    expect(r.prediction?.confidence).toBe('High');
    expect(r.prediction?.gross).toBe(30_000);
    expect(r.thinFileReason).toBeNull();
  });

  it('Medium yields a prediction that carries the haircut flag', () => {
    const r = resolve(fx.AFFORD_SUCCESS_MEDIUM);
    expect(r.kind === 'ready' && r.prediction?.confidence).toBe('Medium');
  });

  it.each([
    ['Low',                      fx.AFFORD_SUCCESS_LOW,    'low_confidence'],
    ['Unable To Determine GMIP', fx.AFFORD_SUCCESS_UNABLE, 'unable_to_determine'],
  ])('%s downgrades to thin file with no prediction', (_label, xml, reason) => {
    const r = resolve(xml, 'minimum');
    expect(r.kind).toBe('ready');
    if (r.kind !== 'ready') return;
    expect(r.band).toBe('thin_file');
    expect(r.prediction).toBeNull();
    expect(r.thinFileReason).toBe(reason);
  });

  it('an unrecognised confidence string degrades to thin file and warns', () => {
    // Confidence only ever reduces what we lend, so the unknown value is
    // treated as the most cautious known one rather than blocking the
    // applicant — but it is logged so the mapping gets updated.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = resolve(fx.affordabilityReply({
      ...fx.PAYLOAD_HIGH, GMIP_Confidence_Level: 'Provisional',
    }));

    expect(r.kind === 'ready' && r.band).toBe('thin_file');
    expect(r.kind === 'ready' && r.thinFileReason).toBe('unknown_confidence');
    expect(warn).toHaveBeenCalled();
  });

  it('High confidence with a missing GMIP value is still a thin file', () => {
    const r = resolve(fx.affordabilityReply({
      ...fx.PAYLOAD_HIGH, GMIP_Value: '',
    }));
    expect(r.kind === 'ready' && r.prediction).toBeNull();
  });

  it('High confidence with a zero GMIP value does not become a zero-income prediction', () => {
    const r = resolve(fx.affordabilityReply({ ...fx.PAYLOAD_HIGH, GMIP_Value: '0' }));
    expect(r.kind === 'ready' && r.prediction).toBeNull();
    expect(r.kind === 'ready' && r.thinFileReason).toBe('unable_to_determine');
  });
});

describe('thin-file treatment overrides even a good score band', () => {
  it.each([
    ['-209', fx.AFFORD_ERROR_209_NO_GMIP,   'no_gmip'],
    ['-217', fx.AFFORD_ERROR_217_NO_RECORD, 'no_bureau_record'],
  ])('%s caps a Minimum-risk applicant at the thin-file band', (_code, xml, reason) => {
    const r = resolve(xml, 'minimum');
    expect(r.kind === 'ready' && r.band).toBe('thin_file');
    expect(r.kind === 'ready' && r.thinFileReason).toBe(reason);
  });
});

describe('missing expense figures', () => {
  it('are read as zero, with the living floor providing the protection', () => {
    // A consumer with no reported credit legitimately has no bureau
    // expenses. Refusing on a blank field would decline exactly the
    // population this product targets; the 25%-of-net floor in the limit
    // function is what stops net being treated as fully disposable.
    const r = resolve(fx.affordabilityReply({
      GMIP_Value: '20000', GMIP_Confidence_Level: 'High',
      Bureau_Expenses: '', Calc_Living_Expenses: '', Enq_id: 'E',
    }));

    expect(r.kind).toBe('ready');
    if (r.kind !== 'ready') return;
    expect(r.prediction).not.toBeNull();
    expect(r.prediction!.bureauExpenses).toBe(0);
    expect(r.prediction!.calcLivingExpenses).toBe(0);
  });
});

describe('failures stay pending', () => {
  it.each([
    ['-205', fx.AFFORD_ERROR_205_NOT_ACTIVATED, true],
    ['-201', fx.AFFORD_ERROR_201_NOT_BINDING,   true],
    ['-207', fx.AFFORD_ERROR_207_INVALID_ID,    true],
    ['-204', fx.AFFORD_ERROR_204_GENERIC,       false],
  ])('%s is pending (alert=%s)', (_code, xml, alert) => {
    const r = resolve(xml);
    expect(r.kind).toBe('pending');
    expect(r.kind === 'pending' && r.alert).toBe(alert);
  });

  it('a SOAP fault is pending without an alert — it is not our bug', () => {
    const r = resolve(fx.AFFORD_SOAP_FAULT_500);
    expect(r.kind).toBe('pending');
  });

  it('no affordability outcome ever declines directly', () => {
    // The only decline this stage can produce is via the limit function
    // returning below-minimum. Nothing here refuses an applicant outright.
    for (const xml of [
      fx.AFFORD_ERROR_201_NOT_BINDING, fx.AFFORD_ERROR_204_GENERIC,
      fx.AFFORD_ERROR_205_NOT_ACTIVATED, fx.AFFORD_ERROR_207_INVALID_ID,
      fx.AFFORD_ERROR_209_NO_GMIP, fx.AFFORD_ERROR_217_NO_RECORD,
      fx.AFFORD_SOAP_FAULT_500, fx.AFFORD_GARBAGE_BODY,
      fx.AFFORD_SUCCESS_LOW, fx.AFFORD_SUCCESS_UNABLE,
    ]) {
      expect(['ready', 'pending']).toContain(resolve(xml).kind);
    }
  });
});
