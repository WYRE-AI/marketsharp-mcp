import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { runWithCredentials, setGatewayMode } from './client.js';
import { configuredTiers, narrowTiers, TOOL_TIERS_HEADER } from './config.js';
import { logger } from './utils/logger.js';
import { MAX_REQUEST_BODY_BYTES } from './input-limits.js';
import { verifyS2sHeader, S2S_HEADER } from './s2s-verify.js';

// Gateway service-to-service auth (gateway#377 parity). HTTP startup fails
// closed: an empty CONDUIT_S2S_SECRET, or a known placeholder, refuses to
// boot unless MCP_ALLOW_INSECURE_DEV=1 (placeholders never qualify). That
// bypass needs NODE_ENV=development, skips X-Gateway-S2S and binds 127.0.0.1
// only. A configured secret must be at least 32 characters, is always
// enforced, and still honors MCP_HTTP_HOST (default 0.0.0.0) so
// container deploys keep their existing bind. The secret value is never logged.
// See src/s2s-verify.ts.

/** Public example values. A copied placeholder must not verify as a real secret. */
const KNOWN_PLACEHOLDER_SECRETS = new Set([
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
]);

/** Placeholder-looking values that aren't in the exact list above (e.g. "replace-with-openssl-rand-hex-32"). */
const PLACEHOLDER_PATTERN = /replace|changeme|change-me|placeholder|example|your-?secret/i;

const LOOPBACK_HOST = '127.0.0.1';
const MIN_S2S_SECRET_LENGTH = 32;
const WEAK_S2S_SECRET_PREFIX = 'Refusing to start HTTP transport: CONDUIT_S2S_SECRET';

const SHORT_S2S_SECRET_ERROR = `CONDUIT_S2S_SECRET must be at least ${MIN_S2S_SECRET_LENGTH} characters.`;
const INSECURE_DEV_ENV_ERROR = 'MCP_ALLOW_INSECURE_DEV requires NODE_ENV=development.';

const MISSING_S2S_SECRET_ERROR =
  'Refusing to start HTTP transport: CONDUIT_S2S_SECRET is empty. ' +
  'Set CONDUIT_S2S_SECRET, or set MCP_ALLOW_INSECURE_DEV=1 for local development only.';

const PLACEHOLDER_S2S_SECRET_ERROR =
  'Refusing to start HTTP transport: CONDUIT_S2S_SECRET is a known placeholder. ' +
  'Generate a secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value. ' +
  'MCP_ALLOW_INSECURE_DEV does not bypass a placeholder secret.';

const INSECURE_DEV_WARNING =
  'SECURITY WARNING: CONDUIT_S2S_SECRET is empty and MCP_ALLOW_INSECURE_DEV=1. ' +
  'HTTP /mcp is not enforcing X-Gateway-S2S and is limited to loopback (127.0.0.1). ' +
  'Do not use this outside local development.';

const S2S_UNAUTHORIZED = {
  error:
    'Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.',
};

const GATEWAY_CREDENTIALS_UNAUTHORIZED = {
  error:
    'Missing MarketSharp credentials: send the x-marketsharp-company-id, x-marketsharp-api-key and x-marketsharp-api-secret headers.',
};

const INVALID_ID_HEADER = {
  error: 'Invalid x-marketsharp-company-id or x-marketsharp-employee-id: expected a MarketSharp id (letters, digits and dashes)',
};

/** MarketSharp company and employee ids. They go into URL paths and the token form, so keep them tight. */
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

function headerValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/** Raw tier header if present (even empty, which narrows to no tools); undefined if absent. */
function tierHeader(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(',') : value;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** MCP_ALLOWED_HOSTS: comma-separated Host values /mcp accepts. Unset or empty turns the check off. */
function parseAllowedHosts(raw: string | undefined): ReadonlySet<string> | null {
  const entries = (raw ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return entries.length ? new Set(entries) : null;
}

/** Matches the Host header as sent, or without its port. */
function hostAllowed(req: IncomingMessage, allowed: ReadonlySet<string> | null): boolean {
  if (!allowed) return true;
  const host = (req.headers.host ?? '').trim().toLowerCase();
  if (!host) return false;
  if (allowed.has(host)) return true;
  return allowed.has(host.replace(/^\[([^\]]+)\](:\d+)?$/, '$1').replace(/:\d+$/, ''));
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.+)\]$/, '$1');
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

function refuseStart(message: string): never {
  logger.error(message);
  process.exit(1);
}

/** True when MCP_ALLOW_INSECURE_DEV is set to anything other than empty, 0 or false. */
function insecureDevRequested(): boolean {
  const flag = (process.env.MCP_ALLOW_INSECURE_DEV ?? '').trim().toLowerCase();
  return flag !== '' && flag !== '0' && flag !== 'false';
}

/** The dev bypass only works under NODE_ENV=development; any other setting of the flag refuses to start. */
function checkInsecureDevEnv(): void {
  if (insecureDevRequested() && (process.env.NODE_ENV ?? '').trim().toLowerCase() !== 'development') {
    refuseStart(INSECURE_DEV_ENV_ERROR);
  }
}

