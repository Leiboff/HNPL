// SERVER-ONLY. Never import in a client component.
//
// ─── Experian connection + policy configuration ─────────────────────────
//
// Two services, one vendor, one set of credentials. Everything that
// differs between UAT and live is resolved here so no call site builds a
// URL or reads a secret.
//
// ─── pVersion IS A RISK-MODEL SELECTOR, NOT A WIRE VERSION ─────────────
//
// This is the least obvious thing in the integration and the most
// dangerous to get wrong. `pVersion` does not version the request format —
// it chooses which SCORECARD FAMILY the bureau answers with, and each
// family has its own band cutoffs:
//
//     1.0  →  CPA & NLR          (spec §4.1)
//     2.0  →  Compuscore V3      (spec §4.2)
//     4.0  →  Sigma suite        (spec §5.3)
//
// Set it wrong and the call still succeeds, still returns a plausible
// three-digit score, and gets banded against the wrong table — silently
// mispricing every limit rather than failing. So the value is validated at
// module load and mapped to its band table explicitly; an unrecognised
// version throws on the first call rather than defaulting to a family.
//
// 4.0 is what the live UAT capture used and what returned SU/STS. Note it
// is UNDOCUMENTED in the v2.1 integration PDF (© 2021), which predates the
// Sigma rollout — the PDF's own table lists only 1.0 and 2.0.
//
// ─── SOAP ONLY. IGNORE THE REST ENDPOINTS ON :9443 ─────────────────────
//
// They answer -204 on every request and are unusable. Nothing here should
// ever construct a :9443 URL; `experianEndpoints` is the only source of
// URLs and both are :443.

import { SIGMA_BANDS, LEGACY_BANDS, COMPUSCORE_BANDS, type BandCutoffs } from './bands';

const LIVE_HOST = 'apis.experian.co.za';
const UAT_HOST  = 'apis-uat.experian.co.za';

/** True only when explicitly pointed at production. Defaults to UAT. */
export function experianIsLive(): boolean {
  return (process.env.EXPERIAN_ENVIRONMENT ?? 'UAT').trim().toUpperCase() === 'LIVE';
}

export function experianHost(): string {
  return experianIsLive() ? LIVE_HOST : UAT_HOST;
}

