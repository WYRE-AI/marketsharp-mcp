/**
 * HTTP transport fail-closed auth.
 *
 * Startup requires a real CONDUIT_S2S_SECRET unless MCP_ALLOW_INSECURE_DEV=1.
 * Known placeholders never count. /mcp rejects a missing or invalid
 * X-Gateway-S2S header. AUTH_MODE=gateway rejects requests that omit any of
 * x-marketsharp-company-id / -api-key / -api-secret and never falls back to
 * MARKETSHARP_* env credentials. Ids are shape-checked.
 */

import { createHmac } from 'node:crypto';
import { request as httpRequest, type Server } from 'node:http';
import { connect as netConnect, type AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '../client.js';
import { startHttpServer } from '../http.js';
import { MAX_REQUEST_BODY_BYTES } from '../input-limits.js';

const S2S_SECRET = 's2s-do-not-log-7f3a-0123456789abcdef';
const ENV_API_KEY = 'env-marketsharp-key-must-not-be-used';
const HEADER_API_KEY = 'header-marketsharp-key';
const HEADER_API_SECRET = 'header-marketsharp-secret';
const PLACEHOLDER = 'replace-with-a-real-secret';

const PLACEHOLDERS = [
  'replace-with-a-real-secret',
  'your-s2s-secret',
  'your-secret',
  'changeme',
  'change-me',
  'placeholder',
  'secret',
  'example',
  'replace-me',
  's2s-secret',
] as const;

const ENV_KEYS = [
  'CONDUIT_S2S_SECRET',
  'MCP_ALLOW_INSECURE_DEV',
  'MCP_HTTP_PORT',
  'MCP_HTTP_HOST',
  'AUTH_MODE',
  'NODE_ENV',
  'MARKETSHARP_COMPANY_ID',
  'MARKETSHARP_API_KEY',
  'MARKETSHARP_API_SECRET',
  'MARKETSHARP_EMPLOYEE_ID',
  'LOG_LEVEL',
  'MCP_TRANSPORT',
  'MCP_ALLOWED_HOSTS',
] as const;

const savedEnv = new Map<string, string | undefined>();
const servers: Server[] = [];

function mintS2sHeader(secret: string, unixSeconds = Math.floor(Date.now() / 1000)): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac('sha256', secret).update(message).digest('hex');
  return `${message},v1=${hex}`;
}

function captureStderr(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  });
  return {
    text: () => lines.join('\n'),
    restore: () => spy.mockRestore(),
  };
}

interface HttpResult {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

function sendHttp(options: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  /** Send the body in pieces with Transfer-Encoding: chunked and no Content-Length. */
  chunked?: boolean;
}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: options.port,
        method: options.method,
        path: options.path,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          });
        });
      },
    );
    req.setTimeout(5000, () => {
      req.destroy(new Error(`timeout ${options.method} ${options.path}`));
    });
    req.on('error', reject);
    if (options.body !== undefined) {
      if (options.chunked) {
        const piece = 16 * 1024;
        for (let at = 0; at < options.body.length; at += piece) req.write(options.body.slice(at, at + piece));
      } else {
        req.write(options.body);
      }
    }
    req.end();
  });
}

/** Raw HTTP/1.1 over a socket, so the test controls the Host header byte-for-byte. */
function sendRaw(port: number, head: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, '127.0.0.1', () => socket.write(head));
    const chunks: Buffer[] = [];
    socket.setTimeout(5000, () => socket.destroy(new Error('raw request timeout')));
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
  });
}

async function listen(): Promise<{ port: number; address: string; server: Server }> {
  const server = await startHttpServer();
  servers.push(server);
  const bound = server.address() as AddressInfo | null;
  if (!bound || typeof bound === 'string') {
    throw new Error('HTTP server did not bind a TCP port');
  }
  return { port: bound.port, address: bound.address, server };
}

function mcpHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...extra,
  };
}

const groupsCall = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'marketsharp_divisions_list', arguments: {} },
});

