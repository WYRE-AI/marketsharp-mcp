/**
 * Output hygiene for anything returned to the model or written to logs.
 * The API key and secret in use are removed by exact match; bearer tokens and
 * JWTs (the MarketSharp access token) are removed by shape.
 */

export const REDACTED = '[REDACTED]';

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
