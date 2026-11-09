/**
 * The only path to MarketSharp. The host is a compile-time constant (never
 * tenant-supplied), so there is no base-URL or DNS-pinning layer. What
 * remains is the request contract:
 * - redirect: 'manual', and every 3xx is an error (the token never leaves the host);
 * - the URL is built from an already-encoded path and checked to stay on
 *   https://restapi.marketsharpm.com at exactly that path;
 * - response bodies are bounded while streaming;
 * - vendor errors keep HTTP status, MarketSharp's message and any request id.
 */
import { createHash } from 'node:crypto';
import { MAX_RESPONSE_CHARS } from './input-limits.js';
import { scopedCredentials } from './scope.js';
import { wrapVendorDetail } from './untrusted.js';
import { logger } from './utils/logger.js';
import type { MarketSharpCredentials } from './types.js';

/** MarketSharp has one REST host. It is fixed so no caller can redirect credentials elsewhere. */
export const MARKETSHARP_BASE_URL = 'https://restapi.marketsharpm.com';
export const MARKETSHARP_API_VERSION = '2.0';

const TOKEN_TIMEOUT_MS = 15_000;
const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const MAX_BACKOFF_MS = 10_000;
/** Used when /token omits expires_in. Kept short because the TTL is undocumented. */
const DEFAULT_TOKEN_TTL_S = 15 * 60;
/** Refresh this long before the reported expiry. */
const TOKEN_SKEW_S = 60;
/** Upper bound on any upstream response body, enforced while streaming and before parsing. */
export const MAX_UPSTREAM_BYTES = 4 * 1024 * 1024;
/** Error and /token bodies are small; read at most this much of them. */
const MAX_SMALL_BODY_BYTES = 64 * 1024;
const MAX_SEGMENT = 256;
/** Response headers that may carry a request id for MarketSharp support (which one MarketSharp sends is undocumented). */
const REQUEST_ID_HEADERS = ['x-request-id', 'request-id', 'x-correlation-id'];
export { MAX_RESPONSE_CHARS };
export { runWithCredentials } from './scope.js';

let gatewayMode = false;

/**
 * Set by the HTTP server at startup. In gateway mode MARKETSHARP_* env is never
 * read. Irreversible in practice: nothing but tests turns it off.
 */
export function setGatewayMode(on: boolean): void {
  gatewayMode = on;
}

/**
 * Fails closed: the HTTP server's lock, or any AUTH_MODE other than unset or
 * exactly 'env' (including typos), means gateway, so env credentials are
 * never used by mistake. Stdio with AUTH_MODE unset uses env.
 */
function isGatewayMode(env: NodeJS.ProcessEnv): boolean {
  if (gatewayMode) return true;
  const raw = (env.AUTH_MODE ?? '').trim();
  return raw !== '' && raw !== 'env';
}

export function getCredentials(env: NodeJS.ProcessEnv = process.env): MarketSharpCredentials | null {
  const scoped = scopedCredentials();
  if (scoped) return scoped;
  if (isGatewayMode(env)) {
    logger.warn('Missing request-scoped MarketSharp credentials in gateway mode; MARKETSHARP_* env is never read');
    return null;
  }
  const companyId = env.MARKETSHARP_COMPANY_ID?.trim();
  const apiKey = env.MARKETSHARP_API_KEY?.trim();
  const apiSecret = env.MARKETSHARP_API_SECRET?.trim();
  const employeeId = env.MARKETSHARP_EMPLOYEE_ID?.trim() || undefined;
  if (!companyId || !apiKey || !apiSecret) {
    logger.warn('Missing MarketSharp credentials', {
      hasCompanyId: !!companyId,
      hasApiKey: !!apiKey,
      hasApiSecret: !!apiSecret,
    });
    return null;
  }
  return { companyId, apiKey, apiSecret, employeeId };
}

