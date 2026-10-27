import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
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
/** Cap on the text handed back to the model. */
export const MAX_RESPONSE_CHARS = 200_000;

// ---------------------------------------------------------------------------
// Request-scoped credentials. Gateway mode runs each HTTP request inside
// runWithCredentials(); stdio / AUTH_MODE=env fall back to process.env.
// ---------------------------------------------------------------------------
const credStore = new AsyncLocalStorage<MarketSharpCredentials>();

export function runWithCredentials<T>(creds: MarketSharpCredentials, fn: () => T): T {
  return credStore.run(creds, fn);
}

export function getCredentials(env: NodeJS.ProcessEnv = process.env): MarketSharpCredentials | null {
  const scoped = credStore.getStore();
  if (scoped) return scoped;
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
// Errors. Messages never include credential values or the bearer token.
// ---------------------------------------------------------------------------
export class MarketSharpAuthError extends Error {}
export class MarketSharpForbiddenError extends Error {}
export class MarketSharpRateLimitError extends Error {}
export class MarketSharpApiError extends Error {
  constructor(message: string, readonly status?: number) {
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
  return `: ${d}${/[.!?]$/.test(d) ? '' : '.'}`;
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
      redirect: 'error',
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch {
    throw new MarketSharpApiError(
      "Couldn't reach MarketSharp to sign in. Check your network and try again in a few minutes."
    );
  }
  const text = await res.text().catch(() => '');
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
  /** Path relative to the host, already encoded, e.g. /companies/123/contacts/abc. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export function encodeSegment(value: unknown, name: string): string {
  const s = String(value ?? '').trim();
  if (!s) throw new MarketSharpApiError(`${name} is required.`);
  if (s === '.' || s === '..') throw new MarketSharpApiError(`${name} is not a valid id.`);
  return encodeURIComponent(s);
}

function buildUrl(req: MarketSharpRequest): string {
  if (!req.path.startsWith('/') || req.path.includes('..') || req.path.includes('//')) {
    throw new MarketSharpApiError('Invalid MarketSharp path.');
  }
  const url = new URL(MARKETSHARP_BASE_URL + req.path);
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }
  url.searchParams.set('api-version', MARKETSHARP_API_VERSION);
  return url.toString();
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
  const url = buildUrl(req);
  const body = req.body === undefined ? undefined : JSON.stringify(req.body);
  const timeout = req.method === 'GET' ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS;
  let refreshed = false;

  for (let attempt = 0; ; attempt++) {
    const token = await getToken(creds, false);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(url, { method: req.method, headers, body, redirect: 'error', signal: AbortSignal.timeout(timeout) });
    } catch (err) {
      const timedOut = (err as Error).name === 'TimeoutError';
      throw new MarketSharpApiError(
        timedOut ? "Couldn't reach MarketSharp: it didn't respond in time." : "Couldn't reach MarketSharp: the connection failed."
      );
    }

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
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      const detail = vendorMessage(text);
      const suffix = detailSuffix(detail);
      if (res.status === 401) {
        throw new MarketSharpAuthError(`MarketSharp didn't accept this connection's sign-in (HTTP 401)${suffix} Check the Company ID, API key, API secret and Employee ID on this connection.`);
      }
      if (res.status === 403) {
        throw new MarketSharpForbiddenError(
          `MarketSharp says this API key or employee doesn't have permission for that (HTTP 403)${suffix} Ask a MarketSharp admin to give the connection's employee that permission, or use a different Employee ID.`
        );
      }
      if (res.status === 429) {
        throw new MarketSharpRateLimitError('MarketSharp is rate-limiting this connection (HTTP 429). Try again shortly.');
      }
      if (res.status === 404) {
        throw new MarketSharpApiError(`MarketSharp couldn't find that record (HTTP 404)${suffix} Check the ID, or look the record up with marketsharp_search_global.`, 404);
      }
      // The "problem on its side" wording is for server-side failures; other statuses (e.g. 400) keep the neutral text.
      throw new MarketSharpApiError(
        res.status >= 500
          ? `MarketSharp had a problem on its side (HTTP ${res.status})${suffix}`
          : `MarketSharp returned HTTP ${res.status}${suffix}`,
        res.status
      );
    }
    return renderBody(text);
  }
}