export function experianEndpoints(): { score: string; affordability: string } {
  const host = experianHost();
  return {
    score:         `https://${host}/GetPersonScore`,
    affordability: `https://${host}/AffordService`,
  };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set in environment variables.`);
  return v;
}

export type ExperianCredentials = {
  username: string;
  password: string;
};

/**
 * Credentials, read at call time rather than module load so a missing
 * secret surfaces as a handled failure on one enquiry instead of crashing
 * the process at import.
 *
 * The returned password is passed straight into the envelope builder and
 * must never reach a log. See redact.ts.
 */
export function experianCredentials(): ExperianCredentials {
  return {
    username: requireEnv('EXPERIAN_USERNAME'),
    password: requireEnv('EXPERIAN_PASSWORD'),
  };
}

/** `pMyOrigin` / `pOrigin` — the name of the calling application. */
export function experianOrigin(): string {
  return process.env.EXPERIAN_ORIGIN ?? 'BetterNow';
}

/** `pOriginVersion` on the affordability call. */
export function experianOriginVersion(): string {
  return process.env.EXPERIAN_ORIGIN_VERSION ?? '1.0';
}

// ── Scorecard family ───────────────────────────────────────────────────

export type ScoreFamily = {
  /** The literal `pVersion` string to send. */
  pVersion: string;
  /** The band table the returned cards must be looked up in. */
  cards: Readonly<Record<string, BandCutoffs>>;
  /** Human label for logs and the assessment row. */
  label: string;
};

const SCORE_FAMILIES: Readonly<Record<string, ScoreFamily>> = {
  '1.0': { pVersion: '1.0', cards: LEGACY_BANDS,     label: 'CPA/NLR' },
  '2.0': { pVersion: '2.0', cards: COMPUSCORE_BANDS, label: 'Compuscore V3' },
  '4.0': { pVersion: '4.0', cards: SIGMA_BANDS,      label: 'Sigma' },
};

/** Default `pVersion`. 4.0 — the Sigma suite, as proven against UAT. */
export const DEFAULT_SCORE_VERSION = '4.0';

/**
 * The configured family, with its band table.
 *
 * Throws on an unrecognised `pVersion` rather than falling back, because
 * the failure mode of a wrong family is a silently mispriced limit rather
 * than an error anyone would notice.
 */
export function scoreFamily(): ScoreFamily {
  const requested = (process.env.EXPERIAN_SCORE_VERSION ?? DEFAULT_SCORE_VERSION).trim();
  const family = SCORE_FAMILIES[requested];
  if (family === undefined) {
    throw new Error(
      `EXPERIAN_SCORE_VERSION="${requested}" is not a scorecard family this code knows the `
      + `band cutoffs for (expected one of ${Object.keys(SCORE_FAMILIES).join(', ')}). `
      + 'Refusing rather than banding a score against the wrong table.',
    );
  }
  return family;
}

// ── Which card decides ────────────────────────────────────────────────
//
// One call can return several scorecards. The live UAT capture returned
// both SU (Sigma Unsecured Credit, score -1 — no accounts open longer than
// three months) and STS (Sigma Transcend, score 620).
//
// Preference order, first usable answer wins:
//
//   SU   Sigma Unsecured Credit — the card modelled for exactly this
//        product. Preferred when it can score the applicant.
//   STS  Sigma Transcend — Experian's thin-file card, documented as "a
//        failover score to be returned when the traditional bureau scores
//        are insufficient". Used when SU cannot score.
//
// This ordering has real commercial consequence: the captured applicant is
// unscorable on SU and Low Risk on STS, so reading SU alone would treat
// them as a thin file (R1,000) where the fallback prices them at R10,000.
// Falling back is the decision on record — it is what Transcend exists
// for — but it means the thin-file ceiling now binds only when NO card
// scores at all.
//
// Which cards a branch is even switched on for is an account-level setting
// at Experian (spec §4.2), so the list is config rather than a constant.

export const DEFAULT_SCORECARD_PREFERENCE = ['SU', 'STS'] as const;

export function scorecardPreference(): string[] {
  const raw = process.env.EXPERIAN_SCORECARD_PREFERENCE;
  if (!raw || raw.trim() === '') return [...DEFAULT_SCORECARD_PREFERENCE];
  return raw.split(',').map((s) => s.trim().toUpperCase()).filter((s) => s !== '');
}

// ── Enquiry type ──────────────────────────────────────────────────────
//
// There is no enquiry-purpose or enquiry-type parameter on `getScore`.
// The operation takes exactly pUsername, pPassword, pIdNumber,
// pResultType, pMyOrigin and pVersion (spec §7.1), and the word "enquiry"
// appears in the spec only inside reason-code descriptions about the
// consumer's own enquiry history.
//
// So whether our score call lands as a soft/preliminary enquiry or a hard
// one is NOT something this code can set per request — it is a branch
// configuration on the Experian account. That matters because the score
// runs before identity verification, against an ID that is checksum-valid
// but not yet confirmed as the applicant's own.
//
// Left as config anyway so that if Experian does expose a parameter later,
// it is one line here and one in the envelope builder. Unset by default,
// and when unset the element is omitted entirely rather than sent empty —
// an unexpected element is how -101 happens.

export function experianEnquiryType(): string | null {
  const raw = process.env.EXPERIAN_ENQUIRY_TYPE;
  return raw && raw.trim() !== '' ? raw.trim() : null;
}

// ── Timeouts ──────────────────────────────────────────────────────────
//
// The captured score call returned in ~1.7s. Twelve seconds leaves room
// for a slow day without holding a patient on a form indefinitely; past
// that the outcome is pending-and-retry, which is a better experience than
// a spinner that never resolves.

export const SCORE_TIMEOUT_MS = 12_000;
export const AFFORDABILITY_TIMEOUT_MS = 20_000;