// ---------------------------------------------------------------------------
// Errors. Messages never include credential values or the bearer token; the
// dispatcher also redacts them as a second line of defence.
// ---------------------------------------------------------------------------
export class MarketSharpAuthError extends Error {}
export class MarketSharpForbiddenError extends Error {}
export class MarketSharpRateLimitError extends Error {}
export class MarketSharpApiError extends Error {
  constructor(message: string, readonly status?: number, readonly requestId?: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Token cache, keyed by a hash of the full credential set so two tenants (or
// a rotated secret) never share a token and the key itself reveals nothing.
// ---------------------------------------------------------------------------
interface CachedToken {
  token: string;
  expiresAt: number;
}
const tokenCache = new Map<string, CachedToken>();
const inflight = new Map<string, Promise<string>>();
const MAX_CACHED_TOKENS = 500;

export function credentialCacheKey(c: MarketSharpCredentials): string {
  return createHash('sha256')
    .update([c.companyId, c.apiKey, c.apiSecret, c.employeeId ?? ''].join('\u0000'))
    .digest('hex');
}

/** Test hook. */
export function clearTokenCache(): void {
  tokenCache.clear();
  inflight.clear();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** Pull a short human message out of MarketSharp's {meta:{message}, response} envelope or an OAuth error. */
export function vendorMessage(text: string): string | undefined {
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const meta = body.meta as { message?: unknown } | undefined;
    const candidates = [
      meta?.message,
      body.error_description,
      body.error,
      body.Message,
      body.message,
      typeof body.response === 'string' ? body.response : undefined,
    ];
    const found = candidates.find((c) => typeof c === 'string' && c.trim().length > 0) as string | undefined;
    return found?.slice(0, 300);
  } catch {
    return undefined;
  }
}

/** Ends a sentence: ": detail." (no doubled period when the detail already ends in punctuation) or just ".". */
function detailSuffix(detail: string | undefined): string {
  if (!detail) return '.';
  const d = detail.trim();
  return `: ${wrapVendorDetail(d)}${/[.!?]$/.test(d) ? '' : '.'}`;
}

/** The first request id header MarketSharp sent, shape-limited so it can't carry anything else. */
function vendorRequestId(res: Response): string | undefined {
  for (const name of REQUEST_ID_HEADERS) {
    const v = res.headers.get(name)?.trim();
    if (v && /^[A-Za-z0-9._:-]{1,128}$/.test(v)) return v;
  }
  return undefined;
}

/** Logs why a fetch failed (error name and cause code only: no URL, headers, body or credentials). */
function logFetchFailure(message: string, method: string, err: unknown): void {
  logger.warn(message, {
    method,
    name: (err as Error)?.name,
    code: (err as { cause?: { code?: unknown } })?.cause?.code,
  });
}

function isRedirect(res: Response): boolean {
  return (res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect';
}

async function refuseRedirect(res: Response): Promise<never> {
  await res.body?.cancel().catch(() => undefined);
  throw new MarketSharpApiError(`MarketSharp answered with a redirect (HTTP ${res.status}); refusing to follow it.`, res.status);
}

/** Reads a response body as text, cancelling the stream as soon as it exceeds maxBytes. */
async function readBoundedText(res: Response, maxBytes: number): Promise<string> {
  const tooLarge = () =>
    new MarketSharpApiError(
      `MarketSharp's response exceeded ${maxBytes} bytes. Narrow the request: use filters, a smaller page size, or fewer records.`,
    );
  const declared = Number.parseInt(res.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function mintToken(c: MarketSharpCredentials): Promise<string> {
  const form = new URLSearchParams({
    grant_type: 'password',
    companyId: c.companyId,
    apikey: c.apiKey,
    apisecret: c.apiSecret,
  });
  if (c.employeeId) form.set('empoid', c.employeeId);
  let res: Response;
  try {
    res = await fetch(`${MARKETSHARP_BASE_URL}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form.toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (err) {
    logFetchFailure('MarketSharp sign-in request failed', 'POST', err);
    throw new MarketSharpApiError(
      "Couldn't reach MarketSharp to sign in. Check your network and try again in a few minutes."
    );
  }
  if (isRedirect(res)) await refuseRedirect(res);
  const text = await readBoundedText(res, MAX_SMALL_BODY_BYTES).catch(() => '');
  if (!res.ok) {
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      const detail = vendorMessage(text);
      throw new MarketSharpAuthError(
        `MarketSharp rejected the Company ID, API key or API secret (HTTP ${res.status})` +
          detailSuffix(detail) +
          ' Check the key and secret under Admin → Apps & Add-ons Setup → API maintenance in MarketSharp.'
      );
    }
    throw new MarketSharpApiError(`MarketSharp sign-in failed on MarketSharp's side (HTTP ${res.status}). Try again in a few minutes.`, res.status);
  }
  let token: unknown;
  let expiresIn: unknown;
  const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
  let parsed: unknown;
  let isJson = true;
  try {
    parsed = JSON.parse(text);
  } catch {
    isJson = false;
  }
  if (isJson && typeof parsed === 'string') {
    // A JSON-encoded string body ("eyJ..."): the string itself is the token.
    if (JWT_SHAPE.test(parsed.trim())) token = parsed.trim();
  } else if (isJson && parsed && typeof parsed === 'object') {
    const body = parsed as Record<string, unknown>;
    // The 200 schema is undocumented: accept the OAuth shape, a bare `token`,
    // or either nested under MarketSharp's `response` envelope.
    const inner = (body.response && typeof body.response === 'object' ? body.response : {}) as Record<string, unknown>;
    token = body.access_token ?? body.token ?? inner.access_token ?? inner.token;
    expiresIn = body.expires_in ?? inner.expires_in;
  } else if (!isJson) {
    // A bare (unquoted) JWT body.
    const bare = text.trim();
    if (JWT_SHAPE.test(bare)) token = bare;
  }
  if (typeof token !== 'string' || token.length === 0) {
    throw new MarketSharpApiError("MarketSharp's sign-in response didn't include an access token.", res.status);
  }
  const ttl = typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : Number(expiresIn) > 0 ? Number(expiresIn) : DEFAULT_TOKEN_TTL_S;
  const key = credentialCacheKey(c);
  if (tokenCache.size >= MAX_CACHED_TOKENS) tokenCache.clear();
  tokenCache.set(key, { token, expiresAt: Date.now() + Math.max(30, ttl - TOKEN_SKEW_S) * 1000 });
  return token;
}

export async function getToken(c: MarketSharpCredentials, forceRefresh = false): Promise<string> {
  const key = credentialCacheKey(c);
  if (!forceRefresh) {
    const hit = tokenCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.token;
  } else {
    tokenCache.delete(key);
  }
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = mintToken(c).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export interface MarketSharpRequest {
  method: 'GET' | 'POST';
  /** Path relative to the host, every dynamic segment already passed through encodeSegment(). */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

/**
 * Returns one URL path segment, percent-encoded. Rejects anything that could
 * change which endpoint is hit: empty, `.`, `..`, `/` or `\`, percent-encoded
 * separators or dots, and control characters. buildUrl() also checks the
 * final URL against the expected path.
 */
export function encodeSegment(value: unknown, name: string): string {
  const s = String(value ?? '').trim();
  if (!s) throw new MarketSharpApiError(`${name} is required.`);
  if (
    s.length > MAX_SEGMENT ||
    s === '.' ||
    s === '..' ||
    /[/\\]/.test(s) ||
    /%(2f|5c|2e)/i.test(s) ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(s)
  ) {
    throw new MarketSharpApiError(`${name} is not a valid id: use a single MarketSharp id (1-${MAX_SEGMENT} characters) without ".", "..", "/" or "\\".`);
  }
  return encodeURIComponent(s);
}

/** Builds the request URL on the fixed origin and refuses anything that doesn't land at exactly `path`. */
export function buildUrl(path: string, query: MarketSharpRequest['query'] = {}): URL {
  const invalid = () => new MarketSharpApiError('Invalid MarketSharp path.');
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('..') || path.includes('\\')) throw invalid();
  const url = new URL(path, MARKETSHARP_BASE_URL);
  if (url.origin !== MARKETSHARP_BASE_URL || url.pathname !== path) throw invalid();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }
  url.searchParams.set('api-version', MARKETSHARP_API_VERSION);
  return url;
}

/** Render a response body for the model: pretty JSON when parseable, capped in size. */
export function renderBody(text: string): string {
  if (!text) return 'OK (no content)';
  let out = text;
  try {
    out = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // not JSON: return as text
  }
  if (out.length > MAX_RESPONSE_CHARS) {
    return (
      out.slice(0, MAX_RESPONSE_CHARS) +
      `\n…[truncated ${out.length - MAX_RESPONSE_CHARS} characters. Narrow the request: use filters, a smaller page size, or fewer records.]`
    );
  }
  return out;
}

/**
 * Call MarketSharp with a cached bearer token. A 401 triggers exactly one
 * token refresh and retry; 429 (any method) and 503 (GET only) back off
 * (Retry-After honored). A 503 on a POST (searches, filtered lists and the
 * create tools) is returned, not retried, since a create may already have
 * been saved. Redirects are refused so the bearer token never leaves restapi.marketsharpm.com.
 */
export async function marketsharpRequest(creds: MarketSharpCredentials | null, req: MarketSharpRequest): Promise<string> {
  if (!creds) {
    throw new MarketSharpAuthError(
      'MarketSharp credentials are not configured. Set the Company ID, API key and API secret on this connection.'
    );
  }
  const url = buildUrl(req.path, req.query).toString();
  const body = req.body === undefined ? undefined : JSON.stringify(req.body);
  const timeout = req.method === 'GET' ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS;
  let refreshed = false;

  for (let attempt = 0; ; attempt++) {
    const token = await getToken(creds, false);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(url, { method: req.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
    } catch (err) {
      logFetchFailure('MarketSharp request failed', req.method, err);
      const timedOut = (err as Error).name === 'TimeoutError';
      throw new MarketSharpApiError(
        timedOut ? "Couldn't reach MarketSharp: it didn't respond in time." : "Couldn't reach MarketSharp: the connection failed."
      );
    }
    if (isRedirect(res)) await refuseRedirect(res);

    if (res.status === 401 && !refreshed) {
      await res.body?.cancel().catch(() => undefined);
      refreshed = true;
      await getToken(creds, true);
      continue;
    }
    // 429 means MarketSharp rejected the request, so any method may retry.
    // A 503 can come from a proxy after the backend already saved a POST, and
    // the POST upserts here create new records, so only GETs retry on 503.
    const retryable = res.status === 429 || (res.status === 503 && req.method === 'GET');
    if (retryable && attempt < MAX_RETRIES) {
      await res.body?.cancel().catch(() => undefined);
      const wait = parseRetryAfter(res.headers.get('retry-after')) ?? 1000 * 2 ** attempt;
      await sleep(Math.min(wait, MAX_BACKOFF_MS));
      continue;
    }
    if (!res.ok) throw await vendorError(res);
    return renderBody(await readBoundedText(res, MAX_UPSTREAM_BYTES));
  }
}

async function vendorError(res: Response): Promise<Error> {
  const text = await readBoundedText(res, MAX_SMALL_BODY_BYTES).catch(() => '');
  const suffix = detailSuffix(vendorMessage(text));
  const requestId = vendorRequestId(res);
  const rid = requestId ? ` (MarketSharp request id: ${requestId})` : '';
  const status = res.status;
  if (status === 401) {
    return new MarketSharpAuthError(`MarketSharp didn't accept this connection's sign-in (HTTP 401)${suffix} Check the Company ID, API key, API secret and Employee ID on this connection.${rid}`);
  }
  if (status === 403) {
    return new MarketSharpForbiddenError(
      `MarketSharp says this API key or employee doesn't have permission for that (HTTP 403)${suffix} Ask a MarketSharp admin to give the connection's employee that permission, or use a different Employee ID.${rid}`
    );
  }
  if (status === 429) {
    return new MarketSharpRateLimitError(`MarketSharp is rate-limiting this connection (HTTP 429). Try again shortly.${rid}`);
  }
  if (status === 404) {
    return new MarketSharpApiError(`MarketSharp couldn't find that record (HTTP 404)${suffix} Check the ID, or look the record up with marketsharp_search_global.${rid}`, 404, requestId);
  }
  // The "problem on its side" wording is for server-side failures; other statuses (e.g. 400) keep the neutral text.
  return new MarketSharpApiError(
    (status >= 500 ? `MarketSharp had a problem on its side (HTTP ${status})${suffix}` : `MarketSharp returned HTTP ${status}${suffix}`) + rid,
    status,
    requestId
  );
}
