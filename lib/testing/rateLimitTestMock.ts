// Shared implementation for action tests whose subject is business behaviour
// downstream of the rate limiter. The limiter's own suites exercise IP
// extraction, fail-closed dependency handling, bucket exhaustion and telemetry.
// Keeping this here prevents every unrelated action fixture from having to
// emulate the service-role consume_rate_limit RPC.

export const allowTestRateLimit = {
  clientIp: async () => '198.51.100.10',
  consumeAll: async () => true,
};
