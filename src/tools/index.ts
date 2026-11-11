import type { Tool, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { getCredentials, MarketSharpApiError, MarketSharpError, marketsharpRequest } from '../client.js';
import { type ToolTier } from '../config.js';
import { MAX_RESPONSE_CHARS } from '../input-limits.js';
import { redactText } from '../redact.js';
import { wrapUntrusted } from '../untrusted.js';
import { logger } from '../utils/logger.js';
import { TOOLS, type ToolDef } from './definitions.js';

export { TOOLS } from './definitions.js';
export type { ToolDef } from './definitions.js';

export interface CallToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const BY_NAME = new Map<string, ToolDef>(TOOLS.map((t) => [t.name, t]));

/** Every tool only reads from MarketSharp. */
const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

/** Tools enabled for this call, narrowed by `tiers` when the request sent X-Conduit-Tool-Tiers. */
export function listTools(tiers?: ReadonlySet<ToolTier>): Tool[] {
  return TOOLS.filter((t) => !tiers || tiers.has(t.tier)).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: READ_ONLY,
  }));
}

/** Keeps only arguments declared in the tool's input schema; anything else never reaches a handler or MarketSharp. */
export function pickDeclaredArgs(tool: ToolDef, args: unknown): Record<string, unknown> {
  const source = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(tool.inputSchema.properties)) {
    if (Object.prototype.hasOwnProperty.call(source, key)) out[key] = source[key];
  }
  return out;
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

/**
 * Runs a tool. A tool outside the request's narrowed tiers reads as an
 * unknown tool. All output (results and errors) is redacted of the
 * credentials in use.
 */
export async function dispatchToolCall(
  name: string,
  args: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
  tiers?: ReadonlySet<ToolTier>
): Promise<CallToolResult> {
  const tool = BY_NAME.get(name);
  if (!tool || (tiers && !tiers.has(tool.tier))) return errorResult(`Unknown tool: ${name}`);
  const creds = getCredentials(env);
  if (!creds) {
    return errorResult('MarketSharp credentials are not configured. Set the Company ID, API key and API secret on this connection.');
  }
  const redact = (text: string) => redactText(text, [creds.apiKey, creds.apiSecret]);
  try {
    const input = pickDeclaredArgs(tool, args);
    const text = await marketsharpRequest(creds, tool.build(input, creds));
    // renderBody already capped `text` and appended its own truncation note; leave room for that note.
    return { content: [{ type: 'text', text: wrapUntrusted(redact(text), MAX_RESPONSE_CHARS + 1_000) }] };
  } catch (err) {
    // Only MarketSharp* errors carry text written to be shown to the model.
    // Anything else (a bug, a library error) may quote request data, so log
    // its name and code, never its message.
    if (!(err instanceof MarketSharpError)) {
      logger.error('Unexpected error in tool call', { tool: name, name: (err as Error)?.name, code: (err as { code?: unknown })?.code });
      return errorResult('Unexpected internal error');
    }
    const message = redact(err.message);
    const status = err instanceof MarketSharpApiError ? err.status : undefined;
    const unreachable = message.startsWith("Couldn't reach MarketSharp:");
    // Token-step failures happen before any request is sent and already say when to retry.
    const signInFailure = message.startsWith('MarketSharp sign-in failed');
    if (!signInFailure && (unreachable || (status !== undefined && status >= 500))) {
      return errorResult(`${message} Try again in a minute.`);
    }
    return errorResult(message);
  }
}