function mockExit() {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${String(code)}`);
  }) as typeof process.exit);
}

function assertNoSecrets(text: string): void {
  expect(text).not.toContain(S2S_SECRET);
  expect(text).not.toContain(ENV_API_KEY);
  expect(text).not.toContain(HEADER_API_KEY);
  expect(text).not.toContain(HEADER_API_SECRET);
  expect(text).not.toContain(PLACEHOLDER);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  process.env.MCP_HTTP_PORT = '0';
  process.env.MCP_HTTP_HOST = '127.0.0.1';
  process.env.LOG_LEVEL = 'info';
  delete process.env.CONDUIT_S2S_SECRET;
  delete process.env.MCP_ALLOW_INSECURE_DEV;
  delete process.env.AUTH_MODE;
  process.env.NODE_ENV = 'test';
  delete process.env.MARKETSHARP_COMPANY_ID;
  delete process.env.MARKETSHARP_API_KEY;
  delete process.env.MARKETSHARP_API_SECRET;
  delete process.env.MARKETSHARP_EMPLOYEE_ID;
  delete process.env.MCP_TRANSPORT;
  delete process.env.MCP_ALLOWED_HOSTS;
});

afterEach(async () => {
  vi.restoreAllMocks();
  client.clearTokenCache();
  vi.unstubAllGlobals();
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server) continue;
    await new Promise<void>((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

describe('HTTP startup', () => {
  it('refuses to start when CONDUIT_S2S_SECRET is empty', async () => {
    const logs = captureStderr();
    const exitSpy = mockExit();

    try {
      await expect(startHttpServer()).rejects.toThrow('process.exit:1');
      expect(exitSpy).toHaveBeenCalledWith(1);
      const text = logs.text();
      expect(text).toContain('Refusing to start HTTP transport');
      expect(text).toContain('CONDUIT_S2S_SECRET');
      assertNoSecrets(text);
    } finally {
      logs.restore();
    }
  });

  it('still refuses when MCP_ALLOW_INSECURE_DEV is not exactly 1', async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = 'true';
    process.env.NODE_ENV = 'development';
    process.env.CONDUIT_S2S_SECRET = '   ';
    const logs = captureStderr();
    mockExit();

    try {
      await expect(startHttpServer()).rejects.toThrow('process.exit:1');
      expect(logs.text()).toContain('Refusing to start HTTP transport');
      assertNoSecrets(logs.text());
    } finally {
      logs.restore();
    }
  });

  it.each(PLACEHOLDERS)('refuses known placeholder %j and does not log it', async (placeholder) => {
    const configured = `  ${placeholder.toUpperCase()}  `;
    process.env.CONDUIT_S2S_SECRET = configured;
    process.env.MCP_ALLOW_INSECURE_DEV = '1';
    process.env.NODE_ENV = 'development';
    const logs = captureStderr();
    const exitSpy = mockExit();

    try {
      await expect(startHttpServer()).rejects.toThrow('process.exit:1');
      expect(exitSpy).toHaveBeenCalledWith(1);
      const text = logs.text();
      expect(text).toContain('known placeholder');
      expect(text).toContain('Refusing to start HTTP transport');
      expect(text).toContain('MCP_ALLOW_INSECURE_DEV does not bypass a placeholder secret');
      expect(text).not.toContain(configured);
      expect(text).not.toContain(`CONDUIT_S2S_SECRET=${placeholder}`);
      assertNoSecrets(text);
    } finally {
      logs.restore();
    }
  });

  it('allows startup with a warning when MCP_ALLOW_INSECURE_DEV=1 and binds 127.0.0.1', async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = '1';
    process.env.NODE_ENV = 'development';
    delete process.env.MCP_HTTP_HOST;
    const logs = captureStderr();
    const exitSpy = mockExit();

    try {
      const server = await listen();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(server.address).toBe('127.0.0.1');
      const text = logs.text();
      expect(text).toContain('SECURITY WARNING');
      expect(text).toContain('CONDUIT_S2S_SECRET');
      expect(text).toContain('MCP_ALLOW_INSECURE_DEV');
      expect(text).toContain('127.0.0.1');
      expect(text).not.toContain('not a loopback address');
      assertNoSecrets(text);
    } finally {
      logs.restore();
    }
  });

  it.each(['0.0.0.0', '10.1.2.3'])(
    'overrides non-loopback MCP_HTTP_HOST=%s when the dev bypass is on',
    async (host) => {
      process.env.MCP_ALLOW_INSECURE_DEV = '1';
      process.env.NODE_ENV = 'development';
      process.env.MCP_HTTP_HOST = host;
      const logs = captureStderr();
      const exitSpy = mockExit();

      try {
        const server = await listen();
        expect(exitSpy).not.toHaveBeenCalled();
        expect(server.address).toBe('127.0.0.1');
        const text = logs.text();
        expect(text).toContain(`MCP_HTTP_HOST=${host} is not a loopback address`);
        expect(text).toContain('Binding 127.0.0.1 only');
        assertNoSecrets(text);
      } finally {
        logs.restore();
      }
    },
  );

  it('forces 127.0.0.1 when the dev bypass host is localhost', async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = '1';
    process.env.NODE_ENV = 'development';
    process.env.MCP_HTTP_HOST = 'localhost';
    const logs = captureStderr();

    try {
      const server = await listen();
      expect(server.address).toBe('127.0.0.1');
      expect(logs.text()).toContain('SECURITY WARNING');
      expect(logs.text()).not.toContain('not a loopback address');
    } finally {
      logs.restore();
    }
  });

  it('honors a non-loopback MCP_HTTP_HOST when CONDUIT_S2S_SECRET is set', async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.MCP_HTTP_HOST = '0.0.0.0';
    const logs = captureStderr();

    try {
      const server = await listen();
      expect(server.address).toBe('0.0.0.0');
      expect(logs.text()).not.toContain('not a loopback address');
      assertNoSecrets(logs.text());
    } finally {
      logs.restore();
    }
  });

  it('refuses a 31-character secret without logging it', async () => {
    const short = 'a1b2c3d4'.repeat(3) + 'e5f6g7h';
    expect(short).toHaveLength(31);
    process.env.CONDUIT_S2S_SECRET = short;
    const logs = captureStderr();
    const exitSpy = mockExit();
    try {
      await expect(startHttpServer()).rejects.toThrow('process.exit:1');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(logs.text()).toContain('CONDUIT_S2S_SECRET must be at least 32 characters.');
      expect(logs.text()).not.toContain(short);
    } finally {
      logs.restore();
    }
  });

  it('starts with a 32-character secret', async () => {
    process.env.CONDUIT_S2S_SECRET = 'Zq8vN2kLw5Rt1Yx7Hc4Mb9Pd3Gf6Js0A';
    const exitSpy = mockExit();
    await listen();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it.each(['Gateway', 'foo', 'ENV'])('refuses unknown AUTH_MODE %j', async (mode) => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = mode;
    const logs = captureStderr();
    mockExit();
    try {
      await expect(startHttpServer()).rejects.toThrow('process.exit:1');
      expect(logs.text()).toContain("AUTH_MODE must be 'gateway' or 'env'.");
      assertNoSecrets(logs.text());
    } finally {
      logs.restore();
    }
  });

  it.each([
    ['production', '1'],
    ['production', 'true'],
    [undefined, '1'],
    ['Staging', '1'],
  ])('with NODE_ENV=%s refuses MCP_ALLOW_INSECURE_DEV=%s, even with an empty secret', async (nodeEnv, flag) => {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
    process.env.MCP_ALLOW_INSECURE_DEV = flag;
    const logs = captureStderr();
    const exitSpy = mockExit();
    try {
      await expect(startHttpServer()).rejects.toThrow('process.exit:1');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(logs.text()).toContain('MCP_ALLOW_INSECURE_DEV requires NODE_ENV=development.');
    } finally {
      logs.restore();
    }
  });

  it.each(['0', 'false', ''])('ignores MCP_ALLOW_INSECURE_DEV=%j outside development', async (flag) => {
    process.env.NODE_ENV = 'production';
    process.env.MCP_ALLOW_INSECURE_DEV = flag;
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    mockExit();
    await listen();
  });

  it('binds 0.0.0.0 when a secret is set and MCP_HTTP_HOST is unset', async () => {
    delete process.env.MCP_HTTP_HOST;
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    const server = await listen();
    expect(server.address).toBe('0.0.0.0');
  });
});

describe('HTTP /mcp authentication', () => {
  const fetchMock = vi.fn();
  const gatewayHeaders = (extra: Record<string, string> = {}) =>
    mcpHeaders({
      'x-gateway-s2s': mintS2sHeader(S2S_SECRET),
      'x-marketsharp-company-id': '4321',
      'x-marketsharp-api-key': HEADER_API_KEY,
      'x-marketsharp-api-secret': HEADER_API_SECRET,
      ...extra,
    });

  beforeEach(() => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = 'gateway';
    process.env.MARKETSHARP_COMPANY_ID = '9999';
    process.env.MARKETSHARP_API_KEY = ENV_API_KEY;
    process.env.MARKETSHARP_API_SECRET = 'env-secret';
    process.env.MCP_HTTP_HOST = '127.0.0.1';
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith('/token')
        ? jsonResponse({ access_token: 'jwt-from-header-creds', expires_in: 3600 })
        : jsonResponse([{ id: '1', name: 'Main' }]),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  it('returns 401 when the S2S header is missing or invalid and does not log secrets', async () => {
    const logs = captureStderr();
    const credsSpy = vi.spyOn(client, 'getCredentials');
    const server = await listen();
    try {
      const { ['x-gateway-s2s']: _drop, ...noS2s } = gatewayHeaders();
      const missing = await sendHttp({ port: server.port, method: 'POST', path: '/mcp', headers: noS2s, body: groupsCall });
      const invalid = await sendHttp({
        port: server.port,
        method: 'POST',
        path: '/mcp',
        headers: gatewayHeaders({ 'x-gateway-s2s': mintS2sHeader('wrong-secret') }),
        body: groupsCall,
      });
      expect(missing.status).toBe(401);
      expect(invalid.status).toBe(401);
      expect(missing.body).toContain('X-Gateway-S2S');
      assertNoSecrets(missing.body);
      assertNoSecrets(invalid.body);
      assertNoSecrets(logs.text());
      expect(credsSpy).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      logs.restore();
    }
  });

  it('returns 401 in gateway mode when any required credential header is missing, never using env credentials', async () => {
    const server = await listen();
    for (const drop of ['x-marketsharp-company-id', 'x-marketsharp-api-key', 'x-marketsharp-api-secret']) {
      const headers = gatewayHeaders();
      delete headers[drop];
      const response = await sendHttp({ port: server.port, method: 'POST', path: '/mcp', headers, body: groupsCall });
      expect(response.status, drop).toBe(401);
      expect(response.body).toContain('x-marketsharp-api-key');
      assertNoSecrets(response.body);
    }
    const empty = await sendHttp({
      port: server.port,
      method: 'POST',
      path: '/mcp',
      headers: gatewayHeaders({ 'x-marketsharp-api-secret': '' }),
      body: groupsCall,
    });
    expect(empty.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed company or employee id and does not call MarketSharp', async () => {
    const server = await listen();
    const bad: Record<string, string>[] = [
      { 'x-marketsharp-company-id': '../1' },
      { 'x-marketsharp-company-id': '1 2' },
      { 'x-marketsharp-employee-id': 'a/b' },
      { 'x-marketsharp-employee-id': 'x'.repeat(65) },
    ];
    for (const extra of bad) {
      const response = await sendHttp({ port: server.port, method: 'POST', path: '/mcp', headers: gatewayHeaders(extra), body: groupsCall });
      expect(response.status, JSON.stringify(extra)).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a signed request with credential headers and uses exactly those credentials', async () => {
    const logs = captureStderr();
    const server = await listen();
    try {
      const response = await sendHttp({
        port: server.port,
        method: 'POST',
        path: '/mcp',
        headers: gatewayHeaders({ 'x-marketsharp-employee-id': '77' }),
        body: groupsCall,
      });
      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [tokenUrl, tokenInit] = fetchMock.mock.calls[0] as [string, { body: string }];
      expect(tokenUrl).toBe('https://restapi.marketsharpm.com/token');
      const form = new URLSearchParams(tokenInit.body);
      expect(form.get('companyId')).toBe('4321');
      expect(form.get('apikey')).toBe(HEADER_API_KEY);
      expect(form.get('apisecret')).toBe(HEADER_API_SECRET);
      expect(form.get('empoid')).toBe('77');
      const [url, init] = fetchMock.mock.calls[1] as [string, { headers: Record<string, string> }];
      expect(url).toBe('https://restapi.marketsharpm.com/companies/4321/divisions?api-version=2.0');
      expect(init.headers.Authorization).toBe('Bearer jwt-from-header-creds');
      assertNoSecrets(response.body);
      assertNoSecrets(logs.text());
      expect(logs.text()).not.toContain('jwt-from-header-creds');
    } finally {
      logs.restore();
    }
  });

  describe('request body cap', () => {
    const oversized = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(MAX_REQUEST_BODY_BYTES + 1) } });

    it('returns 401, not 413, for an oversized declared body without a valid S2S header', async () => {
      const server = await listen();
      const { ['x-gateway-s2s']: _drop, ...noS2s } = gatewayHeaders();
      const response = await sendHttp({ port: server.port, method: 'POST', path: '/mcp', headers: { ...noS2s, 'content-length': String(Buffer.byteLength(oversized)) }, body: oversized });
      expect(response.status).toBe(401);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns 413 with a JSON-RPC error for an oversized declared body and never calls MarketSharp', async () => {
      const server = await listen();
      const response = await sendHttp({
        port: server.port,
        method: 'POST',
        path: '/mcp',
        headers: gatewayHeaders({ 'content-length': String(Buffer.byteLength(oversized)) }),
        body: oversized,
      });
      expect(response.status).toBe(413);
      const body = JSON.parse(response.body);
      expect(body.jsonrpc).toBe('2.0');
      expect(body.error.code).toBe(-32600);
      expect(body.error.message).toContain(String(MAX_REQUEST_BODY_BYTES));
      expect(body.id).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns 413 for an oversized chunked body with no Content-Length', async () => {
      const server = await listen();
      const response = await sendHttp({
        port: server.port,
        method: 'POST',
        path: '/mcp',
        headers: gatewayHeaders({ 'transfer-encoding': 'chunked' }),
        body: oversized,
        chunked: true,
      });
      expect(response.status).toBe(413);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('still serves a normal-size request', async () => {
      const server = await listen();
      const response = await sendHttp({ port: server.port, method: 'POST', path: '/mcp', headers: gatewayHeaders(), body: groupsCall });
      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalled();
    });
  });

  it('serves /health without authentication and without returning credentials', async () => {
    const server = await listen();
    const response = await sendHttp({ port: server.port, method: 'GET', path: '/health' });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('ok');
    expect(body.mode).toBe('gateway');
    assertNoSecrets(response.body);
    expect(response.body).not.toContain('env-secret');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['bad host[', 'exa mple.com:99999', '%%%'])(
    'routes by path and does not crash when the Host header is invalid (%s)',
    async (host) => {
      const server = await listen();
      const health = await sendRaw(
        server.port,
        `GET /health HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
      );
      expect(health).toMatch(/^HTTP\/1\.1 200 /);
      expect(health).toContain('"status":"ok"');
      const unauth = await sendRaw(
        server.port,
        `POST /mcp HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\n` +
          `Content-Length: ${Buffer.byteLength(groupsCall)}\r\nConnection: close\r\n\r\n${groupsCall}`,
      );
      expect(unauth).toMatch(/^HTTP\/1\.1 401 /);
      // The server is still up after the bad Host.
      const again = await sendHttp({ port: server.port, method: 'GET', path: '/health' });
      expect(again.status).toBe(200);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  describe('method, Host allowlist and caching', () => {
    it.each(['GET', 'DELETE', 'PUT'])('a signed %s /mcp gets 405 with Allow: POST and never opens a stream', async (method) => {
      const server = await listen();
      const response = await sendHttp({
        port: server.port,
        method,
        path: '/mcp',
        headers: gatewayHeaders({ accept: 'text/event-stream' }),
      });
      expect(response.status).toBe(405);
      expect(response.headers.allow).toBe('POST');
      expect(JSON.parse(response.body)).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 }, id: null });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('an unsigned GET /mcp is still 401, not 405', async () => {
      const server = await listen();
      const { ['x-gateway-s2s']: _drop, ...noS2s } = gatewayHeaders();
      const response = await sendHttp({ port: server.port, method: 'GET', path: '/mcp', headers: noS2s });
      expect(response.status).toBe(401);
    });

    it('MCP_ALLOWED_HOSTS rejects other Host headers with 403 before S2S, and accepts a listed host with or without a port', async () => {
      process.env.MCP_ALLOWED_HOSTS = 'marketsharp-mcp, Sidecar.internal';
      const server = await listen();
      const send = (host: string) =>
        sendHttp({ port: server.port, method: 'POST', path: '/mcp', headers: gatewayHeaders({ host }), body: groupsCall });
      const evil = await send('evil.example');
      expect(evil.status).toBe(403);
      expect(evil.body).toContain('MCP_ALLOWED_HOSTS');
      expect(fetchMock).not.toHaveBeenCalled();
      expect((await send('marketsharp-mcp:8080')).status).toBe(200);
      expect((await send('sidecar.internal')).status).toBe(200);
      // /health is liveness and ignores the allowlist.
      const health = await sendHttp({ port: server.port, method: 'GET', path: '/health', headers: { host: 'evil.example' } });
      expect(health.status).toBe(200);
    });

    it('every response carries Cache-Control: no-store', async () => {
      const server = await listen();
      const { ['x-gateway-s2s']: _drop, ...noS2s } = gatewayHeaders();
      const responses = [
        await sendHttp({ port: server.port, method: 'GET', path: '/health' }),
        await sendHttp({ port: server.port, method: 'GET', path: '/nope' }),
        await sendHttp({ port: server.port, method: 'POST', path: '/mcp', headers: noS2s, body: groupsCall }),
        await sendHttp({ port: server.port, method: 'GET', path: '/mcp', headers: gatewayHeaders() }),
        await sendHttp({ port: server.port, method: 'POST', path: '/mcp', headers: gatewayHeaders(), body: groupsCall }),
      ];
      expect(responses.map((r) => r.status)).toEqual([200, 404, 401, 405, 200]);
      for (const r of responses) expect(r.headers['cache-control'], String(r.status)).toBe('no-store');
    });
  });
});

