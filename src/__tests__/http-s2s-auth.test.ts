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
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '../client.js';
import { startHttpServer } from '../http.js';

const S2S_SECRET = 's2s-do-not-log-7f3a';
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
  'MARKETSHARP_COMPANY_ID',
  'MARKETSHARP_API_KEY',
  'MARKETSHARP_API_SECRET',
  'MARKETSHARP_EMPLOYEE_ID',
  'LOG_LEVEL',
  'MCP_TRANSPORT',
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
}

function sendHttp(options: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
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
          });
        });
      },
    );
    req.setTimeout(5000, () => {
      req.destroy(new Error(`timeout ${options.method} ${options.path}`));
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
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
  delete process.env.MARKETSHARP_COMPANY_ID;
  delete process.env.MARKETSHARP_API_KEY;
  delete process.env.MARKETSHARP_API_SECRET;
  delete process.env.MARKETSHARP_EMPLOYEE_ID;
  delete process.env.MCP_TRANSPORT;
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
});

describe('HTTP /mcp env mode', () => {
  it('uses MARKETSHARP_* env credentials when AUTH_MODE is not gateway', async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
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
