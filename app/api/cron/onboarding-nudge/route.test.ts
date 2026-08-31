import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '@/lib/testing/stripComments';

// The route is mostly orchestration, and the parts worth pinning are the
// decisions rather than the plumbing: it must not send without the cron
// secret, it must claim before sending, and it must survive a mail
// failure without dropping the rest of the batch.

const SRC  = readFileSync('app/api/cron/onboarding-nudge/route.ts', 'utf8');
const CODE = stripComments(SRC);

describe('auth', () => {
  it('refuses to run when CRON_SECRET is unset, rather than running open', () => {
    expect(CODE).toMatch(/REQUIRE_CRON_SECRET\s*=\s*true/);
    expect(CODE).toMatch(/Cron secret not configured/);
    expect(CODE).toMatch(/status:\s*500/);
  });

  it('compares the bearer token in constant time, with a length guard', () => {
    // A mismatched-size header would otherwise throw out of
    // timingSafeEqual instead of returning a clean 401.
    expect(CODE).toMatch(/timingSafeEqual/);
    expect(CODE).toMatch(/receivedBuf\.length === expectedBuf\.length/);
    expect(CODE).toMatch(/status:\s*401/);
  });
});

describe('claim before send', () => {
  it('calls the atomic claim, not a plain select', () => {
    expect(CODE).toMatch(/rpc\('claim_onboarding_nudges'/);
    expect(CODE).not.toMatch(/from\('profiles'\)[\s\S]{0,80}select/);
  });

  it('passes the two intervals and a batch cap', () => {
    expect(CODE).toMatch(/p_stale_minutes/);
    expect(CODE).toMatch(/p_second_after_hours/);
    expect(CODE).toMatch(/p_limit/);
    expect(CODE).toMatch(/BATCH_LIMIT\s*=\s*\d+/);
  });

  it('the parameters are the agreed ones — 5 minutes, then 24 hours', () => {
    expect(CODE).toMatch(/STALE_MINUTES\s*=\s*5\b/);
    expect(CODE).toMatch(/SECOND_AFTER_HOURS\s*=\s*24\b/);
  });

  it('bails out on a claim error instead of sending a partial batch', () => {
    expect(CODE).toMatch(/if \(claimErr\)/);
    expect(CODE).toMatch(/Claim failed/);
  });
});

describe('sending', () => {
  it('re-checks each patient against the step machine before emailing', () => {
    // The claim runs a moment earlier. Someone who finished in between
    // must not receive "you didn't finish your application".
    expect(CODE).toMatch(/resolveNudgeTarget\(/);
    expect(CODE).toMatch(/if \(!target\)/);
    expect(CODE).toMatch(/alreadyDone/);
  });

  it('one failed send does not abandon the rest of the batch', () => {
    expect(CODE).toMatch(/failed \+= 1/);
    expect(CODE).not.toMatch(/throw /);
  });

  it('sends sequentially — a parallel burst only risks a rate limit here', () => {
    expect(CODE).not.toMatch(/Promise\.all/);
    expect(CODE).toMatch(/for \(const row of rows\)/);
  });

  it('never logs an email address', () => {
    // The log line for a failure carries the provider error only. An
    // address in a log is a copy of personal data in a place nobody is
    // auditing.
    const logLines = CODE.split('\n').filter(l => /console\.(log|warn|error)/.test(l));
    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) {
      expect(line).not.toMatch(/\.email|target\.email|row\.email/);
    }
  });
});

describe('observability', () => {
  it('records every run in cron_runs, like the other three jobs', () => {
    expect(CODE).toMatch(/from\('cron_runs'\)/);
    expect(CODE).toMatch(/job_name:\s*'onboarding-nudge'/);
  });

  it('only logs a summary when it did something', () => {
    // Every five minutes, an unconditional log is ~288 identical lines a
    // day and buries the runs that mattered.
    expect(CODE).toMatch(/if \(rows\.length > 0\)[\s\S]{0,120}console\.log/);
  });

  it('supports POST so an operator can trigger a run by hand', () => {
    expect(CODE).toMatch(/export async function GET/);
    expect(CODE).toMatch(/export async function POST/);
  });
});
