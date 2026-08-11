import { describe, it, expect } from 'vitest';
import { describeDevice } from './deviceModel';

// Real User-Agent strings (trimmed) for the devices a ZA reception is
// most likely to register.
const UA = {
  galaxyS23:  'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  galaxyS23wv:'Mozilla/5.0 (Linux; Android 13; SM-S911B Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36',
  pixel7:     'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36',
  reducedK:   'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  iphone:     'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Mobile/15E148 Safari/604.1',
  ipad:       'Mozilla/5.0 (iPad; CPU OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/604.1',
  windows:    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  mac:        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  chromebook: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

describe('describeDevice', () => {
  it('names the Samsung Galaxy S23 by its model (the reported device)', () => {
    // SM-S911B is the S23's model code — exactly what the user expected to see.
    expect(describeDevice(UA.galaxyS23)).toBe('Samsung SM-S911B (Android 13)');
  });

  it('strips the Build/… suffix on the WebView form of the same device', () => {
    expect(describeDevice(UA.galaxyS23wv)).toBe('Samsung SM-S911B (Android 13)');
  });

  it('names a Pixel (no Samsung prefix)', () => {
    expect(describeDevice(UA.pixel7)).toBe('Pixel 7 (Android 14)');
  });

  it('degrades gracefully when the UA is frozen to model "K"', () => {
    expect(describeDevice(UA.reducedK)).toBe('Android device (Android 10)');
  });

  it('recognises Apple + desktop platforms', () => {
    expect(describeDevice(UA.iphone)).toBe('iPhone');
    expect(describeDevice(UA.ipad)).toBe('iPad');
    expect(describeDevice(UA.windows)).toBe('Windows PC');
    expect(describeDevice(UA.mac)).toBe('Mac');
    expect(describeDevice(UA.chromebook)).toBe('Chromebook');
  });

  it('returns "Unknown device" for null / blank / unrecognised input, never throws', () => {
    expect(describeDevice(null)).toBe('Unknown device');
    expect(describeDevice(undefined)).toBe('Unknown device');
    expect(describeDevice('')).toBe('Unknown device');
    expect(describeDevice('   ')).toBe('Unknown device');
    expect(describeDevice('curl/8.4.0')).toBe('Unknown device');
  });
});
