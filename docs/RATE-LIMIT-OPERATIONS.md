# Rate-limit operations

The application rate limiter is a security dependency. It is shared through
Postgres and fails closed: a quota denial or an unavailable limiter prevents
the protected action from continuing.

## Event contract

Every refusal emits one JSON log line with `event="rate_limit_decision"`.
Allowed traffic is not logged because the `rate_limit_hits` table is already
its durable counter.

| Field | Meaning |
|---|---|
| `outcome` | `limited`, `missing_subject`, or `unavailable` |
| `bucket` | The protected operation |
| `subject_kind` | `ip` or `account`; never the raw subject |
| `subject_hash` | Stable, truncated HMAC-SHA256 correlation value |
| `limit_max`, `window_seconds` | Rule active at the time |
| `dependency_stage` | `client_init`, `rpc`, or `rpc_timeout` when unavailable |
| `dependency_code` | Bounded error class/code; never the provider message |

## Alerts

Configure the log platform to parse the JSON and alert on:

1. **Page immediately:** any production `outcome="unavailable"`. Group by
   `dependency_stage` and `bucket`; a burst means protected customer actions
   are failing closed.
2. **Page immediately:** any `outcome="missing_subject"` in production. This
   indicates proxy/header drift and will deny legitimate requests.
3. **Investigate:** five or more `limited` events for a money or paid-vendor
   bucket in five minutes for one `subject_hash`.
4. **Review daily:** top limited fingerprints by bucket and IP/account kind.

Money and paid-vendor buckets are `checkout_initiate`, `identity_session`,
`accept_plan`, `pay_saved_card`, `self_settle`, `counter_session`,
`credit_check`, and `reverse_geocode`.

## Incident response

1. Check whether failures are isolated to `client_init`, `rpc`, or
   `rpc_timeout`.
2. Check Supabase health and the `SUPABASE_SERVICE_ROLE_KEY` deployment
   configuration without printing the key.
3. Do not bypass the limiter to restore money-moving actions. Restore the
   dependency or temporarily disable the affected product surface.
4. For `missing_subject`, verify Vercel's `x-forwarded-for` / `x-real-ip`
   behavior before changing application code.
5. After recovery, compare denied buckets and subject hashes with payment,
   KYC, and checkout logs to separate customer impact from deliberate abuse.

Set `RATE_LIMIT_LOG_HMAC_KEY` to a dedicated random secret so fingerprints
remain stable across deploys. If it is absent, the server-side Supabase
service key is used as the HMAC key; if neither exists, `subject_hash` is
`null` rather than falling back to an offline-guessable plain hash.
