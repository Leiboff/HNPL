import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// ─── The SOAP body carries the password in cleartext ────────────────────
//
// There is no token and no signature on this integration: `pPassword` is
// an element in every request. So "log the request while debugging" writes
// the service credentials to whatever aggregator collects platform logs,
// and one `console.error(envelope)` added in a hurry during an incident is
// all it takes.
//
// A convention cannot prevent that; a test can. This walks the Experian
// client sources and fails if any logging call is handed something that
// has not been through `redactEnvelope`.

const DIR = join(process.cwd(), 'lib/experian');

function sourceFiles(): string[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => join(DIR, f));
}

/**
 * Strip comments so the scans below read CODE, not prose.
 *
 * String-aware: `https://host/path` inside a literal must not be mistaken
 * for a line comment, which is exactly what a naive strip does to every URL
 * in this directory.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  type State = 'code' | 'line' | 'block' | 'single' | 'double' | 'tick';
  let state: State = 'code';

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line';  i += 2; continue; }
      if (c === '/' && next === '*') { state = 'block'; i += 2; continue; }
      if (c === "'")  state = 'single';
      else if (c === '"') state = 'double';
      else if (c === '`') state = 'tick';
      out += c; i += 1; continue;
    }

    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; }
      i += 1; continue;
    }

    if (state === 'block') {
      if (c === '*' && next === '/') { state = 'code'; i += 2; continue; }
      if (c === '\n') out += c;
      i += 1; continue;
    }

    // Inside a string literal.
    if (c === '\\') { out += c + (next ?? ''); i += 2; continue; }
    if ((state === 'single' && c === "'")
      || (state === 'double' && c === '"')
      || (state === 'tick'   && c === '`')) state = 'code';
    out += c; i += 1;
  }
  return out;
}

/** Every console.* call in the file, as source text, with brace matching. */
function consoleCalls(src: string): string[] {
  const calls: string[] = [];
  const re = /console\.(?:log|error|warn|info|debug|trace)\s*\(/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(src)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i += 1) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')') depth -= 1;
    }
    calls.push(src.slice(m.index, i));
  }
  return calls;
}

describe('no Experian client logs an unredacted request', () => {
  const files = sourceFiles();

  it('finds the client sources to scan', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.endsWith('scoreClient.ts'))).toBe(true);
  });

  it.each(files.map((f) => [f.split('/').pop()!, f]))(
    '%s never passes a raw envelope to console.*',
    (_name, file) => {
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const call of consoleCalls(src)) {
        if (/\benvelope\b/.test(call)) {
          expect(
            call,
            'a logging call references `envelope` without redacting it — the '
            + 'SOAP body contains pPassword in cleartext',
          ).toMatch(/redactEnvelope\s*\(\s*envelope\s*\)/);
        }
      }
    },
  );

  it.each(files.map((f) => [f.split('/').pop()!, f]))(
    '%s never logs credentials directly',
    (_name, file) => {
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const call of consoleCalls(src)) {
        expect(call, 'a logging call references a password').not.toMatch(/\bpassword\b/i);
        expect(call, 'a logging call references the credentials object').not.toMatch(/\bcreds\b/);
      }
    },
  );

  it('no client builds a URL on the unusable :9443 REST port', () => {
    // Those endpoints answer -204 on every request. A URL pointing at one
    // would produce a permanent, silent pending state.
    for (const file of files) {
      expect(stripComments(readFileSync(file, 'utf8')), file).not.toContain('9443');
    }
  });

  it('no credential is hardcoded — they come from env only', () => {
    for (const file of files) {
      const src = stripComments(readFileSync(file, 'utf8'));
      // The only permitted mention of the env names is reading them.
      const suspicious = /(?:password|secret|apikey|api_key)\s*[:=]\s*['"][^'"]{4,}['"]/i;
      expect(src, file).not.toMatch(suspicious);
    }
  });
});
