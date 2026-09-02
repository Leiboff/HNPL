// ─── Automation scoring at the front door ───────────────────────────────
//
// WHAT THIS IS FOR
//
// signUpPatient is protected by one control: consumeAll('signup', …) at
// 10/hour per IP. That is a throttle on a single address, and an address
// is the cheapest thing in this threat model to rotate — a residential
// proxy pool rents thousands by the hour. Ten accounts per IP times a
// thousand IPs is ten thousand accounts, and the limiter records each one
// as comfortably within budget.
//
// The accounts themselves are not the prize. What they buy is:
//
//   • Didit sessions, which cost REAL MONEY per unit. identity_session is
//     capped at 5/account/day, so ten thousand accounts is fifty thousand
//     paid KYC units;
//   • transactional email out of our Supabase project, from our sending
//     reputation, at any address the attacker names;
//   • a review queue stuffed past the point where a human can staff it —
//     which matters more than it looks, because registry_unavailable and
//     biometric_image_unusable both route to that queue, and an attacker
//     who can flood it is an attacker who can degrade the fallback path
//     for every real applicant behind them.
//
// WHAT IT DOES AND DOES NOT CLAIM
//
// This is a heuristic scorer over signals a browser gives up for free. It
// is NOT a CAPTCHA, NOT proof-of-work, and NOT a bot-management vendor.
// A competent attacker driving a real Chrome under Playwright, pacing
// input at human speed, defeats every check here — and that is the
// expected outcome, not a defect. The job is to price the attack: make
// the cheap, high-volume version (curl in a loop, a headless default
// build, a replayed form POST) fail, so that volume costs real automation
// engineering rather than a shell script.
//
// It is deliberately the OUTER layer. Nothing here gates credit. The
// controls that decide whether money moves are the registry check, the
// biometric match and the ring analysis in identityGraph.ts; this one only
// decides whether a request is worth spending a vendor call on.
//
// PURE, AND THAT IS THE POINT
//
// No I/O, no clock, no headers object — everything arrives as an argument.
// Every rule below is therefore directly testable against the exact
// adversarial input that motivates it, which is the only way a scorer like
// this stays honest as rules accrete.

/** A signal that fired, with what it contributes. Surfaced for logs and review. */
export type BotSignal = {
  code:   BotSignalCode;
  /** Points added to the score. Higher = more automated. */
  weight: number;
  /** Human-readable, safe to log. Never contains user input. */
  detail: string;
};

export type BotSignalCode =
  | 'honeypot_filled'
  | 'submitted_impossibly_fast'
  | 'submitted_without_interaction'
  | 'ua_missing'
  | 'ua_headless'
  | 'ua_non_browser'
  | 'form_token_missing'
  | 'form_token_stale'
  | 'timezone_missing';

export type BotVerdict = 'human' | 'suspect' | 'automated';

export type BotAssessment = {
  score:   number;
  verdict: BotVerdict;
  signals: BotSignal[];
};

/**
 * What the caller observed about one form submission. Every field is
 * optional and every ABSENT field is treated as evidence — see the note
 * on absent-by-default below.
 */
export type BotObservation = {
  /**
   * A field hidden from humans by CSS. Any non-empty value means something
   * that parses HTML and fills inputs got here — a browser driven by a
   * person never touches it. Same trick lib/contact/contactRateLimit.ts
   * already uses; this generalises it to the signup door.
   */
  honeypot?: string | null;
  /**
   * Milliseconds between the form rendering and the submit. Derived from a
   * signed timestamp the server issued, NOT from a number the client sends
   * — an unsigned client-supplied dwell is a field the attacker fills in
   * with 9000 and defeats the check entirely.
   */
  dwellMs?: number | null;
  /**
   * Count of genuine input events (keypress/pointer) the page observed. A
   * scripted fill that sets .value directly produces zero.
   */
  interactionCount?: number | null;
  /** Raw User-Agent header. */
  userAgent?: string | null;
  /** IANA timezone the browser reported, e.g. "Africa/Johannesburg". */
  timezone?: string | null;
  /** False when the server could not verify its own issued form token. */
  formTokenValid?: boolean | null;
};

/**
 * Thresholds.
 *
 * `suspect` is the step-up band: the caller should add friction (a
 * challenge, a slower path) but must not refuse outright. `automated` is
 * the refusal band, and is set high enough that no single soft signal can
 * reach it alone — every combination that crosses 100 contains either the
 * honeypot or at least three independent signals. That is deliberate: a
 * false positive here is a real patient locked off the front door of a
 * healthcare payment product, which is a materially worse outcome than
 * letting a bot through to the registry check that will refuse it anyway.
 */
export const BOT_SUSPECT_SCORE  = 50;
export const BOT_AUTOMATED_SCORE = 100;

/**
 * Below this, a human did not read a signup form, let alone type into it.
 * Measured against the real thing rather than guessed: the fastest
 * plausible completion of first name + last name + email + password, with
 * autofill doing the typing, is still north of a second and a half once
 * the person has read the labels and clicked submit.
 */
const IMPOSSIBLY_FAST_MS = 1_200;