describe('HTTP /mcp default (unset AUTH_MODE) is gateway', () => {
  it('returns 401 for a signed request with no credential headers, even with env credentials set', async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.MARKETSHARP_COMPANY_ID = '9999';
    process.env.MARKETSHARP_API_KEY = ENV_API_KEY;
    process.env.MARKETSHARP_API_SECRET = 'env-secret';
    const fetchMock = vi.fn(async () => jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    const server = await listen();
    const response = await sendHttp({
      port: server.port,
      method: 'POST',
      path: '/mcp',
      headers: mcpHeaders({ 'x-gateway-s2s': mintS2sHeader(S2S_SECRET) }),
      body: groupsCall,
    });
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    const health = await sendHttp({ port: server.port, method: 'GET', path: '/health' });
    expect(JSON.parse(health.body)).toMatchObject({ mode: 'gateway', credentials: { configured: false } });
  });
});

describe('HTTP /mcp env mode', () => {
  it.each(['MARKETSHARP_COMPANY_ID', 'MARKETSHARP_API_KEY', 'MARKETSHARP_API_SECRET'])(
    'refuses to start when AUTH_MODE=env and %s is empty, without logging the others',
    async (missing) => {
      process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
      process.env.AUTH_MODE = 'env';
      process.env.MARKETSHARP_COMPANY_ID = '9999';
      process.env.MARKETSHARP_API_KEY = ENV_API_KEY;
      process.env.MARKETSHARP_API_SECRET = 'env-secret';
      process.env[missing] = '  ';
      const logs = captureStderr();
      const exitSpy = mockExit();
      try {
        await expect(startHttpServer()).rejects.toThrow('process.exit:1');
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(logs.text()).toContain(`AUTH_MODE=env requires ${missing}`);
        assertNoSecrets(logs.text());
        expect(logs.text()).not.toContain('env-secret');
      } finally {
        logs.restore();
      }
    },
  );

  it.each([
    ['MARKETSHARP_COMPANY_ID', '../1'],
    ['MARKETSHARP_EMPLOYEE_ID', 'a/b'],
  ])('refuses to start when AUTH_MODE=env and %s is not a MarketSharp id', async (name, value) => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = 'env';
    process.env.MARKETSHARP_COMPANY_ID = '9999';
    process.env.MARKETSHARP_API_KEY = ENV_API_KEY;
    process.env.MARKETSHARP_API_SECRET = 'env-secret';
    process.env[name] = value;
    const logs = captureStderr();
    mockExit();
    try {
      await expect(startHttpServer()).rejects.toThrow('process.exit:1');
      expect(logs.text()).toContain(`${name} is not a MarketSharp id`);
    } finally {
      logs.restore();
    }
  });

  it('uses MARKETSHARP_* env credentials when AUTH_MODE=env', async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = 'env';
    process.env.MARKETSHARP_COMPANY_ID = '9999';
    process.env.MARKETSHARP_API_KEY = ENV_API_KEY;
    process.env.MARKETSHARP_API_SECRET = 'env-secret';
    const fetchMock = vi.fn(async (url: string) =>
      String(url).endsWith('/token') ? jsonResponse({ access_token: 'env-jwt' }) : jsonResponse([]),
    );
    vi.stubGlobal('fetch', fetchMock);
    const server = await listen();
    const response = await sendHttp({
      port: server.port,
      method: 'POST',
      path: '/mcp',
      headers: mcpHeaders({ 'x-gateway-s2s': mintS2sHeader(S2S_SECRET) }),
      body: groupsCall,
    });
    expect(response.status).toBe(200);
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://restapi.marketsharpm.com/companies/9999/divisions?api-version=2.0');
  });
});

