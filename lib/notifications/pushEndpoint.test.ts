import { describe, expect, it } from 'vitest';
import { isAllowedPushEndpoint } from './pushEndpoint';

describe('isAllowedPushEndpoint', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QH123',
    'https://wns2-db5p.notify.windows.com/w/?token=abc',
    'https://fcm.googleapis.com:443/fcm/send/abc',
  ])('accepts a known browser push service: %s', (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(true);
  });

  it.each([
    'not a URL',
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://user:pass@fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com:8443/fcm/send/abc',
    'https://127.0.0.1/internal',
    'https://[::1]/internal',
    'https://10.0.0.1/internal',
    'https://169.254.169.254/latest/meta-data',
    'https://evil.example/relay',
    'https://fcm.googleapis.com.evil.example/fcm/send/abc',
    'https://notify.windows.com.evil.example/w/abc',
  ])('rejects an untrusted destination: %s', (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(false);
  });
});
