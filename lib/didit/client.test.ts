import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Didit session client — portrait_image safety on the DHA path ──────
//
// The DHA path's entire security property is that portrait_image is
// ALWAYS the DHA registry photo. Didit resolves a stored fallback face
// (including one cropped from an OCR-path document) when portrait_image
// is omitted, so omitting it is not a graceful degradation — it's a
// silent downgrade to a check we never actually ran. These two tests are
// the load-bearing ones for that invariant; everything else here is
// supporting coverage.

const originalFetch = global.fetch;

beforeEach(() => {
  process.env.DIDIT_API_KEY         = 'test-api-key';
  process.env.DIDIT_WORKFLOW_ID     = 'wf-ocr-fallback';
  process.env.DIDIT_DHA_WORKFLOW_ID = 'wf-dha';
  delete process.env.DHA_PORTRAIT_MAX_BYTES;
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('createDhaFaceMatchSession — dha_path_never_creates_session_without_portrait_image', () => {
  it('throws locally and issues NO HTTP request when portraitImageBase64 is missing', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const { createDhaFaceMatchSession } = await import('./client');

    await expect(createDhaFaceMatchSession({
      vendorData: 'user-1',
      callback:   'https://app.test/onboarding/identity',
      portraitImageBase64: '',
    })).rejects.toThrow(/portraitImageBase64 is required/);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws locally and issues NO HTTP request when portraitImageBase64 is undefined-like via a stripped object', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const { createDhaFaceMatchSession } = await import('./client');

    const input = { vendorData: 'user-1', callback: 'https://app.test/onboarding/identity' } as never;
    await expect(createDhaFaceMatchSession(input)).rejects.toThrow(/portraitImageBase64 is required/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('createDhaFaceMatchSession — dha_path_does_not_reuse_stored_face', () => {
  it('always sends portrait_image in the request body, even for a vendor with prior approved sessions', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      session_id: 's1', session_number: 1, session_token: 'tok', url: 'https://verify.didit.me/session/tok',
      vendor_data: 'returning-user', metadata: null, status: 'Not Started',
      workflow_id: 'wf-dha', workflow_version: 1, callback: 'https://app.test/onboarding/identity',
    }), { status: 201 }));
    global.fetch = fetchSpy as unknown as typeof fetch;
    const { createDhaFaceMatchSession } = await import('./client');

    // "returning-user" simulates a vendor_data that already has an
    // approved OCR-path session (and therefore a stored document-crop
    // face) on Didit's side — nothing in THIS call's inputs signals
    // that, which is the point: the function has no branch that could
    // omit portrait_image based on the caller's history.
    await createDhaFaceMatchSession({
      vendorData: 'returning-user',
      callback:   'https://app.test/onboarding/identity',
      portraitImageBase64: 'ZmFrZS1kaGEtcGhvdG8=',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.portrait_image).toBe('ZmFrZS1kaGEtcGhvdG8=');
    expect(body.workflow_id).toBe('wf-dha');
  });

  it('rejects an oversized portrait before making any HTTP call', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const { createDhaFaceMatchSession } = await import('./client');

    process.env.DHA_PORTRAIT_MAX_BYTES = '10';
    const oversized = 'A'.repeat(1000);
    await expect(createDhaFaceMatchSession({
      vendorData: 'user-1',
      callback:   'https://app.test/onboarding/identity',
      portraitImageBase64: oversized,
    })).rejects.toThrow(/exceeds DHA_PORTRAIT_MAX_BYTES/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('createDiditSession — OCR fallback path is unchanged', () => {
  it('does not send portrait_image when none is supplied', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      session_id: 's1', session_number: 1, session_token: 'tok', url: 'https://verify.didit.me/session/tok',
      vendor_data: 'user-1', metadata: null, status: 'Not Started',
      workflow_id: 'wf-ocr-fallback', workflow_version: 1, callback: 'https://app.test/onboarding/identity',
    }), { status: 201 }));
    global.fetch = fetchSpy as unknown as typeof fetch;
    const { createDiditSession } = await import('./client');

    await createDiditSession({ vendorData: 'user-1', callback: 'https://app.test/onboarding/identity' });

    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.portrait_image).toBeUndefined();
    expect(body.workflow_id).toBe('wf-ocr-fallback');
  });
});
