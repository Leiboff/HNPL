import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkLiveness } from './livenessCheck';
import * as datanamixClient from '@/lib/facetec/datanamixClient';

// ─── checkLiveness — gates purely on postLiveness3d's verdict ──────────
//
// Mirrors the invariant the old stub's tests enforced (runLiveness gates
// on this module and nothing else) but now against a real provider call:
// any non-'pass' outcome — a genuine reject, a network failure, missing
// credentials — must surface as 'fail'. Never silently pass.

afterEach(() => { vi.restoreAllMocks(); });

const INPUT = {
  faceScan:                  'FACESCAN_B64',
  auditTrailImage:           'AUDIT_B64',
  lowQualityAuditTrailImage: 'LOWQ_B64',
  xUserAgent:                'device-sdk-ua-string',
};

describe('checkLiveness', () => {
  it('passes through Datanamix success:true as "pass"', async () => {
    vi.spyOn(datanamixClient, 'postLiveness3d').mockResolvedValue({ ok: true, success: true });
    expect(await checkLiveness(INPUT)).toBe('pass');
  });

  it('a genuine reject (success:false) is "fail"', async () => {
    vi.spyOn(datanamixClient, 'postLiveness3d').mockResolvedValue({ ok: true, success: false });
    expect(await checkLiveness(INPUT)).toBe('fail');
  });

  it('a provider/network failure is "fail", not a thrown error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(datanamixClient, 'postLiveness3d').mockResolvedValue({ ok: false, error: 'facetec_timeout' });
    expect(await checkLiveness(INPUT)).toBe('fail');
  });

  it('forwards the FaceScan payload and X-User-Agent unchanged', async () => {
    const spy = vi.spyOn(datanamixClient, 'postLiveness3d').mockResolvedValue({ ok: true, success: true });
    await checkLiveness(INPUT);
    expect(spy).toHaveBeenCalledWith(INPUT);
  });
});
