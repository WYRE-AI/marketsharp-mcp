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
  MAX_RESPONSE_CHARS,
  MAX_UPSTREAM_BYTES,
  marketsharpRequest,
  renderBody,
  runWithCredentials,
  setGatewayMode,
} from '../client.js';
import { ALL_TIERS, configuredTiers, narrowTiers } from '../config.js';
import { REDACTED, redactText } from '../redact.js';
import { dispatchToolCall, listTools, pickDeclaredArgs, TOOLS } from '../tools/index.js';
import { logger } from '../utils/logger.js';
import { unwrapToolText } from './unwrap.js';

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

  describe('redacts before escaping and truncating', () => {
    const SPECIAL = { companyId: '123', apiKey: 'KEY-abcdef-0123456789', apiSecret: 'Sec<ret&Value>1234567890abcdef' };
    const TAIL = '1234567890abcdef';
    const runAs = async (name: string) =>
      (await runWithCredentials(SPECIAL, () => dispatchToolCall(name, {}, {} as NodeJS.ProcessEnv))).content[0].text;

    it('a vendor error echoing a secret with & < > is redacted, raw or escaped', async () => {
      vendor(() => json({ meta: { message: `bad secret ${SPECIAL.apiSecret}` } }, 401));
      const text = await runAs('marketsharp_divisions_list');
      expect(text).not.toContain(TAIL);
      expect(text).toContain(REDACTED);
    });

    it('a rejected sign-in echoing a secret with & < > is redacted', async () => {
      fetchMock.mockResolvedValue(json({ error_description: `apisecret ${SPECIAL.apiSecret} is wrong` }, 400));
      const text = await runAs('marketsharp_divisions_list');
      expect(text).toContain('rejected');
      expect(text).not.toContain(TAIL);
    });

    it('a vendor error message cut at 300 characters keeps no prefix of a secret', async () => {
      vendor(() => json({ meta: { message: 'm'.repeat(296) + SPECIAL.apiKey } }, 400));
      expect(await runAs('marketsharp_divisions_list')).not.toContain('KEY-');
    });

    it('a secret straddling the response cap keeps no prefix', async () => {
      vendor(() => new Response('x'.repeat(MAX_RESPONSE_CHARS - 4) + SPECIAL.apiKey + 'y'.repeat(100)));
      const text = await runAs('marketsharp_divisions_list');
      expect(text).toContain('[truncated');
      expect(text).not.toContain('KEY-');
    });

    it('values under credential-named keys are redacted in JSON bodies', async () => {
      vendor(() =>
        json({ name: 'Main', apiKey: 'other-key-value-1', Password: 'hunter2hunter2', nested: [{ client_secret: 'cs-value-123' }], authorization: 'Basic abc' }),
      );
      const text = await runAs('marketsharp_divisions_list');
      expect(JSON.parse(unwrapToolText(text))).toEqual({
        name: 'Main',
        apiKey: REDACTED,
        Password: REDACTED,
        nested: [{ client_secret: REDACTED }],
        authorization: REDACTED,
      });
    });

    it('a bare `token` and keys ending in password or secret are redacted too', async () => {
      vendor(() =>
        json({ settings: { token: 'opaque-tok-1', smtpPassword: 'smtp-pass-1', webhook_secret: 'wh-secret-1', tokenType: 'bearer', passwordHint: 'pet' } }),
      );
      const text = await runAs('marketsharp_companies_get');
      expect(JSON.parse(unwrapToolText(text))).toEqual({
        settings: { token: REDACTED, smtpPassword: REDACTED, webhook_secret: REDACTED, tokenType: 'bearer', passwordHint: 'pet' },
      });
    });

    it('an opaque (non-JWT) access token echoed back is redacted, in results and errors', async () => {
      const OPAQUE = 'opaque-token-value-42';
      fetchMock.mockImplementation(async (url: string) =>
        String(url).endsWith('/token') ? json({ access_token: OPAQUE }) : json({ echoed: `token=${OPAQUE}` }),
      );
      expect(await runAs('marketsharp_divisions_list')).not.toContain(OPAQUE);
      clearTokenCache();
      fetchMock.mockImplementation(async (url: string) =>
        String(url).endsWith('/token') ? json({ access_token: OPAQUE }) : json({ meta: { message: `token ${OPAQUE} denied` } }, 403),
      );
      const error = await runAs('marketsharp_divisions_list');
      expect(error).toContain('HTTP 403');
      expect(error).not.toContain(OPAQUE);
    });
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
  it.each([
    '..', '.', '../x', 'a/b', 'a\\b', '%2e%2e', '%2F', 'a%5Cb', 'a\u0000b', 'a\nb', '   ', 'x'.repeat(65),
    // Not separators, but not MarketSharp ids either: fullwidth dots, U+2215, query and fragment characters, spaces.
    '．．', 'a∕b', 'a?b', 'a#b', 'a b', 'a_b',
  ])(
    'rejects %j before any request',
    async (bad) => {
      vendor(() => json({}));
      const { result } = await run('marketsharp_contacts_get', { contactId: bad });
      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('accepts MarketSharp ids (numbers and GUIDs, up to 64 characters)', async () => {
    const guid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    expect(encodeSegment(' 12345 ', 'contactId')).toBe('12345');
    expect(encodeSegment(guid, 'contactId')).toBe(guid);
    expect(encodeSegment('x'.repeat(64), 'contactId')).toBe('x'.repeat(64));
    vendor(() => json({}));
    await run('marketsharp_contacts_get', { contactId: guid });
    expect(vendorCalls()[0][0]).toBe(`${BASE}/companies/123/contacts/${guid}?api-version=2.0`);
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

  // A silently lowered page size would break "fewer rows than rowsPerPage means
  // the last page" and "exactly numberOfRecords means narrow", so oversize is an error.
  it.each([
    ['marketsharp_contacts_list', { rowsPerPage: 5_000 }, 'from 1 to 1000'],
    ['marketsharp_inquiries_list', { rowsPerPage: 1_001 }, 'from 1 to 1000'],
    ['marketsharp_appointments_list', { rowsPerPage: 5_000 }, 'from 1 to 1000'],
    ['marketsharp_opportunities_list', { fromDate: '2026-01-01', numberOfRecords: 5_000 }, 'from 1 to 1000'],
    ['marketsharp_employees_list', { pageSize: 9_999 }, 'from 1 to 500'],
    ['marketsharp_contacts_search', { last_name: 'x', numberOfRecords: 501 }, 'from 1 to 500'],
    ['marketsharp_search_global', { query: 'x', numberOfRecords: 201 }, 'from 1 to 200'],
  ] as const)('%s rejects a page size above its maximum before any request', async (name, args, range) => {
    vendor(() => json([]));
    const { result, text } = await run(name, args);
    expect(result.isError).toBe(true);
    expect(text).toContain(range);
    expect(vendorCalls()).toHaveLength(0);
  });

  it('page sizes at the maximum go through unchanged', async () => {
    vendor(() => json([]));
    await run('marketsharp_inquiries_list', { rowsPerPage: 1000 });
    expect(JSON.parse(vendorCalls()[0][1].body as string).rowsPerPage).toBe(1000);
    await run('marketsharp_employees_list', { page: 2, pageSize: 500 });
    const url = new URL(String(vendorCalls()[1][0]));
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('pageSize')).toBe('500');
  });

  // numberOfRecords is a non-nullable int32 on the QuickFind models, so leaving it out sends 0.
  it.each([
    ['marketsharp_contacts_search', { last_name: 'smith' }],
    ['marketsharp_inquiries_search', { last_name: 'smith' }],
    ['marketsharp_jobs_search', { job_number: '42' }],
  ] as const)('%s sends an explicit numberOfRecords (25) when none is given', async (name, args) => {
    vendor(() => json([]));
    await run(name, args);
    expect(JSON.parse(vendorCalls()[0][1].body as string).numberOfRecords).toBe(25);
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

describe('no write path to MarketSharp', () => {
  it.each([
    '/companies/123/contacts',
    '/companies/123/appointments',
    '/companies/123/opportunities/notes',
    '/companies/123/contacts/search/extra',
    '/companies/123/employees/filter',
  ])('refuses POST %s before signing in', async (path) => {
    vendor(() => json([]));
    await expect(marketsharpRequest(creds, { method: 'POST', path, body: {} })).rejects.toThrow('read-only');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Not every MarketSharp GET is a pure read ("Opens the existing work order for editing").
  it.each([
    '/companies/123/printfile/workorder/1',
    '/companies/123/contacts/c1/extra',
    '/companies/123/inquiries/i1/notes',
    '/companies/123/products/interests/maybe',
    '/token',
  ])('refuses GET %s, which no tool uses, before signing in', async (path) => {
    vendor(() => json([]));
    await expect(marketsharpRequest(creds, { method: 'GET', path })).rejects.toThrow('read-only');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('refuses %s before signing in', async (method) => {
    vendor(() => json([]));
    const req = { method, path: '/companies/123/contacts/c1' } as unknown as Parameters<typeof marketsharpRequest>[1];
    await expect(marketsharpRequest(creds, req)).rejects.toThrow('read-only');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('every tool sends a GET, or a POST to one of the read-only search and filter routes', async () => {
    vendor(() => json([]));
    for (const tool of TOOLS) {
      const args = Object.fromEntries(
        Object.entries(tool.inputSchema.properties).map(([k, p]) => {
          const prop = p as { type?: string; enum?: unknown[]; minimum?: number };
          return [k, prop.enum?.[0] ?? (prop.type === 'integer' ? (prop.minimum ?? 1) : prop.type === 'boolean' ? true : prop.type === 'array' ? ['x'] : 'x')];
        }),
      );
      const { result } = await run(tool.name, args);
      expect(result.isError, `${tool.name}: ${result.content[0].text}`).toBeFalsy();
    }
    expect(vendorCalls()).toHaveLength(TOOLS.length);
    for (const [, init] of vendorCalls()) expect(['GET', 'POST']).toContain(init.method);
  });
});

describe('pagination-safe truncation', () => {
  const NOTE = /\n…\[truncated: only the first (\d+) of (\d+) records/;
  const RESUME = /call again with (\w+)=(\d+) and (\w+)=(\d+)/;
  const record = (i: number, size = 500) => ({ id: `r${i}`, notes: 'n'.repeat(size) });
  const split = (text: string) => {
    const at = text.search(NOTE);
    expect(at, 'no record-count truncation note').toBeGreaterThan(0);
    const [, kept, total] = NOTE.exec(text)!;
    return { body: JSON.parse(text.slice(0, at)), kept: Number(kept), total: Number(total), note: text.slice(at) };
  };
  /** The page and size a resume note names, checked to continue exactly after the last kept record. */
  const resume = (note: string, kept: number, pageArg: string, sizeArg: string, firstSkipped: number) => {
    const m = RESUME.exec(note);
    expect(m, `no resume request in: ${note}`).not.toBeNull();
    const [, p, page, s, size] = m!;
    expect([p, s]).toEqual([pageArg, sizeArg]);
    expect(Number(size)).toBeGreaterThan(0);
    expect(Number(size)).toBeLessThanOrEqual(kept);
    // 0-based offset of the first record that page returns.
    expect((Number(page) - 1) * Number(size)).toBe(firstSkipped);
    return { page: Number(page), size: Number(size) };
  };

  it('an oversized unpaged array keeps whole records and says the rest cannot be paged to', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => record(i));
    const text = renderBody(JSON.stringify(rows));
    const { body, kept, total, note } = split(text);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(kept);
    expect(body[kept - 1]).toEqual(record(kept - 1));
    expect(total).toBe(1000);
    expect(kept).toBeGreaterThan(0);
    expect(text.length - note.length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    expect(note).toContain(`the other ${1000 - kept} were left out`);
    expect(note).toContain("can't page past them");
    expect(note).not.toMatch(/rowsPerPage|pageSize|numberOfRecords|at most/);
  });

  it.each(['rows', 'response', 'data', 'items'])('an oversized page keeps its paging fields and shrinks only %s', (key) => {
    const page = { pageNumber: 2, rowsPerPage: 1000, totalPageCount: 7, meta: { message: 'OK' }, [key]: Array.from({ length: 1000 }, (_, i) => record(i)) };
    const { body, kept, total } = split(renderBody(JSON.stringify(page)));
    expect(body).toMatchObject({ pageNumber: 2, rowsPerPage: 1000, totalPageCount: 7, meta: { message: 'OK' } });
    expect(body[key]).toHaveLength(kept);
    expect(total).toBe(1000);
  });

  it.each([
    ['response', 'rows'],
    ['response', 'items'],
    ['data', 'rows'],
  ])('a page nested in the envelope (%s.%s) keeps its paging fields and stays valid JSON', (outer, inner) => {
    const rows = Array.from({ length: 1000 }, (_, i) => record(i));
    const page = { meta: { message: 'OK' }, [outer]: { pageNumber: 1, [inner]: rows, totalPageCount: 7 } };
    const { body, kept, total } = split(renderBody(JSON.stringify(page)));
    expect(body).toMatchObject({ meta: { message: 'OK' }, [outer]: { pageNumber: 1, totalPageCount: 7 } });
    expect(body[outer][inner]).toHaveLength(kept);
    expect(kept).toBeGreaterThan(0);
    expect(total).toBe(1000);
  });

  it('a cut first page names the next page at the size that fit', () => {
    const rows = Array.from({ length: 100 }, (_, i) => record(i, 5000));
    const { kept, note } = split(renderBody(JSON.stringify(rows), [], { pageArg: 'pageNumber', page: 1, sizeArg: 'rowsPerPage', size: 100 }));
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(100);
    expect(resume(note, kept, 'pageNumber', 'rowsPerPage', kept)).toEqual({ page: 2, size: kept });
  });

  it('a cut later page names a request that resumes right after the last kept record', () => {
    const rows = Array.from({ length: 100 }, (_, i) => record(i, 5000));
    const { kept, note } = split(renderBody(JSON.stringify(rows), [], { pageArg: 'pageNumber', page: 3, sizeArg: 'rowsPerPage', size: 100 }));
    expect(kept).toBeLessThan(100);
    resume(note, kept, 'pageNumber', 'rowsPerPage', 200 + kept);
  });

  it('a single record bigger than the cap falls back to a text cut that still shows part of it', () => {
    const text = renderBody(JSON.stringify([record(0, MAX_RESPONSE_CHARS + 10)]));
    expect(text).toContain('"id": "r0"');
    expect(text).toMatch(/\[truncated \d+ characters/);
    expect(text).not.toMatch(NOTE);
  });

  it('records are redacted before they are measured', () => {
    // Raw, each record carries a 3,000-character secret (about 3 MB in all, far over the cap).
    // Redacted, each is about 60 characters, so all 1000 fit and nothing is cut.
    const LONG = `long-secret-${'z'.repeat(3000)}`;
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: `r${i}`, blob: LONG }));
    const text = renderBody(JSON.stringify(rows), [LONG]);
    // Measuring before redacting would cut this list to a few dozen records.
    expect(text).not.toContain('[truncated');
    expect(JSON.parse(text)).toHaveLength(1000);
    expect(text).not.toContain('zzzz');
  });

  it('credential-named values are redacted in a cut list', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ ...record(i), apiKey: 'leak-value-123' }));
    const text = renderBody(JSON.stringify(rows), [API_SECRET]);
    expect(text).not.toContain('leak-value-123');
    split(text);
  });

  describe('through the tools', () => {
    const big = (n: number) => Array.from({ length: n }, (_, i) => record(i, 5000));

    it('a paged filter list names the exact pageNumber and rowsPerPage to resume with', async () => {
      vendor(() => json(big(100)));
      const { text } = await run('marketsharp_contacts_list', { pageNumber: 3, rowsPerPage: 100 });
      const { kept, note } = split(unwrapToolText(text));
      resume(note, kept, 'pageNumber', 'rowsPerPage', 200 + kept);
    });

    it('employees_list names its own page and pageSize arguments', async () => {
      vendor(() => json({ rows: big(100), pageNumber: 2 }));
      const { text } = await run('marketsharp_employees_list', { page: 2, pageSize: 100 });
      const { kept, note } = split(unwrapToolText(text));
      resume(note, kept, 'page', 'pageSize', 100 + kept);
    });

    it.each([
      ['marketsharp_notes_list', { contactId: 'c1' }],
      ['marketsharp_contacts_search', { last_name: 'smith', numberOfRecords: 100 }],
      ['marketsharp_opportunities_list', { fromDate: '2026-01-01', numberOfRecords: 100 }],
    ] as const)('%s, which has no paging, says to narrow instead of naming a page size', async (name, args) => {
      vendor(() => json(big(100)));
      const { text } = await run(name, args);
      const { note } = split(unwrapToolText(text));
      expect(note).toContain("can't page past them");
      expect(note).not.toMatch(/rowsPerPage|pageSize|pageNumber|at most/);
    });
  });
});