describe('HTTP startup refuses weak S2S secrets', () => {
  it.each([
    ['a'.repeat(64), 'repeated'],
    ['abcd'.repeat(10), 'repeated'],
    ['replace-with-openssl-rand-hex-32-0123456789', 'placeholder'],
    ['0101010101010101010101010101010122', 'too few distinct'],
  ])('refuses %j (%s) without logging it', async (secret, why) => {
    process.env.CONDUIT_S2S_SECRET = secret;
    const logs = captureStderr();
    const exitSpy = mockExit();
    try {
      await expect(startHttpServer()).rejects.toThrow('process.exit:1');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(logs.text()).toContain(why);
      expect(logs.text()).not.toContain(secret);
    } finally {
      logs.restore();
    }
  });
});

describe('X-Conduit-Tool-Tiers (reduce-only)', () => {
  const fetchMock = vi.fn(async (url: string) =>
    String(url).endsWith('/token') ? jsonResponse({ access_token: 'jwt' }) : jsonResponse([{ id: '1' }]),
  );
  const listCall = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const headers = (extra: Record<string, string> = {}) =>
    mcpHeaders({
      'x-gateway-s2s': mintS2sHeader(S2S_SECRET),
      'x-marketsharp-company-id': '4321',
      'x-marketsharp-api-key': HEADER_API_KEY,
      'x-marketsharp-api-secret': HEADER_API_SECRET,
      ...extra,
    });

  beforeEach(() => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = 'gateway';
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    delete process.env.MARKETSHARP_ENABLE_WRITES;
  });

  async function toolNames(port: number, extra: Record<string, string>): Promise<string[]> {
    const res = await sendHttp({ port, method: 'POST', path: '/mcp', headers: headers(extra), body: listCall });
    expect(res.status).toBe(200);
    return (JSON.parse(res.body) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
  }

  it('absent header lists the 25 read tools; read or wider stays at 25', async () => {
    const server = await listen();
    expect(await toolNames(server.port, {})).toHaveLength(25);
    expect(await toolNames(server.port, { 'x-conduit-tool-tiers': 'read' })).toHaveLength(25);
    expect(await toolNames(server.port, { 'x-conduit-tool-tiers': 'read,write,admin' })).toHaveLength(25);
  });

  it('an empty header exposes zero tools and a call is an unknown tool with no upstream request', async () => {
    const server = await listen();
    expect(await toolNames(server.port, { 'x-conduit-tool-tiers': '' })).toEqual([]);
    const res = await sendHttp({ port: server.port, method: 'POST', path: '/mcp', headers: headers({ 'x-conduit-tool-tiers': '' }), body: groupsCall });
    const body = JSON.parse(res.body) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe('Error: Unknown tool: marketsharp_divisions_list');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('MARKETSHARP_ENABLE_WRITES adds no tools, and a write tier header exposes none', async () => {
    process.env.MARKETSHARP_ENABLE_WRITES = 'true';
    const server = await listen();
    expect(await toolNames(server.port, {})).toHaveLength(25);
    expect(await toolNames(server.port, { 'x-conduit-tool-tiers': 'write' })).toEqual([]);
  });
});

describe('request handler failures', () => {
  const listCall = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

  it.each(['gateway', 'env'] as const)(
    'AUTH_MODE=%s: a throw inside the MCP handler becomes a JSON-RPC 500, logs only the error type, and the server keeps serving',
    async (mode) => {
      process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
      process.env.AUTH_MODE = mode;
      process.env.MARKETSHARP_COMPANY_ID = '9999';
      process.env.MARKETSHARP_API_KEY = ENV_API_KEY;
      process.env.MARKETSHARP_API_SECRET = 'env-secret';
      const spy = vi
        .spyOn(StreamableHTTPServerTransport.prototype, 'handleRequest')
        .mockRejectedValueOnce(new Error(`boom ${HEADER_API_SECRET}`));
      const logs = captureStderr();
      const server = await listen();
      const headers = mcpHeaders({
        'x-gateway-s2s': mintS2sHeader(S2S_SECRET),
        'x-marketsharp-company-id': '4321',
        'x-marketsharp-api-key': HEADER_API_KEY,
        'x-marketsharp-api-secret': HEADER_API_SECRET,
      });

      const failed = await sendHttp({ port: server.port, method: 'POST', path: '/mcp', headers, body: listCall });
      expect(failed.status).toBe(500);
      expect(JSON.parse(failed.body)).toEqual({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
      expect(logs.text()).toContain('"error":"Error"');
      expect(logs.text()).not.toContain('boom');
      assertNoSecrets(logs.text() + failed.body);
      logs.restore();

      spy.mockRestore();
      const ok = await sendHttp({ port: server.port, method: 'POST', path: '/mcp', headers, body: listCall });
      expect(ok.status).toBe(200);
    },
  );
});
