// @vitest-environment node
//
// Guards for the landing page's device image and the fixtures behind it.
// T7 (determinism) and T8 (Poppins at capture time) need a browser, so they
// run inside the capture itself: `pnpm marketing:device-approved --verify`.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { validateSaId } from '@/lib/validation/saId';
import { FIXTURE } from './fixtures';
import { FRAME } from './frame';
import { renderScreenMarkup } from './render';

const REPO = path.resolve(import.meta.dirname, '../..');
const PNG = path.join(REPO, 'public/marketing/device-approved.png');
const LANDING = readFileSync(path.join(REPO, 'app/LandingPage.tsx'), 'utf8');

describe('T1 dimensions parity', () => {
  it('is 1260×2580, the same 0.4884 aspect as the next/image 630×1290 props', async () => {
    const meta = await sharp(PNG).metadata();
    expect([meta.width, meta.height]).toEqual([FRAME.width, FRAME.height]);
    const props = LANDING.match(/src="\/marketing\/device-approved\.png"[\s\S]*?width=\{(\d+)\}\s*height=\{(\d+)\}/);
    expect(props).not.toBeNull();
    expect(meta.width! / meta.height!).toBeCloseTo(Number(props![1]) / Number(props![2]), 4);
  });
});

describe('T2 alpha parity', () => {
  it('has an alpha channel, fully transparent corners and an opaque screen', async () => {
    const { data, info } = await sharp(PNG).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    const alpha = (x: number, y: number) => data[(y * info.width + x) * 4 + 3];
    const w = info.width - 1, h = info.height - 1;
    for (const [x, y] of [[0, 0], [w, 0], [0, h], [w, h], [20, 20], [w - 20, h - 20]]) {
      expect(alpha(x, y), `corner (${x},${y})`).toBe(0);
    }
    expect(alpha(info.width >> 1, info.height >> 1)).toBe(255);
    expect(alpha(0, info.height >> 1)).toBe(255); // the bezel edge itself
  });
});

describe('T3 no Pay-in-2 on the captured screen', () => {
  it('renders the celebration with no "Pay in 2" copy', async () => {
    const text = (await renderScreenMarkup()).replace(/<[^>]+>/g, ' ');
    expect(text).toMatch(/You(’|&#x27;|')re approved!/);
    expect(text).toMatch(/R8,000/);
    expect(text).not.toMatch(/pay[\s-]?in[\s-]?2/i);
  }, 60_000);
});

describe('T4 fixture sanity', () => {
  it('a round allowance, with available ≤ approved', () => {
    expect(FIXTURE.approvedAllowance % 1000).toBe(0);
    expect(FIXTURE.availableBalance).toBeLessThanOrEqual(FIXTURE.approvedAllowance);
    expect(FIXTURE.availableBalance).toBeGreaterThan(0);
  });

  it('any plan is Pay in 3: amounts divide by 3 and sum to the bill', () => {
    for (const plan of FIXTURE.plans) {
      expect(plan.plan_type).toBe(3);
      expect(plan.instalments).toHaveLength(3);
      expect(plan.total_amount % 3).toBe(0);
      for (const i of plan.instalments) expect(i.amount).toBe(plan.total_amount / 3);
      expect(plan.instalments.reduce((s, i) => s + i.amount, 0)).toBe(plan.total_amount);
    }
  });
});

describe('T5 the harness is not part of the app', () => {
  it('lives outside app/, and nothing under app/ imports it', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(tsx?|mts)$/.test(name) && /scripts\/marketing/.test(readFileSync(p, 'utf8'))) offenders.push(p);
      }
    };
    walk(path.join(REPO, 'app'));
    expect(offenders).toEqual([]);
    expect(path.relative(path.join(REPO, 'app'), import.meta.dirname).startsWith('..')).toBe(true);
  });
});

describe('T6 no real PII in fixtures', () => {
  const src = readFileSync(path.join(import.meta.dirname, 'fixtures.ts'), 'utf8');

  it('no digit run that passes validateSaId()', () => {
    const runs = src.match(/\d{13,}/g) ?? [];
    for (const run of runs) {
      for (let i = 0; i + 13 <= run.length; i++) expect(validateSaId(run.slice(i, i + 13)).valid, run).toBe(false);
    }
  });

  it('no email outside @example.com', () => {
    for (const email of src.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []) expect(email).toMatch(/@example\.com$/);
  });

  it('no 16-digit card number, grouped or not', () => {
    // UUIDs are 8-4-4-4-12 and not card numbers; drop them before scanning.
    const noUuids = src.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '');
    expect(noUuids).not.toMatch(/(?:\d[ -]?){15}\d/);
  });
});

describe('T9 landing wiring', () => {
  it('the landing page still shows /marketing/device-approved.png with accurate alt text', () => {
    expect(LANDING).toMatch(/src="\/marketing\/device-approved\.png"/);
    expect(LANDING).toMatch(/alt="betternow app showing an approved interest-free healthcare allowance"/);
  });
});
