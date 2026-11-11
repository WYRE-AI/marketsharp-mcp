/**
 * Output hygiene for anything returned to the model or written to logs.
 * The API key, secret and access token in use are removed by exact match;
 * bearer tokens and JWTs are removed by shape; values under credential-named
 * JSON keys (exact names, or any name ending in password or secret) are
 * removed by name.
 *
 * Order matters: redact first, then escape or truncate, so a secret that
 * contains & < > or straddles a cut can never survive in part.
 */

export const REDACTED = '[REDACTED]';

/** Normalized (lower-case, no `_`/`-`) key names whose string values are credentials. */
const SENSITIVE_KEYS = new Set(['apikey', 'authorization', 'token', 'accesstoken', 'refreshtoken']);

/** Exact names above, plus any name ending in `password` or `secret` (smtpPassword, webhook_secret, apiSecret). */
function isSensitiveKey(key: string): boolean {
  const name = key.toLowerCase().replace(/[_-]/g, '');
  return SENSITIVE_KEYS.has(name) || name.endsWith('password') || name.endsWith('secret');
}

/**
 * Recursively replaces string values under credential-named keys, and runs
 * redactText on every other string (before JSON re-escaping can hide a
 * secret containing `"` or `\`). Returns a new value; the input is not mutated.
 */
export function redactValue(value: unknown, knownSecrets: readonly (string | undefined)[] = [], depth = 0): unknown {
  if (depth > 64) return REDACTED;
  if (typeof value === 'string') return redactText(value, knownSecrets);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, knownSecrets, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) && typeof v === 'string' && v.length > 0 ? REDACTED : redactValue(v, knownSecrets, depth + 1);
    }
    return out;
  }
  return value;
}

const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;

const DOT = 0x2e;

/** Base64url characters plus "." : [A-Za-z0-9_.-]. */
function isTokenChar(c: number): boolean {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) || c === 0x5f || c === 0x2d || c === DOT;
}

/** Index of the first "eyJ" inside text[from, to), or -1. Never looks past `to`. */
function findEyJ(text: string, from: number, to: number): number {
  for (let i = from; i + 3 <= to; i++) {
    if (text.charCodeAt(i) === 0x65 && text.charCodeAt(i + 1) === 0x79 && text.charCodeAt(i + 2) === 0x4a) return i;
  }
  return -1;
}

/**
 * Spans [start, end) of JWT-shaped tokens: three dot-separated segments of
 * [A-Za-z0-9_-]. The first holds an "eyJ" with at least 8 more characters
 * after it, the second has at least 8 characters, the third any length. The
 * span runs from that "eyJ" to the end of the third segment. No word boundary
 * is required, so a token glued to other text, or to another token, is still
 * found.
 *
 * One forward pass, O(n). Each segment is searched for "eyJ" once, inside its
 * own bounds, and only the last three segments of a run are remembered. The
 * regex this replaces (eyJ, 8+ chars, dot, 8+ chars, dot, then any chars,
 * behind a word boundary) was quadratic on input such as "-eyJ" repeated.
 */
function jwtSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (!isTokenChar(text.charCodeAt(i))) {
      i++;
      continue;
    }
    // One maximal run of token characters, walked a segment at a time.
    // [aStart, aEnd) and [bStart, bEnd) are the two segments before the current one.
    let aStart = -1;
    let aEnd = -1;
    let bStart = -1;
    let bEnd = -1;
    let segStart = i;
    for (; ; i++) {
      const c = i < n ? text.charCodeAt(i) : -1;
      if (c !== -1 && c !== DOT && isTokenChar(c)) continue;
      // The segment [segStart, i) just ended.
      if (aStart >= 0) {
        const at = findEyJ(text, aStart, aEnd);
        if (at >= 0 && aEnd - at >= 11 && bEnd - bStart >= 8) spans.push([at, i]);
      }
      [aStart, aEnd, bStart, bEnd] = [bStart, bEnd, segStart, i];
      if (c !== DOT) break;
      segStart = i + 1;
    }
  }
  return spans;
}

/** Replaces each span with REDACTED. Spans start in increasing order and may overlap. */
function applySpans(text: string, spans: readonly (readonly [number, number])[]): string {
  const parts: string[] = [];
  let copied = 0;
  for (const [start, end] of spans) {
    if (start >= copied) parts.push(text.slice(copied, start), REDACTED);
    copied = Math.max(copied, end);
  }
  parts.push(text.slice(copied));
  return parts.join('');
}

/** Pattern-based redaction plus exact removal of any secrets known for this request. */
export function redactText(text: string, knownSecrets: readonly (string | undefined)[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join(REDACTED);
  }
  out = out.replace(BEARER, REDACTED);
  return applySpans(out, jwtSpans(out));
}