export type AuthMode = 'gateway' | 'env';

/** Unset or empty means gateway. Anything but exactly 'gateway' or 'env' refuses to start. */
function resolveAuthMode(): AuthMode {
  const raw = (process.env.AUTH_MODE ?? '').trim();
  if (raw === '' || raw === 'gateway') return 'gateway';
  if (raw === 'env') return 'env';
  return refuseStart(`AUTH_MODE must be 'gateway' or 'env'. Got ${JSON.stringify(raw.slice(0, 40))}.`);
}

/**
 * AUTH_MODE=env serves every HTTP request with MARKETSHARP_*, so a missing
 * credential or a malformed id refuses to start instead of reporting healthy
 * and failing each tool call. Only names are logged, never values.
 */
function checkEnvCredentials(): void {
  for (const name of ['MARKETSHARP_COMPANY_ID', 'MARKETSHARP_API_KEY', 'MARKETSHARP_API_SECRET']) {
    if (!(process.env[name] ?? '').trim()) refuseStart(`Refusing to start HTTP transport: AUTH_MODE=env requires ${name}.`);
  }
  for (const name of ['MARKETSHARP_COMPANY_ID', 'MARKETSHARP_EMPLOYEE_ID']) {
    const value = (process.env[name] ?? '').trim();
    if (value && !ID_RE.test(value)) {
      refuseStart(`Refusing to start HTTP transport: ${name} is not a MarketSharp id (letters, digits and dashes).`);
    }
  }
}

/**
 * Secret for X-Gateway-S2S on /mcp. Read at HTTP startup, not module load.
 * Empty is fail-closed unless MCP_ALLOW_INSECURE_DEV=1. A known placeholder
 * always refuses, including when the dev flag is set. The secret is never logged.
 */
function resolveS2sSecret(): string {
  const secret = (process.env.CONDUIT_S2S_SECRET ?? '').trim();
  if (secret && (KNOWN_PLACEHOLDER_SECRETS.has(secret.toLowerCase()) || PLACEHOLDER_PATTERN.test(secret))) {
    refuseStart(PLACEHOLDER_S2S_SECRET_ERROR);
  }
  if (secret) {
    if (secret.length < MIN_S2S_SECRET_LENGTH) refuseStart(SHORT_S2S_SECRET_ERROR);
    if (/^(.{1,8}?)\1+$/.test(secret)) refuseStart(`${WEAK_S2S_SECRET_PREFIX} is a repeated character pattern.`);
    if (new Set(secret).size < 8) refuseStart(`${WEAK_S2S_SECRET_PREFIX} has too few distinct characters.`);
    return secret;
  }

  if (process.env.MCP_ALLOW_INSECURE_DEV === '1') {
    // error level so LOG_LEVEL=warn|error cannot hide the bypass.
    logger.error(INSECURE_DEV_WARNING);
    return '';
  }

  refuseStart(MISSING_S2S_SECRET_ERROR);
}

/**
 * No secret (insecure-dev only) always binds 127.0.0.1. A non-loopback
 * MCP_HTTP_HOST is overridden and logged. A configured secret honors
 * MCP_HTTP_HOST, defaulting to 0.0.0.0 so container deploys stay unchanged.
 */
function resolveListenHost(s2sSecret: string): string {
  const configured = (process.env.MCP_HTTP_HOST ?? '').trim();
  if (s2sSecret) return configured || '0.0.0.0';

  if (configured && !isLoopbackHost(configured)) {
    logger.error(
      `WARNING: MCP_HTTP_HOST=${configured} is not a loopback address. ` +
        'MCP_ALLOW_INSECURE_DEV=1 without CONDUIT_S2S_SECRET cannot listen there. ' +
        `Binding ${LOOPBACK_HOST} only.`,
    );
  }
  return LOOPBACK_HOST;
}

