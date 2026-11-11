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
import { setTimeout as sleep } from 'node:timers/promises';
import { MAX_RESPONSE_CHARS } from './input-limits.js';
import { redactText, redactValue } from './redact.js';
import { callerSignal, rememberToken, scopedCredentials, withUpstreamSlot } from './scope.js';
import { wrapVendorDetail } from './untrusted.js';
import { logger } from './utils/logger.js';
import type { MarketSharpCredentials } from './types.js';

/** MarketSharp has one REST host. It is fixed so no caller can redirect credentials elsewhere. */
export const MARKETSHARP_BASE_URL = 'https://restapi.marketsharpm.com';
export const MARKETSHARP_API_VERSION = '2.0';

const TOKEN_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;
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
/** Longest piece of MarketSharp's own error text quoted in an error message. */
const MAX_VENDOR_DETAIL = 300;
/** Values removed by exact match from anything MarketSharp sends back: the key, the secret and the access token in use. */
type Secrets = readonly (string | undefined)[];
/** Response headers that may carry a request id for MarketSharp support (which one MarketSharp sends is undocumented). */
const REQUEST_ID_HEADERS = ['x-request-id', 'request-id', 'x-correlation-id'];
export { MAX_RESPONSE_CHARS };
export { runInRequestScope, runWithCredentials } from './scope.js';

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
/** Base of every error whose message is written to be safe to show the model. Anything else is reported generically. */
export class MarketSharpError extends Error {}
export class MarketSharpAuthError extends MarketSharpError {}
export class MarketSharpForbiddenError extends MarketSharpError {}
export class MarketSharpRateLimitError extends MarketSharpError {}
export class MarketSharpApiError extends MarketSharpError {
  constructor(message: string, readonly status?: number, readonly requestId?: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Token cache, keyed by a hash of the full credential set so two tenants (or
// a rotated secret) never share a token and the key itself reveals nothing.
// A sign-in refused with 400/401/403 is remembered briefly under the same key,
// so a tenant with a wrong or revoked key doesn't make a /token call per tool
// call. It lives in the same map, so the same cap bounds both.
// ---------------------------------------------------------------------------
type CachedToken = { expiresAt: number } & ({ token: string } | { error: MarketSharpAuthError });
const tokenCache = new Map<string, CachedToken>();
const inflight = new Map<string, Promise<string>>();
const MAX_CACHED_TOKENS = 500;
/** How long a rejected sign-in is remembered. Short, so a corrected key works again quickly. */
const FAILED_MINT_TTL_MS = 45_000;

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

/** The per-attempt timeout, plus the caller's disconnect when this runs inside an HTTP request. */
function requestSignal(timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  const caller = callerSignal();
  return caller ? AbortSignal.any([caller, timeout]) : timeout;
}

const CANCELLED = 'The request was cancelled before MarketSharp answered.';

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
    const message = candidates.find((c) => typeof c === 'string' && c.trim().length > 0) as string | undefined;
    return message === undefined ? undefined : `${message}${modelStateDetail(body.ModelState)}`;
  } catch {
    return undefined;
  }
}

/**
 * ASP.NET model-binding 400s say only "The request is invalid." and put the
 * reason in ModelState ({ "model.field": ["error", ...] }). Returns the first
 * field and error as " field: error", or "". The caller redacts and truncates.
 */
function modelStateDetail(modelState: unknown): string {
  if (!modelState || typeof modelState !== 'object') return '';
  for (const [field, errors] of Object.entries(modelState as Record<string, unknown>)) {
    const first = Array.isArray(errors) ? errors.find((e) => typeof e === 'string' && e.trim()) : undefined;
    if (first) return ` ${field}: ${first.trim()}`;
  }
  return '';
}

/**
 * Ends a sentence: ": detail." (no doubled period when the detail already
 * ends in punctuation) or just ".". The vendor text is redacted before it is
 * cut to MAX_VENDOR_DETAIL and escaped, so no part of a secret survives.
 */
function detailSuffix(detail: string | undefined, secrets: Secrets): string {
  const d = detail === undefined ? '' : redactText(detail, secrets).trim().slice(0, MAX_VENDOR_DETAIL);
  if (!d) return '.';
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

/**
 * Reads a response body as text, cancelling the stream as soon as it exceeds
 * maxBytes. With a signal, an abort cancels the stream and rejects with the
 * signal's reason, so a stalled body can't hold its caller forever.
 */
async function readBoundedText(res: Response, maxBytes: number, signal?: AbortSignal): Promise<string> {
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
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    if (!signal) return;
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => undefined); // never an unhandled rejection when the read wins
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw tooLarge();
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err;
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
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
      // Not the caller's signal: concurrent callers share this mint (inflight).
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
      const error = new MarketSharpAuthError(
        `MarketSharp rejected the Company ID, API key or API secret (HTTP ${res.status})` +
          detailSuffix(vendorMessage(text), [c.apiKey, c.apiSecret]) +
          ' Check the key and secret under Admin → Apps & Add-ons Setup → API maintenance in MarketSharp.'
      );
      cacheEntry(credentialCacheKey(c), { error, expiresAt: Date.now() + FAILED_MINT_TTL_MS });
      throw error;
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
  cacheEntry(credentialCacheKey(c), { token, expiresAt: Date.now() + Math.max(30, ttl - TOKEN_SKEW_S) * 1000 });
  return token;
}

function cacheEntry(key: string, entry: CachedToken): void {
  tokenCache.delete(key);
  makeRoomInTokenCache();
  tokenCache.set(key, entry);
}

/**
 * Full cache: drop expired tokens, then the oldest (Map keeps mint order),
 * so one busy period never makes every tenant re-mint at once.
 */
function makeRoomInTokenCache(): void {
  if (tokenCache.size < MAX_CACHED_TOKENS) return;
  const now = Date.now();
  for (const [key, cached] of tokenCache) if (cached.expiresAt <= now) tokenCache.delete(key);
  const oldest = tokenCache.keys().next();
  if (tokenCache.size >= MAX_CACHED_TOKENS && !oldest.done) tokenCache.delete(oldest.value);
}

export async function getToken(c: MarketSharpCredentials, forceRefresh = false): Promise<string> {
  const key = credentialCacheKey(c);
  if (!forceRefresh) {
    const hit = tokenCache.get(key);
    if (hit && hit.expiresAt > Date.now()) {
      if ('error' in hit) throw hit.error;
      return hit.token;
    }
  } else {
    tokenCache.delete(key);
  }
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = mintToken(c).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** The page a paged list tool asked for, and the names of its paging arguments. */
export interface Paging {
  pageArg: string;
  page: number;
  sizeArg: string;
  size: number;
}

export interface MarketSharpRequest {
  /** Only the READ_ROUTES for that method are sent; anything else is refused before sign-in. */
  method: 'GET' | 'POST';
  /** Path relative to the host, every dynamic segment already passed through encodeSegment(). */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Set by paged list tools, so a response cut to fit can name the exact request that reads on. */
  paging?: Paging;
}

/** MarketSharp ids are numbers or GUIDs: the same shape http.ts requires of the company and employee ids. */
const ID_PATTERN = '[A-Za-z0-9-]{1,64}';
const ID_RE = new RegExp(`^${ID_PATTERN}$`);

const route = (template: string) => new RegExp(`^${template.replaceAll('{id}', ID_PATTERN)}$`);

/**
 * The only routes this server calls ({id} is one path segment). MarketSharp
 * serves its searches and filtered lists as POST, and not every GET is a pure
 * read (one "opens the existing work order for editing"), so both methods are
 * allowlisted. Anything else is refused before a token is minted, so no tool
 * (or future bug) can write to MarketSharp.
 */
const READ_ROUTES: Record<MarketSharpRequest['method'], RegExp[]> = {
  GET: [
    '/companies',
    '/companies/{id}',
    '/companies/{id}/contacts/{id}',
    '/companies/{id}/contacts/{id}/inquiries',
    '/companies/{id}/inquiries/{id}', // also /inquiries/statuses
    '/companies/{id}/opportunities/{id}/notes/Inquiry',
    '/companies/{id}/opportunities/{id}/notes/Job',
    '/companies/{id}/appointments/{id}',
    '/companies/{id}/appointments/contacts/{id}',
    '/companies/{id}/appointments/results/active',
    '/companies/{id}/appointments/resultreasons/active',
    '/companies/{id}/jobs/{id}',
    '/companies/{id}/notes/contact/{id}',
    '/companies/{id}/notes/notetype/{id}/contact/{id}',
    '/companies/{id}/activities/types',
    '/companies/{id}/employees',
    '/companies/{id}/primaryleadsources',
    '/companies/{id}/primaryleadsources/active',
    '/companies/{id}/primaryleadsources/{id}/secondaryleadsources',
    '/companies/{id}/primaryleadsources/{id}/secondaryleadsources/active',
    '/companies/{id}/products/interests/true',
    '/companies/{id}/products/interests/false',
    '/companies/{id}/products/interests/leads/{id}',
    '/companies/{id}/divisions',
  ].map(route),
  POST: [
    '/companies/{id}/search/global',
    '/companies/{id}/contacts/search',
    '/companies/{id}/contacts/filter',
    '/companies/{id}/inquiries/search',
    '/companies/{id}/inquiries/filter',
    '/companies/{id}/appointments/filter',
    '/companies/{id}/jobs/search',
    '/companies/{id}/jobs/opportunities',
  ].map(route),
};

export function isReadOnlyRequest(req: Pick<MarketSharpRequest, 'method' | 'path'>): boolean {
  return READ_ROUTES[req.method]?.some((r) => r.test(req.path)) ?? false;
}

function assertReadOnly(req: MarketSharpRequest): void {
  if (isReadOnlyRequest(req)) return;
  throw new MarketSharpApiError('This server is read-only: that MarketSharp request is not a read, so it was not sent.');
}


/**
 * Returns one URL path segment. Only letters, digits and dashes are accepted,
 * so nothing (dots, separators, encoded or look-alike characters, `?`, `#`)
 * can change which endpoint is hit. buildUrl() also checks the final URL
 * against the expected path.
 */
export function encodeSegment(value: unknown, name: string): string {
  const s = String(value ?? '').trim();
  if (!s) throw new MarketSharpApiError(`${name} is required.`);
  if (!ID_RE.test(s)) {
    throw new MarketSharpApiError(`${name} is not a valid id: use a single MarketSharp id (1-64 letters, digits or dashes).`);
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

/** Where a list response keeps its records: the body itself, or one of these fields (SimplePagingModel uses `rows`). */
const LIST_FIELDS = ['rows', 'response', 'data', 'items'] as const;

/** Envelope fields a page object may sit under, e.g. {meta, response: {pageNumber, rows}}. */
const ENVELOPE_FIELDS = ['response', 'data'] as const;

interface List {
  records: unknown[];
  /** The whole response rebuilt with only the first n records. */
  keep: (n: number) => unknown;
}

/** The records of a list response: the body itself, a list field, or a list field one envelope level down. */
function listOf(value: unknown, nested = true): List | undefined {
  if (Array.isArray(value)) return { records: value, keep: (n) => value.slice(0, n) };
  if (!value || typeof value !== 'object') return undefined;
  const page = value as Record<string, unknown>;
  const field = LIST_FIELDS.find((f) => Array.isArray(page[f]));
  if (field) {
    const records = page[field] as unknown[];
    return { records, keep: (n) => ({ ...page, [field]: records.slice(0, n) }) };
  }
  if (!nested) return undefined;
  for (const outer of ENVELOPE_FIELDS) {
    const inner = listOf(page[outer], false);
    if (inner) return { records: inner.records, keep: (n) => ({ ...page, [outer]: inner.keep(n) }) };
  }
  return undefined;
}

/**
 * What to tell the model after keeping the first `kept` of `total` records.
 * A paged tool gets the exact request that reads on from the first record
 * left out: the largest page size up to `kept` whose pages line up with that
 * record. Any other tool can't reach the rest, so it is told to narrow.
 */
function truncationNote(kept: number, total: number, paging?: Paging): string {
  const head = `\n…[truncated: only the first ${kept} of ${total} records`;
  if (!paging) {
    return `${head} fit; the other ${total - kept} were left out and this tool can't page past them. Narrow the request with this tool's filters to see them.]`;
  }
  const next = (paging.page - 1) * paging.size + kept; // 0-based offset of the first record left out
  let size = kept;
  while (next % size !== 0) size--;
  return (
    `${head} in this page fit; the other ${total - kept} were left out. To read on without a gap, ` +
    `call again with ${paging.pageArg}=${next / size + 1} and ${paging.sizeArg}=${size}, and keep ${paging.sizeArg}=${size} for the pages after that.]`
  );
}

/**
 * Fits an oversized list response under the cap by dropping whole records
 * from the end. Every other field (pageNumber, totalPageCount, meta) is kept,
 * and the note says how many records were left out, so the model never
 * mistakes a cut page for the last one. Undefined when not even one record
 * fits, so the caller's text cut still shows part of it.
 */
function shrinkList(value: unknown, render: (v: unknown) => string, paging?: Paging): string | undefined {
  const list = listOf(value);
  if (!list || list.records.length === 0 || render(list.keep(1)).length > MAX_RESPONSE_CHARS) return undefined;
  // Output length only grows with n, so binary-search the largest n that fits.
  let lo = 1;
  let hi = list.records.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (render(list.keep(mid)).length <= MAX_RESPONSE_CHARS) lo = mid;
    else hi = mid - 1;
  }
  return render(list.keep(lo)) + truncationNote(lo, list.records.length, paging);
}

/**
 * Render a response body for the model: pretty JSON when parseable, redacted
 * of `secrets` and credential-named fields, then capped in size. Redaction
 * runs first so a secret straddling the cap can't leave a prefix behind. An
 * oversized list keeps whole records and its paging fields; anything else is
 * cut as text.
 */
export function renderBody(text: string, secrets: Secrets = [], paging?: Paging): string {
  if (!text) return 'OK (no content)';
  const render = (v: unknown) => redactText(JSON.stringify(v, null, 2), secrets);
  let value: unknown;
  let out: string;
  try {
    value = redactValue(JSON.parse(text), secrets);
    out = render(value);
  } catch {
    // not JSON: return as text
    out = redactText(text, secrets);
  }
  if (out.length <= MAX_RESPONSE_CHARS) return out;
  return (
    shrinkList(value, render, paging) ??
    out.slice(0, MAX_RESPONSE_CHARS) +
      `\n…[truncated ${out.length - MAX_RESPONSE_CHARS} characters. Narrow the request: use filters, a smaller page size, or fewer records.]`
  );
}

/** What one upstream attempt came to: a rendered body, a wait before retrying, or a token refresh to do. */
type Attempt = { text: string } | { wait: number } | 'refresh';

/**
 * Call MarketSharp with a cached bearer token. A 401 triggers exactly one
 * token refresh and retry; 429 (any method) and 503 (GET only) back off
 * (Retry-After honored). A 503 on a POST (searches and filtered lists) is
 * returned, not retried: POST is not assumed idempotent. Redirects are
 * refused so the bearer token never leaves restapi.marketsharpm.com.
 */
export async function marketsharpRequest(creds: MarketSharpCredentials | null, req: MarketSharpRequest): Promise<string> {
  assertReadOnly(req);
  if (!creds) {
    throw new MarketSharpAuthError(
      'MarketSharp credentials are not configured. Set the Company ID, API key and API secret on this connection.'
    );
  }
  const url = buildUrl(req.path, req.query).toString();
  const body = req.body === undefined ? undefined : JSON.stringify(req.body);
  let refreshed = false;

  for (let attempt = 0; ; attempt++) {
    if (callerSignal()?.aborted) throw new MarketSharpApiError(CANCELLED);
    const token = await getToken(creds, false);
    rememberToken(token);
    const secrets: Secrets = [creds.apiKey, creds.apiSecret, token];
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    // One slot covers the fetch and the whole body read, so a batch of calls in
    // one request never has more than a few connections or bodies open. A retry's
    // wait and the token refresh happen after the slot is released.
    let outcome: Attempt;
    try {
      outcome = await withUpstreamSlot(async (): Promise<Attempt> => {
        const signal = requestSignal(REQUEST_TIMEOUT_MS);
        const res = await fetch(url, { method: req.method, headers, body, redirect: 'manual', signal });
        if (isRedirect(res)) await refuseRedirect(res);
        if (res.status === 401 && !refreshed) {
          await res.body?.cancel().catch(() => undefined);
          return 'refresh';
        }
        // 429 means MarketSharp rejected the request, so any method may retry.
        // A 503 can come from a proxy after the backend already handled a POST,
        // and POST is not assumed idempotent, so only GETs retry on 503.
        const retryable = res.status === 429 || (res.status === 503 && req.method === 'GET');
        if (retryable && attempt < MAX_RETRIES) {
          await res.body?.cancel().catch(() => undefined);
          return { wait: Math.min(parseRetryAfter(res.headers.get('retry-after')) ?? 1000 * 2 ** attempt, MAX_BACKOFF_MS) };
        }
        if (!res.ok) throw await vendorError(res, secrets, signal);
        return { text: renderBody(await readBoundedText(res, MAX_UPSTREAM_BYTES, signal), secrets, req.paging) };
      });
    } catch (err) {
      if (err instanceof MarketSharpError) throw err;
      // A failed fetch, or a body that broke or timed out while being read.
      if (callerSignal()?.aborted) throw new MarketSharpApiError(CANCELLED);
      logFetchFailure('MarketSharp request failed', req.method, err);
      const timedOut = (err as Error).name === 'TimeoutError';
      throw new MarketSharpApiError(
        timedOut ? "Couldn't reach MarketSharp: it didn't respond in time." : "Couldn't reach MarketSharp: the connection failed."
      );
    }

    if (outcome === 'refresh') {
      refreshed = true;
      await getToken(creds, true);
      continue;
    }
    if ('wait' in outcome) {
      await sleep(outcome.wait, undefined, { signal: callerSignal() }).catch(() => {
        throw new MarketSharpApiError(CANCELLED);
      });
      continue;
    }
    return outcome.text;
  }
}

async function vendorError(res: Response, secrets: Secrets, signal: AbortSignal): Promise<Error> {
  const text = await readBoundedText(res, MAX_SMALL_BODY_BYTES, signal).catch(() => '');
  const suffix = detailSuffix(vendorMessage(text), secrets);
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
