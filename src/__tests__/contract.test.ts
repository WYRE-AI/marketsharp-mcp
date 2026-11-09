/**
 * Template security contract (fleet parity with anthropic-admin-mcp):
 * exact auth headers, redaction, redirect refusal, path-segment validation,
 * fixed origin + exact path, bounded reads, pagination passthrough, error
 * mapping with the vendor request id, header-only gateway credentials, and
 * reduce-only tool tiers. No network: fetch is always stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildUrl,
  clearTokenCache,
  encodeSegment,
  getCredentials,
  getToken,
  MAX_UPSTREAM_BYTES,
  marketsharpRequest,
  runWithCredentials,
  setGatewayMode,
} from '../client.js';
import { ALL_TIERS, configuredTiers, narrowTiers } from '../config.js';
import { REDACTED, redactText } from '../redact.js';
import { dispatchToolCall, listTools, pickDeclaredArgs, TOOLS } from '../tools/index.js';
import { logger } from '../utils/logger.js';

const API_KEY = 'ms-key-6c1f0e2a-not-real';
const API_SECRET = 'ms-secret-9b7d4c3e-not-real';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0LW5vdC1yZWFsIn0.c2lnbmF0dXJlLW5vdC1yZWFs';
const creds = { companyId: '123', apiKey: API_KEY, apiSecret: API_SECRET };
const BASE = 'https://restapi.marketsharpm.com';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const fetchMock = vi.fn();
beforeEach(() => {
  clearTokenCache();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setGatewayMode(false);
});

/** Token requests succeed with JWT; every other request goes through `vendor`. */
function vendor(reply: (url: string, init: RequestInit) => Response | Promise<Response>) {
  fetchMock.mockImplementation(async (url: string, init: RequestInit) =>
    String(url).endsWith('/token') ? json({ access_token: JWT, expires_in: 3600 }) : reply(String(url), init),
  );
}

const vendorCalls = () => fetchMock.mock.calls.filter(([u]) => !String(u).endsWith('/token'));

async function run(name: string, args: Record<string, unknown> = {}) {
  const result = await runWithCredentials(creds, () => dispatchToolCall(name, args, {} as NodeJS.ProcessEnv));
  return { result, text: result.content[0].text };
}

