import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearTokenCache,
  getToken,
  marketsharpRequest,
  MarketSharpAuthError,
  MarketSharpForbiddenError,
  renderBody,
  MAX_RESPONSE_CHARS,
  vendorMessage,
} from '../client.js';

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
    expect(init.redirect).toBe('error');
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

  it('adds api-version, sends the bearer token and renders JSON', async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: 'tk' })).mockResolvedValueOnce(json([{ id: 1 }]));
    const out = await marketsharpRequest(creds, { method: 'GET', path: '/companies/123/divisions', query: { a: 'b', skip: undefined } });
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://restapi.marketsharpm.com/companies/123/divisions?a=b&api-version=2.0');
    expect(init.headers.Authorization).toBe('Bearer tk');
    expect(init.redirect).toBe('error');
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
    await expect(marketsharpRequest(creds, { method: 'GET', path: '/companies/../x' })).rejects.toThrow('Invalid MarketSharp path');
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