export async function startHttpServer(): Promise<HttpServer> {
  checkInsecureDevEnv();
  const isGatewayMode = resolveAuthMode() === 'gateway';
  if (!isGatewayMode) checkEnvCredentials();
  const s2sSecret = resolveS2sSecret();
  const port = parseInt(process.env.MCP_HTTP_PORT || '8080', 10);
  const host = resolveListenHost(s2sSecret);
  const allowedHosts = parseAllowedHosts(process.env.MCP_ALLOWED_HOSTS);
  setGatewayMode(isGatewayMode);

  const httpServer = createHttpServer(async (req, res) => {
    // Responses carry tenant data or auth outcomes; nothing in between may cache them.
    res.setHeader('Cache-Control', 'no-store');

    // Only the path matters for routing. Parse against a fixed base so a
    // missing or malformed Host header can't throw out of the handler.
    let url: URL;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      sendJson(res, 400, { error: 'Bad request' });
      return;
    }

    if (url.pathname === '/health') {
      // /health is container LIVENESS, not credential-readiness. It stays
      // unauthenticated, does not call getCredentials(), and never returns
      // a credential. `configured` is only whether the env credentials are set.
      sendJson(res, 200, {
        status: 'ok',
        transport: 'http',
        mode: isGatewayMode ? 'gateway' : 'standalone',
        credentials: {
          configured:
            !isGatewayMode &&
            Boolean(process.env.MARKETSHARP_COMPANY_ID && process.env.MARKETSHARP_API_KEY && process.env.MARKETSHARP_API_SECRET),
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (url.pathname !== '/mcp') {
      sendJson(res, 404, { error: 'Not found', endpoints: ['/mcp', '/health'] });
      return;
    }

    if (!hostAllowed(req, allowedHosts)) {
      sendJson(res, 403, { error: 'Forbidden: Host header is not in MCP_ALLOWED_HOSTS.' });
      return;
    }

    // S2S guard runs before anything else touches the request: a forged
    // request must never reach credential extraction or the MCP
    // server/transport. Empty s2sSecret is only reachable when MCP_ALLOW_INSECURE_DEV=1.
    if (s2sSecret && !verifyS2sHeader(headerValue(req.headers[S2S_HEADER]), s2sSecret)) {
      sendJson(res, 401, S2S_UNAUTHORIZED);
      return;
    }

    // Stateless JSON only. A GET would open the SDK's standalone SSE stream,
    // which stays open holding a tenant's credential context; DELETE has no
    // session to end. Checked after S2S so unsigned callers still get 401.
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      sendJson(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this server is stateless; use POST.' }, id: null });
      return;
    }

    // Body cap runs only after S2S passes so unauthenticated callers still get 401.
    // Chunked bodies have no Content-Length; the transport's maxRequestBodySize covers them.
    const contentLength = Number(headerValue(req.headers['content-length']));
    if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BODY_BYTES) {
      sendJson(res, 413, {
        jsonrpc: '2.0',
        error: { code: -32600, message: `Request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes` },
        id: null,
      });
      return;
    }

    const handle = async () => {
      // SECURITY-CRITICAL invariant: this transport MUST stay stateless
      // (sessionIdGenerator: undefined + enableJsonResponse: true).
      // Per-request tenant credentials are carried in an AsyncLocalStorage
      // context opened by runWithCredentials() below. A stateless
      // request->single-response flow keeps the tool call inside that
      // context - switching to a stateful/SSE transport would let a
      // long-lived connection serve later messages under a stale/foreign
      // credential context.
      // X-Conduit-Tool-Tiers can only narrow the container's tiers; present-but-empty means no tools.
      const server = createServer(narrowTiers(configuredTiers(), tierHeader(req.headers[TOOL_TIERS_HEADER])));
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
      });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      // A throw here would otherwise be an unhandled rejection from the
      // 'request' listener, which kills the process (and every tenant on it)
      // under Node's default --unhandled-rejections=throw. Log the error type
      // only: the message may carry request data.
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (err) {
        logger.error('MCP request failed', { error: (err as Error)?.name ?? typeof err });
        if (!res.headersSent) sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
      }
    };

    // Gateway mode: the MarketSharp credentials must arrive on every request
    // as headers. Reject explicitly if any required one is missing rather
    // than falling through to MARKETSHARP_* in the process environment,
    // which is not request-scoped (CWE-306). x-marketsharp-employee-id is
    // optional. Ids are shape-checked before use.
    if (isGatewayMode) {
      const companyId = headerValue(req.headers['x-marketsharp-company-id'])?.trim();
      const apiKey = headerValue(req.headers['x-marketsharp-api-key'])?.trim();
      const apiSecret = headerValue(req.headers['x-marketsharp-api-secret']);
      const employeeId = headerValue(req.headers['x-marketsharp-employee-id'])?.trim() || undefined;
      if (!companyId || !apiKey || !apiSecret) {
        sendJson(res, 401, GATEWAY_CREDENTIALS_UNAUTHORIZED);
        return;
      }
      if (!ID_RE.test(companyId) || (employeeId !== undefined && !ID_RE.test(employeeId))) {
        sendJson(res, 400, INVALID_ID_HEADER);
        return;
      }
      await runWithCredentials({ companyId, apiKey, apiSecret, employeeId }, handle);
      return;
    }

    // Env / single-tenant mode: tools resolve MARKETSHARP_* from the process
    // environment. S2S is still enforced when a secret is configured.
    await handle();
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      logger.info(`HTTP streaming server listening on ${host}:${port}`, { s2sEnforced: s2sSecret !== '' });
      resolve();
    });
  });

  return httpServer;
}

// Entry point. Vitest imports this module to call startHttpServer. Skip the
// CLI entrypoint there. `node dist/http.js` still starts HTTP or stdio.
if (process.env.VITEST !== 'true') {
  if (process.env.MCP_TRANSPORT === 'http') {
    startHttpServer().catch((error) => {
      logger.error('Fatal startup error', error);
      process.exit(1);
    });
  } else {
    await import('./index.js');
  }
}
