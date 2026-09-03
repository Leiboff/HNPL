import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCsp } from './csp';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('createCsp', () => {
  it('uses a nonce and strict-dynamic in production without unsafe script allowances', () => {
    const csp = createCsp('nonce-for-test', false);

    expect(csp).toContain("script-src 'self' 'nonce-nonce-for-test' 'strict-dynamic'");
    expect(csp).toContain("script-src-attr 'none'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it('allows eval only during development', () => {
    expect(createCsp('nonce-for-test', true)).toContain("'unsafe-eval'");
  });

  it('allows client-side requests to the Google Places API', () => {
    const connectSrc = createCsp('nonce-for-test', false)
      .split('; ')
      .find((directive) => directive.startsWith('connect-src '));

    expect(connectSrc?.split(' ')).toContain('https://places.googleapis.com');
  });

  it('wires the nonce into the proxy request and response, and forces dynamic rendering', () => {
    const proxy = read('proxy.ts');
    const layout = read('app/layout.tsx');

    expect(proxy).toContain("requestHeaders.set('x-nonce', nonce)");
    expect(proxy).toContain("requestHeaders.set('Content-Security-Policy', csp)");
    expect(proxy).toContain("response.headers.set('Content-Security-Policy', csp)");
    expect(layout).toMatch(/export const dynamic = 'force-dynamic'/);
  });

  it('limits HTML CSP headers to non-API requests without bypassing the proxy', () => {
    const proxy = read('proxy.ts');

    expect(proxy).toMatch(/const isApiRoute = request\.nextUrl\.pathname === '\/api'/);
    expect(proxy).toMatch(/const csp = nonce\s*\? createCsp/);
    expect(proxy).toMatch(/if \(csp\) response\.headers\.set\('Content-Security-Policy', csp\)/);
  });
});