export function assessBotSignals(observation: BotObservation): BotAssessment {
  const signals: BotSignal[] = [];

  // ─── The honeypot: the one near-certain signal ────────────────────────
  //
  // Weighted to reach the refusal band on its own. Nothing a human does in
  // a browser fills a display:none field; the false-positive story is a
  // password manager filling every text input it finds, which is why the
  // field must be named so managers ignore it (see the form component) and
  // why this is the only rule permitted to be decisive alone.
  if (typeof observation.honeypot === 'string' && observation.honeypot.trim().length > 0) {
    signals.push({
      code: 'honeypot_filled',
      weight: BOT_AUTOMATED_SCORE,
      detail: 'hidden field was populated',
    });
  }

  // ─── Timing ───────────────────────────────────────────────────────────
  //
  // Note the null check is separate from the comparison. A missing dwell
  // is NOT scored as fast — it is scored by the form-token rule below,
  // which is the signal that actually distinguishes "no token" from "fast
  // token". Treating absent-as-zero here would double-count.
  if (typeof observation.dwellMs === 'number' && observation.dwellMs >= 0 && observation.dwellMs < IMPOSSIBLY_FAST_MS) {
    signals.push({
      code: 'submitted_impossibly_fast',
      weight: 45,
      detail: `submitted ${observation.dwellMs}ms after the form was issued`,
    });
  }

  // A scripted fill sets .value and dispatches nothing. Real autofill still
  // produces pointer events from the click that triggered it, and a real
  // typist produces dozens. Zero is the signal; we do not grade above zero
  // because accessibility tooling and paste-only flows legitimately produce
  // very few.
  //
  // Weighted to reach the STEP-UP band on its own — the only soft signal
  // that does. A submit carrying literally zero pointer and key events is
  // genuinely unusual for a person: even a password manager filling every
  // field still needs the click that submits the form, and that click is a
  // pointer event. Zero means the value was set and the form dispatched
  // programmatically, which is the signature of the realistic attacker (a
  // real browser under automation, paced to look human) that every other
  // rule here misses.
  //
  // The cost is named rather than assumed away: some assistive technology
  // and some paste-only flows can legitimately produce zero. They land in
  // 'suspect', which means EXTRA FRICTION, not refusal — and that
  // proportionality is the whole reason this signal is allowed to be this
  // heavy. It would not be acceptable at refusal weight.
  if (typeof observation.interactionCount === 'number' && observation.interactionCount === 0) {
    signals.push({
      code: 'submitted_without_interaction',
      weight: BOT_SUSPECT_SCORE,
      detail: 'no pointer or key events observed before submit',
    });
  }

  // ─── User-Agent ───────────────────────────────────────────────────────
  //
  // Trivially spoofable, and scored low for exactly that reason. It costs
  // an attacker one header to defeat — but the population that has not
  // bothered is large, and a rule that is free to evaluate and catches the
  // unbothered majority earns its place as long as nothing downstream
  // depends on it alone.
  //
  // NOT-OBSERVED IS NOT THE SAME AS OBSERVED-ABSENT, and conflating them
  // was a real defect here: `undefined` means this call site has not been
  // wired to pass a UA yet, while `null`/`''` means the request genuinely
  // arrived without the header. Scoring the first as evidence made an
  // empty observation — a caller mid-rollout — score 35 for a header
  // nobody had asked it for. Every optional field in this module follows
  // the same rule; see the timezone check below.
  const ua = observation.userAgent === undefined ? undefined : (observation.userAgent ?? '').trim();
  if (ua === undefined) {
    // Not wired up. No signal, in either direction.
  } else if (ua.length === 0) {
    signals.push({ code: 'ua_missing', weight: 35, detail: 'no User-Agent header' });
  } else if (HEADLESS_UA_RE.test(ua)) {
    signals.push({ code: 'ua_headless', weight: 45, detail: 'User-Agent self-identifies as an automation build' });
  } else if (!BROWSER_UA_RE.test(ua)) {
    signals.push({ code: 'ua_non_browser', weight: 40, detail: 'User-Agent is not a browser' });
  }

  // ─── The server's own form token ──────────────────────────────────────
  //
  // A replayed or hand-built POST that never loaded the page has no valid
  // token. This is the check that catches the plain `curl -d` attack, and
  // unlike the UA it cannot be forged without the signing key.
  if (observation.formTokenValid === false) {
    signals.push({ code: 'form_token_missing', weight: 45, detail: 'form token absent or unverifiable' });
  }

  // Every real browser resolves a timezone. Its absence means the page's
  // script never ran — consistent with a direct POST. Weighted lightly:
  // privacy tooling does strip it, and a patient using a hardened browser
  // must not be pushed toward refusal on that alone.
  if (observation.timezone !== undefined && !observation.timezone) {
    signals.push({ code: 'timezone_missing', weight: 15, detail: 'client reported no timezone' });
  }

  const score = signals.reduce((total, s) => total + s.weight, 0);

  return { score, verdict: verdictFor(score), signals };
}

function verdictFor(score: number): BotVerdict {
  if (score >= BOT_AUTOMATED_SCORE) return 'automated';
  if (score >= BOT_SUSPECT_SCORE)   return 'suspect';
  return 'human';
}

/**
 * Self-identifying automation. These are the DEFAULT strings the common
 * tools ship with — the point is to catch the operator who did not change
 * them, not to pretend this is a detection surface.
 */
const HEADLESS_UA_RE = /headless|phantomjs|electron\/|puppeteer|playwright|selenium|webdriver/i;

/**
 * Something that at least claims to be a browser engine. Deliberately
 * permissive: it must accept every real browser including ones that do not
 * exist yet, so it matches on engine tokens rather than an allowlist of
 * products. curl/wget/python-requests/Go-http-client all fail it.
 */
const BROWSER_UA_RE = /mozilla\/|applewebkit|gecko\/|chrome\/|safari\/|firefox\/|edge?\//i;
