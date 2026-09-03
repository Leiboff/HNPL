import { describe, expect, it } from 'vitest';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { config } from './proxy';

describe('proxy matcher', () => {
  it('keeps API routes behind session refresh and absolute-cap enforcement', () => {
    expect(unstable_doesMiddlewareMatch({ config, url: '/api/push/subscribe' })).toBe(true);
    expect(unstable_doesMiddlewareMatch({ config, url: '/api/payment-methods/recent' })).toBe(true);
    expect(unstable_doesMiddlewareMatch({
      config,
      url: '/api/payment-methods/recent',
      headers: { 'next-router-prefetch': '1', purpose: 'prefetch' },
    })).toBe(true);
  });

  it('continues to exclude static and PWA assets', () => {
    expect(unstable_doesMiddlewareMatch({ config, url: '/_next/static/app.js' })).toBe(false);
    expect(unstable_doesMiddlewareMatch({ config, url: '/sw.js' })).toBe(false);
  });
});