describe('exact auth headers', () => {
  it('/token gets exactly the form fields and headers, and no credential goes in a URL', async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: JWT }));
    await getToken({ ...creds, employeeId: '55' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/token`);
    expect(init.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' });
    expect(Object.fromEntries(new URLSearchParams(init.body))).toEqual({
      grant_type: 'password',
      companyId: '123',
      apikey: API_KEY,
      apisecret: API_SECRET,
      empoid: '55',
    });
    expect(url).not.toContain(API_KEY);
  });

  it('a GET read sends only Authorization: Bearer and Accept', async () => {
    vendor(() => json([]));
    await run('marketsharp_divisions_list');
    const [url, init] = vendorCalls()[0];
    expect(url).toBe(`${BASE}/companies/123/divisions?api-version=2.0`);
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ Authorization: `Bearer ${JWT}`, Accept: 'application/json' });
    expect(init.body).toBeUndefined();
  });

  it('a query POST read adds only Content-Type: application/json', async () => {
    vendor(() => json([]));
    await run('marketsharp_search_global', { query: 'smith' });
    const [, init] = vendorCalls()[0];
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: `Bearer ${JWT}`, Accept: 'application/json', 'Content-Type': 'application/json' });
  });
});

describe('credential redaction', () => {
  it('redactText removes known secrets, bearer tokens and JWTs', () => {
    const out = redactText(`key=${API_KEY} secret=${API_SECRET} Authorization: Bearer abc.def-ghi ${JWT}`, [API_KEY, API_SECRET]);
    expect(out).not.toContain(API_KEY);
    expect(out).not.toContain(API_SECRET);
    expect(out).not.toContain('abc.def-ghi');
    expect(out).not.toContain(JWT);
    expect(out).toContain(REDACTED);
  });

  it('a vendor error that echoes the credentials is redacted in the tool error', async () => {
    vendor(() => json({ meta: { message: `bad apikey ${API_KEY} / ${API_SECRET} token ${JWT}` } }, 400));
    const { result, text } = await run('marketsharp_divisions_list');
    expect(result.isError).toBe(true);
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(API_SECRET);
    expect(text).not.toContain(JWT);
    expect(text).toContain(REDACTED);
  });

  it('a rejected sign-in that echoes the secret is redacted', async () => {
    fetchMock.mockResolvedValue(json({ error_description: `apisecret ${API_SECRET} is wrong` }, 400));
    const { text } = await run('marketsharp_divisions_list');
    expect(text).toContain('rejected');
    expect(text).not.toContain(API_SECRET);
  });

  it('a successful body that echoes a credential is redacted', async () => {
    vendor(() => json({ name: 'Main', leaked: API_SECRET }));
    const { result, text } = await run('marketsharp_divisions_list');
    expect(result.isError).toBeFalsy();
    expect(text).toContain('Main');
    expect(text).not.toContain(API_SECRET);
  });

  it('logs redact the request-scoped and env credentials and bearer tokens', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: string) => void lines.push(line));
    process.env.MARKETSHARP_API_SECRET = 'env-secret-must-not-log-1234';
    try {
      runWithCredentials(creds, () => logger.warn(`oops ${API_KEY}`, { s: API_SECRET, auth: `Bearer ${JWT}` }));
      logger.error('env leak env-secret-must-not-log-1234');
    } finally {
      delete process.env.MARKETSHARP_API_SECRET;
    }
    const all = lines.join('\n');
    expect(all).toContain('oops');
    for (const s of [API_KEY, API_SECRET, JWT, 'env-secret-must-not-log-1234']) expect(all).not.toContain(s);
  });
});

describe('redirects are refused', () => {
  it('a 3xx on /token is an error and is not followed', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://evil.example.net/token' } }));
    await expect(getToken(creds)).rejects.toThrow(/redirect/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].redirect).toBe('manual');
  });

  it('a 3xx on a read is an error and is not followed', async () => {
    vendor(() => new Response(null, { status: 301, headers: { location: 'https://evil.example.net/x' } }));
    const { result, text } = await run('marketsharp_divisions_list');
    expect(result.isError).toBe(true);
    expect(text).toMatch(/redirect/i);
    expect(vendorCalls()).toHaveLength(1);
    expect(vendorCalls()[0][1].redirect).toBe('manual');
    expect(fetchMock.mock.calls.every(([u]) => String(u).startsWith(BASE))).toBe(true);
  });
});

describe('path parameters', () => {
  it.each(['..', '.', '../x', 'a/b', 'a\\b', '%2e%2e', '%2F', 'a%5Cb', 'a\u0000b', 'a\nb', '   ', 'x'.repeat(257)])(
    'rejects %j before any request',
    async (bad) => {
      vendor(() => json({}));
      const { result } = await run('marketsharp_contacts_get', { contactId: bad });
      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('percent-encodes a legal id', async () => {
    expect(encodeSegment('a b?c#d', 'contactId')).toBe('a%20b%3Fc%23d');
    vendor(() => json({}));
    await run('marketsharp_contacts_get', { contactId: 'a b?c' });
    expect(vendorCalls()[0][0]).toBe(`${BASE}/companies/123/contacts/a%20b%3Fc?api-version=2.0`);
  });

  it('every built URL stays on the fixed origin at exactly the requested path', () => {
    expect(buildUrl('/companies/123/divisions').toString()).toBe(`${BASE}/companies/123/divisions?api-version=2.0`);
    for (const bad of ['/companies/%2e%2e/x', '//evil.example.net/x', '/companies/../token', 'companies', '/a\\b']) {
      expect(() => buildUrl(bad), bad).toThrow();
    }
  });
});

describe('array params', () => {
  // MarketSharp has no array query parameters, so there is no bracket form to
  // send; the one array (inquiry_ids) goes as a JSON array in the POST body.
  it('inquiryIds goes as a JSON body array and is capped at the documented 100', async () => {
    vendor(() => json([]));
    await run('marketsharp_appointments_list', { inquiryIds: ['i1', 'i2'] });
    const [url, init] = vendorCalls()[0];
    expect(url).toBe(`${BASE}/companies/123/appointments/filter?api-version=2.0`);
    expect(JSON.parse(init.body as string).inquiry_ids).toEqual(['i1', 'i2']);

    const { result } = await run('marketsharp_appointments_list', { inquiryIds: Array.from({ length: 101 }, (_, i) => `i${i}`) });
    expect(result.isError).toBe(true);
    expect(vendorCalls()).toHaveLength(1);
  });
});

describe('pagination is passed through, never auto-paged', () => {
  it('body paging goes through as given and only one request is made', async () => {
    vendor(() => json(Array.from({ length: 50 }, (_, i) => ({ id: i }))));
    await run('marketsharp_contacts_list', { pageNumber: 3, rowsPerPage: 50 });
    expect(vendorCalls()).toHaveLength(1);
    expect(JSON.parse(vendorCalls()[0][1].body as string)).toMatchObject({ pageNumber: 3, rowsPerPage: 50 });
  });

  it('page sizes above the cap are capped, not rejected', async () => {
    vendor(() => json([]));
    await run('marketsharp_inquiries_list', { rowsPerPage: 50_000 });
    expect(JSON.parse(vendorCalls()[0][1].body as string).rowsPerPage).toBe(1000);
    await run('marketsharp_employees_list', { page: 2, pageSize: 9_999 });
    const url = new URL(String(vendorCalls()[1][0]));
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('pageSize')).toBe('500');
    expect(vendorCalls()).toHaveLength(2);
  });

  it('enums are validated before any request', async () => {
    vendor(() => json([]));
    const { result } = await run('marketsharp_inquiry_notes_list', { inquiryId: 'i1', noteType: 'Bogus' });
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('bounded upstream reads', () => {
  it('a declared body over the cap is refused without reading it', async () => {
    vendor(() => new Response('x', { status: 200, headers: { 'content-length': String(MAX_UPSTREAM_BYTES + 1) } }));
    const { result, text } = await run('marketsharp_divisions_list');
    expect(result.isError).toBe(true);
    expect(text).toMatch(/exceeded/);
  });

  it('a streamed body over the cap is cut off', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(120);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_UPSTREAM_BYTES + chunk.byteLength) return controller.close();
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    vendor(() => new Response(stream, { status: 200 }));
    const { result, text } = await run('marketsharp_divisions_list');
    expect(result.isError).toBe(true);
    expect(text).toMatch(/exceeded/);
    expect(sent).toBeLessThanOrEqual(MAX_UPSTREAM_BYTES + 2 * chunk.byteLength);
  });
});

describe('error mapping', () => {
  it.each([
    [400, /HTTP 400/],
    [403, /permission/],
    [404, /couldn't find/],
    [500, /problem on its side/],
  ])('HTTP %i maps to a clear message with the vendor request id', async (status, re) => {
    vendor(() => json({ meta: { message: 'nope' } }, status, { 'x-request-id': 'req-ms-0042' }));
    const { result, text } = await run('marketsharp_divisions_list');
    expect(result.isError).toBe(true);
    expect(text).toMatch(re);
    expect(text).toContain('req-ms-0042');
  });

  it('works without a request id', async () => {
    vendor(() => json({}, 400));
    const { text } = await run('marketsharp_divisions_list');
    expect(text).toMatch(/HTTP 400/);
    expect(text).not.toMatch(/request id/i);
  });
});

describe('gateway mode reads credentials only from headers', () => {
  const ENV = { MARKETSHARP_COMPANY_ID: '9', MARKETSHARP_API_KEY: 'k', MARKETSHARP_API_SECRET: 's' } as NodeJS.ProcessEnv;

  it('ignores env credentials once the HTTP server locked gateway mode', () => {
    setGatewayMode(true);
    expect(getCredentials(ENV)).toBeNull();
  });

  it.each(['gateway', ' Gateway ', 'gatway', 'anything'])('AUTH_MODE=%j fails closed to gateway outside HTTP too', (mode) => {
    expect(getCredentials({ ...ENV, AUTH_MODE: mode })).toBeNull();
  });

  it('unset or AUTH_MODE=env uses env credentials (stdio)', () => {
    expect(getCredentials(ENV)).toMatchObject({ companyId: '9' });
    expect(getCredentials({ ...ENV, AUTH_MODE: 'env' })).toMatchObject({ companyId: '9' });
  });

  it('a tool call in gateway mode with no scoped credentials never calls MarketSharp', async () => {
    setGatewayMode(true);
    const result = await dispatchToolCall('marketsharp_divisions_list', {}, ENV);
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('tool tiers', () => {
  it('read is the only tier, and tools/list is 25 read-only tools', () => {
    expect([...ALL_TIERS]).toEqual(['read']);
    expect([...configuredTiers()]).toEqual(['read']);
    const tools = listTools();
    expect(tools).toHaveLength(25);
    for (const t of tools) {
      expect(TOOLS.find((d) => d.name === t.name)!.tier, t.name).toBe('read');
      expect(t.annotations, t.name).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
  });

  it('MARKETSHARP_ENABLE_WRITES is not read and adds no tier', () => {
    vi.stubEnv('MARKETSHARP_ENABLE_WRITES', 'true');
    try {
      expect([...configuredTiers()]).toEqual(['read']);
      expect(listTools()).toHaveLength(25);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('the tier header only narrows; present-but-empty means zero tools', () => {
    const all = configuredTiers();
    expect([...narrowTiers(all, undefined)]).toEqual(['read']);
    expect([...narrowTiers(all, 'read')]).toEqual(['read']);
    expect([...narrowTiers(all, ' READ , admin')]).toEqual(['read']);
    expect([...narrowTiers(all, 'read,write')]).toEqual(['read']);
    expect([...narrowTiers(all, 'write')]).toEqual([]);
    expect([...narrowTiers(all, '')]).toEqual([]);
    expect(listTools(narrowTiers(all, ''))).toEqual([]);
  });

  it('a tool outside the narrowed tiers is an unknown tool and never calls MarketSharp', async () => {
    const res = await runWithCredentials(creds, () => dispatchToolCall('marketsharp_divisions_list', {}, {} as NodeJS.ProcessEnv, new Set()));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe('Error: Unknown tool: marketsharp_divisions_list');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('undeclared arguments are dropped before the tool runs', () => {
    const tool = TOOLS.find((t) => t.name === 'marketsharp_contacts_get')!;
    expect(pickDeclaredArgs(tool, { contactId: 'c1', baseUrl: 'https://evil.example.net', id: 'x' })).toEqual({ contactId: 'c1' });
    expect(pickDeclaredArgs(tool, ['nope'])).toEqual({});
  });
});

describe('one mocked end-to-end read', () => {
  it('marketsharp_contacts_get mints a token, reads the contact and wraps it as untrusted', async () => {
    vendor(() => json({ id: 'c1', firstName: 'Pat', lastName: 'Example' }));
    const { result, text } = await run('marketsharp_contacts_get', { contactId: 'c1' });
    expect(result.isError).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/token`);
    expect(vendorCalls()[0][0]).toBe(`${BASE}/companies/123/contacts/c1?api-version=2.0`);
    expect(text).toContain('<untrusted-content nonce=');
    expect(text).toContain('"firstName": "Pat"');
  });
});

describe('client guards', () => {
  it('marketsharpRequest refuses a path that is not exactly what was built', async () => {
    await expect(marketsharpRequest(creds, { method: 'GET', path: '/companies/%2e%2e/token' })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
