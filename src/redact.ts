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

const TEXT_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
];

/** Pattern-based redaction plus exact removal of any secrets known for this request. */
export function redactText(text: string, knownSecrets: readonly (string | undefined)[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join(REDACTED);
  }
  for (const pattern of TEXT_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}
