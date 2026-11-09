import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearTokenCache,
  getCredentials,
  setGatewayMode,
  runWithCredentials,
  getToken,
  marketsharpRequest,
  MarketSharpAuthError,
  MarketSharpForbiddenError,
  renderBody,
  MAX_RESPONSE_CHARS,
  vendorMessage,
} from '../client.js';
import { runInRequestScope } from '../scope.js';
import { logger } from '../utils/logger.js';

const creds = { companyId: '123', apiKey: 'key-abc', apiSecret: 'sec-xyz' };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

describe('client', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    clearTokenCache();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('mints a token with application auth (form-encoded, no empoid unless set) and refuses redirects', async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: 't1', expires_in: 3600 }));
    expect(await getToken(creds)).toBe('t1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://restapi.marketsharpm.com/token');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(init.body);
    expect(Object.fromEntries(form)).toEqual({ grant_type: 'password', companyId: '123', apikey: 'key-abc', apisecret: 'sec-xyz' });
  });

  it('sends empoid when an employee id is set', async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: 't1' }));
    await getToken({ ...creds, employeeId: '55' });
    expect(new URLSearchParams(fetchMock.mock.calls[0][1].body).get('empoid')).toBe('55');
  });

  it('accepts a bare token or one nested in the response envelope', async () => {
    fetchMock.mockResolvedValueOnce(json({ token: 'bare' }));
    expect(await getToken(creds)).toBe('bare');
    clearTokenCache();
    fetchMock.mockResolvedValueOnce(json({ meta: {}, response: { access_token: 'nested' } }));
    expect(await getToken(creds)).toBe('nested');
  });

  it('uses a JSON-encoded string body as the token', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2ln';
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(jwt), { status: 200 }));
    expect(await getToken(creds)).toBe(jwt);
  });

  it('uses a bare unquoted JWT body as the token', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2ln';
    fetchMock.mockResolvedValueOnce(new Response(`${jwt}\n`, { status: 200 }));
    expect(await getToken(creds)).toBe(jwt);
  });

  it.each([JSON.stringify('not a jwt'), JSON.stringify(''), 'null', '42', 'not json at all'])(
    'rejects a sign-in body with no usable token (%s)',
    async (body) => {
      fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));
      await expect(getToken(creds)).rejects.toThrow("didn't include an access token");
    },
  );

  describe('503 retries', () => {
    const okThen = (first: Response) => {
      fetchMock.mockReset();
      let n = 0;
      fetchMock.mockImplementation(async (url: string) => {
        if (String(url).endsWith('/token')) return json({ access_token: 'tk' });
        n += 1;
        return n === 1 ? first : json({ id: 'ok' });
      });
      return () => fetchMock.mock.calls.filter(([u]) => !String(u).endsWith('/token')).length;
    };
    const busy = (status: number) => new Response('busy', { status, headers: { 'Retry-After': '0' } });

    it('does not retry a POST after a 503, so a POST is never sent twice', async () => {
      const vendorCalls = okThen(busy(503));
      await expect(marketsharpRequest(creds, { method: 'POST', path: '/companies/123/contacts/search', body: { last_name: 'Smith' } })).rejects.toThrow('HTTP 503');
      expect(vendorCalls()).toBe(1);
    });

    it('still retries a GET after a 503', async () => {
      const vendorCalls = okThen(busy(503));
      expect(await marketsharpRequest(creds, { method: 'GET', path: '/companies/123' })).toContain('ok');
      expect(vendorCalls()).toBe(2);
    });

    it('still retries a POST after a 429, which MarketSharp rejected outright', async () => {
      const vendorCalls = okThen(busy(429));
      expect(await marketsharpRequest(creds, { method: 'POST', path: '/companies/123/contacts/search', body: { last_name: 'Smith' } })).toContain('ok');
      expect(vendorCalls()).toBe(2);
    });
  });

  it('caches tokens per credential set and shares one in-flight mint', async () => {
    fetchMock.mockImplementation(async () => json({ access_token: 'shared', expires_in: 3600 }));
    const [a, b] = await Promise.all([getToken(creds), getToken(creds)]);
    expect(a).toBe('shared');
    expect(b).toBe('shared');
    await getToken(creds);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await getToken({ ...creds, apiSecret: 'rotated' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('re-mints after expiry', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => json({ access_token: 't', expires_in: 120 }));
    await getToken(creds);
    vi.advanceTimersByTime(61_000);
    await getToken(creds);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('maps a rejected sign-in to an auth error without echoing the secret', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'invalid_grant', error_description: 'The api key is invalid.' }, 400));
    const err = await getToken(creds).catch((e) => e);
    expect(err).toBeInstanceOf(MarketSharpAuthError);
    expect(err.message).toContain('API maintenance');
    expect(err.message).toContain('The api key is invalid.');
    expect(err.message).not.toContain('sec-xyz');
  });

  it('rejects a 200 sign-in without a token', async () => {
    fetchMock.mockResolvedValueOnce(json({}));
    await expect(getToken(creds)).rejects.toThrow("didn't include an access token");
  });

  describe('getCredentials', () => {
    const ENV = { MARKETSHARP_COMPANY_ID: '9', MARKETSHARP_API_KEY: 'k', MARKETSHARP_API_SECRET: 's' } as NodeJS.ProcessEnv;
    afterEach(() => setGatewayMode(false));

    it('reads env credentials when not in gateway mode', () => {
      expect(getCredentials(ENV)).toMatchObject({ companyId: '9', apiKey: 'k', apiSecret: 's' });
    });

    it('returns null in gateway mode even with env credentials and no scoped store', () => {
      setGatewayMode(true);
      expect(getCredentials(ENV)).toBeNull();
    });

    it('AUTH_MODE=gateway never reads env credentials, even over stdio (fails closed)', () => {
      expect(getCredentials({ ...ENV, AUTH_MODE: 'gateway' })).toBeNull();
      expect(getCredentials({ ...ENV, AUTH_MODE: 'env' })).toMatchObject({ companyId: '9' });
    });

    it('still returns scoped credentials in gateway mode', () => {
      setGatewayMode(true);
      expect(runWithCredentials(creds, () => getCredentials(ENV))).toEqual(creds);
    });
  });

  it('adds api-version, sends the bearer token and renders JSON', async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: 'tk' })).mockResolvedValueOnce(json([{ id: 1 }]));
    const out = await marketsharpRequest(creds, { method: 'GET', path: '/companies/123/divisions', query: { a: 'b', skip: undefined } });
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://restapi.marketsharpm.com/companies/123/divisions?a=b&api-version=2.0');
    expect(init.headers.Authorization).toBe('Bearer tk');
    expect(init.redirect).toBe('manual');
    expect(JSON.parse(out)).toEqual([{ id: 1 }]);
  });

  it('refreshes the token once on 401, then surfaces a second 401', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ access_token: 'old' }))
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json({ access_token: 'new' }))
      .mockResolvedValueOnce(json({ ok: true }));
    await marketsharpRequest(creds, { method: 'GET', path: '/companies/123' });
    expect(fetchMock.mock.calls[3][1].headers.Authorization).toBe('Bearer new');

    clearTokenCache();
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(json({ access_token: 'a' }))
      .mockResolvedValueOnce(json({ meta: { message: 'Denied' } }, 401))
      .mockResolvedValueOnce(json({ access_token: 'b' }))
      .mockResolvedValueOnce(json({ meta: { message: 'Denied' } }, 401));
    await expect(marketsharpRequest(creds, { method: 'GET', path: '/companies/123' })).rejects.toBeInstanceOf(MarketSharpAuthError);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('retries 429 with Retry-After', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ access_token: 'tk' }))
      .mockResolvedValueOnce(json({}, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(json({ ok: 1 }));
    await marketsharpRequest(creds, { method: 'GET', path: '/companies/123' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('maps 403 with the vendor message', async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: 'tk' })).mockResolvedValueOnce(json({ meta: { message: 'Employee id required' } }, 403));
    const err = await marketsharpRequest(creds, { method: 'POST', path: '/companies/123/contacts/search', body: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(MarketSharpForbiddenError);
    expect(err.message).toContain('Employee id required');
  });

  it('refuses traversal in paths and missing credentials', async () => {
    // '/companies/..' matches the /companies/{id} route, so this reaches buildUrl's own check.
    await expect(marketsharpRequest(creds, { method: 'GET', path: '/companies/..' })).rejects.toThrow('Invalid MarketSharp path');
    await expect(marketsharpRequest(creds, { method: 'GET', path: '/companies/../x' })).rejects.toThrow('read-only');
    await expect(marketsharpRequest(null, { method: 'GET', path: '/companies' })).rejects.toThrow('not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caps very large bodies', () => {
    const big = 'x'.repeat(MAX_RESPONSE_CHARS + 10);
    expect(renderBody(big)).toContain('truncated 10 characters');
    expect(renderBody('')).toBe('OK (no content)');
  });

  it('extracts vendor messages from the envelope', () => {
    expect(vendorMessage('{"meta":{"message":"ApiKey is required."},"response":"denied"}')).toBe('ApiKey is required.');
    expect(vendorMessage('<html>')).toBeUndefined();
  });
});

describe('client hardening', () => {
  const fetchMock = vi.fn();
  const GET = { method: 'GET', path: '/companies/123' } as const;
  beforeEach(() => {
    clearTokenCache();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('aborts the in-flight MarketSharp fetch when the caller goes away', async () => {
    const caller = new AbortController();
    let seen: AbortSignal | undefined;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (String(url).endsWith('/token')) return json({ access_token: 'tk' });
      seen = init.signal ?? undefined;
      return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    });
    const pending = runInRequestScope({ creds, signal: caller.signal }, () => marketsharpRequest(creds, GET));
    await vi.waitFor(() => expect(seen).toBeDefined());
    caller.abort();
    await expect(pending).rejects.toThrow('cancelled');
    expect(seen?.aborted).toBe(true);
  });

  it('stops a 429 backoff when the caller goes away and sends nothing more', async () => {
    const caller = new AbortController();
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith('/token') ? json({ access_token: 'tk' }) : json({}, 429, { 'retry-after': '10' }),
    );
    const started = Date.now();
    const pending = runInRequestScope({ signal: caller.signal }, () => marketsharpRequest(creds, GET));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    caller.abort();
    await expect(pending).rejects.toThrow('cancelled');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('redacts an opaque (non-JWT) access token from log lines by exact match', async () => {
    const opaque = 'opaqueTokenValue0123456789';
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith('/token') ? json({ access_token: opaque }) : json({ ok: 1 }),
    );
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    await runWithCredentials(creds, async () => {
      await marketsharpRequest(creds, GET);
      logger.warn(`token was ${opaque}`, { token: opaque });
    });
    expect(lines.join('\n')).not.toContain(opaque);
    expect(lines.join('\n')).toContain('[REDACTED]');
  });

  const tenant = (i: number) => ({ ...creds, companyId: String(i) });

  it('when the token cache is full, evicts only the oldest token instead of every tenant', async () => {
    let n = 0;
    fetchMock.mockImplementation(async () => json({ access_token: `t${n++}`, expires_in: 3600 }));
    for (let i = 0; i <= 500; i++) await getToken(tenant(i));
    expect(fetchMock).toHaveBeenCalledTimes(501);
    await getToken(tenant(1));
    await getToken(tenant(500));
    expect(fetchMock).toHaveBeenCalledTimes(501);
    await getToken(tenant(0));
    expect(fetchMock).toHaveBeenCalledTimes(502);
  });

  it('when the token cache is full, evicts expired tokens before live ones', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const id = new URLSearchParams(String(init.body)).get('companyId');
      return json({ access_token: `t${id}`, expires_in: id === '1' ? 120 : 3600 });
    });
    for (let i = 0; i < 500; i++) await getToken(tenant(i));
    vi.advanceTimersByTime(61_000);
    await getToken(tenant(500));
    expect(fetchMock).toHaveBeenCalledTimes(501);
    // tenant 0 (oldest, still live) survives; tenant 1 (expired) was the one dropped.
    await getToken(tenant(0));
    expect(fetchMock).toHaveBeenCalledTimes(501);
  });

  it('names the first ModelState field error on an ASP.NET 400', async () => {
    const body = {
      Message: 'The request is invalid.',
      ModelState: { 'model.start_modified_datetime': [`The value 'x${creds.apiSecret}' is not valid for start_modified_datetime.`] },
    };
    expect(vendorMessage(JSON.stringify(body))).toBe(
      `The request is invalid. model.start_modified_datetime: The value 'x${creds.apiSecret}' is not valid for start_modified_datetime.`,
    );
    fetchMock.mockResolvedValueOnce(json({ access_token: 'tk' })).mockResolvedValueOnce(json(body, 400));
    const err = await marketsharpRequest(creds, { method: 'POST', path: '/companies/123/contacts/filter', body: {} }).catch((e) => e);
    expect(err.message).toContain('HTTP 400');
    expect(err.message).toContain('model.start_modified_datetime');
    expect(err.message).not.toContain(creds.apiSecret);
  });
});
