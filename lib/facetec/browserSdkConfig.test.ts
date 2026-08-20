import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...originalEnv };
});

async function load() {
  return import('./browserSdkConfig');
}

describe('getFaceTecBrowserSdkConfig', () => {
  it('returns the device key identifier when the env var is set', async () => {
    process.env.FACETEC_DEVICE_KEY_IDENTIFIER = 'device-key';

    const { getFaceTecBrowserSdkConfig } = await load();
    expect(getFaceTecBrowserSdkConfig()).toEqual({
      ok:   true,
      data: { deviceKeyIdentifier: 'device-key' },
    });
  });

  it('is a documented no-op when FACETEC_DEVICE_KEY_IDENTIFIER is missing', async () => {
    delete process.env.FACETEC_DEVICE_KEY_IDENTIFIER;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { getFaceTecBrowserSdkConfig } = await load();
    const result = getFaceTecBrowserSdkConfig();
    expect(result).toEqual({ ok: false, error: 'facetec_not_configured' });
    expect(warn).toHaveBeenCalled();
  });
});
