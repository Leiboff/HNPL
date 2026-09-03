// ─── Per-request Content Security Policy ────────────────────────────────
//
// Next 16 extracts a nonce from the request CSP and applies it to framework
// scripts during dynamic rendering. Keep policy construction separate from
// proxy.ts so its security invariants are unit-testable without mocking auth.

export function createCsp(nonce: string, isDevelopment: boolean): string {
  return [
    "default-src 'self'",
    // `strict-dynamic` lets a nonce-bearing Next bootstrap script load the
    // payment, map and identity-provider scripts it creates. The explicit
    // hosts preserve CSP2/Safari compatibility.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDevelopment ? " 'unsafe-eval'" : ''} https://*.peachpayments.com https://maps.googleapis.com https://*.didit.me`,
    "script-src-attr 'none'",
    // React's `style` props are attributes, so styles cannot be made strict
    // until they are moved to nonce-capable stylesheets. Scripts — which can
    // read a session — are strict now.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://*.googleapis.com https://*.gstatic.com https://*.peachpayments.com",
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.peachpayments.com https://maps.googleapis.com https://places.googleapis.com https://*.didit.me",
    "frame-src 'self' https://*.peachpayments.com https://*.didit.me",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "upgrade-insecure-requests",
  ].join('; ');
}

/** API responses do not render nonce-bearing HTML, but still pass through the proxy for auth. */
export function shouldApplyCsp(pathname: string): boolean {
  return pathname !== '/api' && !pathname.startsWith('/api/');
}
