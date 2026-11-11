import { describe, expect, it } from 'vitest';
import { REDACTED, redactText } from '../redact.js';

/**
 * Redaction runs on MarketSharp-controlled text (notes, error bodies up to the
 * 4 MiB cap), so it must stay linear in the input length. Each case is probed
 * small first, so a quadratic implementation fails in seconds instead of
 * hanging the suite.
 *
 * The real check is the 4M/1M time ratio. The absolute bounds are loose
 * backstops against catastrophic runs, because shared CI runners can be
 * several times slower than a laptop.
 */
const PROBE = 100_000;
const SMALL = 1_000_000;
const LARGE = 4_000_000;

function bestMs(fn: () => unknown, runs = 3): number {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

function expectLinear(make: (n: number) => string, run: (s: string) => unknown): void {
  // The old quadratic regex took seconds on 100k chars of "-eyJ" repeated.
  expect(bestMs(() => run(make(PROBE)), 1), 'probe at 100k chars').toBeLessThan(1_000);
  const small = make(SMALL);
  const large = make(LARGE);
  const t1 = bestMs(() => run(small));
  const t4 = bestMs(() => run(large));
  expect(t4, '4M chars').toBeLessThan(5_000);
  // Linear work is ~4x; floor t1 so timer noise on a fast run cannot fail the ratio.
  expect(t4 / Math.max(t1, 5), `time(4M)/time(1M) = ${t4.toFixed(1)}/${t1.toFixed(1)}`).toBeLessThan(8);
}

const repeat = (unit: string) => (n: number) => unit.repeat(Math.ceil(n / unit.length));

describe('redactText is linear on adversarial input', () => {
  it.each([
    ['-eyJ', repeat('-eyJ')],
    ['eyJ', repeat('eyJ')],
    ['chained JWT-shaped segments', repeat('eyJaaaaaaaa.')],
    ['glued JWTs', repeat('eyJaaaaaaaa.bbbbbbbb.cccccccc')],
    ['eyJ with short segments', repeat('eyJaaaaaaaa.b.')],
    ['Bearer', repeat('Bearer ')],
    ['Bearer then whitespace', (n: number) => `Bearer${' '.repeat(n)}`],
    ['dots only', repeat('.')],
  ])('on %s', (_name, make) => {
    expectLinear(make, (s) => redactText(s));
  });
});

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
const JWT2 = 'eyJ0eXAiOiJKV1QifQ.eyJ1c2VyIjoic2Vjb25kLXRva2VuIn0.c2lnbmF0dXJlLW9mLXRoZS1zZWNvbmQ';

function expectNoJwtPart(out: string, ...jwts: string[]): void {
  for (const jwt of jwts) for (const part of jwt.split('.')) expect(out).not.toContain(part);
}

describe('JWT redaction', () => {
  it('redacts a JWT and keeps the text around it', () => {
    expect(redactText(`token ${JWT} end`)).toBe(`token ${REDACTED} end`);
    expect(redactText(`{"note":"${JWT}"}`)).toBe(`{"note":"${REDACTED}"}`);
  });

  it('redacts a JWT glued to preceding text or segments', () => {
    expectNoJwtPart(redactText(`prefix${JWT}`), JWT);
    expectNoJwtPart(redactText(`a.b.${JWT}`), JWT);
    expectNoJwtPart(redactText(`-${JWT}`), JWT);
  });

  it('redacts back-to-back JWTs, glued or dot-joined', () => {
    for (const text of [`${JWT}${JWT2}`, `${JWT}.${JWT2}`, `${JWT}-${JWT2}`, `${JWT} ${JWT2}`, `${JWT}${JWT2}${JWT}`]) {
      const out = redactText(text);
      expectNoJwtPart(out, JWT, JWT2);
      expect(out).toContain(REDACTED);
    }
  });

  it('leaves ordinary text alone', () => {
    for (const text of [
      'version 1.2.3 released',
      'a.b.c and eyJ alone',
      'eyJshort.abcdefgh.abcdefgh',
      'eyJabcdefgh.short.abcdefgh',
      'eyJabcdefgh.abcdefgh',
      'host.example.com/path?x=1',
      '-eyJ'.repeat(1000),
    ]) {
      expect(redactText(text)).toBe(text);
    }
  });

  it('still redacts Bearer tokens and known secrets', () => {
    expect(redactText('Authorization: Bearer abc.def-ghi')).toBe(`Authorization: ${REDACTED}`);
    expect(redactText('the secret is s3cr3t-value here', ['s3cr3t-value'])).toBe(`the secret is ${REDACTED} here`);
  });
});

/** The regex this scanner replaced. Quadratic, so it only runs on short inputs. */
const PREVIOUS_JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;

/** Deterministic PRNG (mulberry32) so a failing fuzz case is reproducible. */
function prng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('JWT redaction versus the previous regex (differential fuzz)', () => {
  it('redacts everything the regex redacted', () => {
    const rand = prng(0xc0ffee);
    const parts = ['eyJ', 'eyJ', 'a', 'Z9', '_', '-', '.', 'abcdefgh.', '~', ' '];
    let checked = 0;
    for (let i = 0; i < 30_000; i++) {
      let text = '';
      for (let n = 5 + Math.floor(rand() * 40); n > 0; n--) text += parts[Math.floor(rand() * parts.length)];
      const matches = [...text.matchAll(PREVIOUS_JWT)];
      if (matches.length === 0) continue;
      checked++;
      // Whatever the regex matched must not survive intact.
      const after = redactText(text);
      for (const m of matches) expect(after, text).not.toContain(m[0]);
    }
    expect(checked).toBeGreaterThan(1_000);
  });
});
