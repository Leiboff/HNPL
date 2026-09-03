// Web Push subscriptions are browser-generated URLs, but the subscription
// endpoint reaches the server as attacker-controlled JSON. Keep the accepted
// destinations deliberately narrow so sendPushToUser cannot become an SSRF
// primitive against internal or arbitrary HTTPS services.

const EXACT_PUSH_HOSTS = new Set([
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'web.push.apple.com',
]);

const SUBDOMAIN_PUSH_HOSTS = [
  'notify.windows.com',
];

export function isAllowedPushEndpoint(raw: string): boolean {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    return false;
  }

  if (endpoint.protocol !== 'https:') return false;
  if (endpoint.username || endpoint.password) return false;
  if (endpoint.port && endpoint.port !== '443') return false;

  const hostname = endpoint.hostname.toLowerCase();
  if (EXACT_PUSH_HOSTS.has(hostname)) return true;

  return SUBDOMAIN_PUSH_HOSTS.some(
    (allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`),
  );
}
