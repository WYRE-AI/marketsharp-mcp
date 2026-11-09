import type { Tool, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { getCredentials, MarketSharpApiError, marketsharpRequest } from '../client.js';
import { configuredTiers, writesEnabled, type ToolTier } from '../config.js';
import { MAX_RESPONSE_CHARS } from '../input-limits.js';
import { redactText } from '../redact.js';
import { wrapUntrusted } from '../untrusted.js';
import { TOOLS, type ToolDef } from './definitions.js';

export { TOOLS } from './definitions.js';
export type { ToolDef } from './definitions.js';
export { writesEnabled };

export interface CallToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const BY_NAME = new Map<string, ToolDef>(TOOLS.map((t) => [t.name, t]));

export function annotationsFor(tier: ToolTier): ToolAnnotations {
  return tier === 'read'
    ? { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    : { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
}

/**
 * Tools enabled for this call: the container's tiers (read, plus write when
 * MARKETSHARP_ENABLE_WRITES is on), narrowed by `tiers` when the request sent
 * X-Conduit-Tool-Tiers. `tiers` can never add a tier the container lacks.
 */
export function selectTools(env: NodeJS.ProcessEnv = process.env, tiers?: ReadonlySet<ToolTier>): ToolDef[] {
  const configured = configuredTiers(env);
  return TOOLS.filter((t) => configured.has(t.tier) && (!tiers || tiers.has(t.tier)));
}

export function listTools(env: NodeJS.ProcessEnv = process.env, tiers?: ReadonlySet<ToolTier>): Tool[] {
  return selectTools(env, tiers).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: annotationsFor(t.tier),
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
 * Runs a tool. Re-checks the enabled set, so a hidden tool can't be called by
 * name. A tool outside the request's narrowed tiers reads as an unknown tool.
 * All output (results and errors) is redacted of the credentials in use.
 */
export async function dispatchToolCall(
  name: string,
  args: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
  tiers?: ReadonlySet<ToolTier>
): Promise<CallToolResult> {
  const tool = BY_NAME.get(name);
  if (!tool || (tiers && !tiers.has(tool.tier))) return errorResult(`Unknown tool: ${name}`);
  if (tool.tier === 'write' && !writesEnabled(env)) {
    return errorResult(`${name} is turned off because creating records in MarketSharp is off in this container. An admin can turn it on with MARKETSHARP_ENABLE_WRITES=true.`);
  }
  const creds = getCredentials(env);
  if (!creds) {
    return errorResult('MarketSharp credentials are not configured. Set the Company ID, API key and API secret on this connection.');
  }
  const redact = (text: string) => redactText(text, [creds.apiKey, creds.apiSecret]);
  try {
    const input = pickDeclaredArgs(tool, args);
    const text = tool.run ? await tool.run(input, creds) : await marketsharpRequest(creds, tool.build!(input, creds));
    // renderBody already capped `text` and appended its own truncation note; leave room for that note.
    return { content: [{ type: 'text', text: wrapUntrusted(redact(text), MAX_RESPONSE_CHARS + 1_000) }] };
  } catch (err) {
    const message = redact((err as Error).message);
    const status = err instanceof MarketSharpApiError ? err.status : undefined;
    const unreachable = message.startsWith("Couldn't reach MarketSharp:");
    // Token-step failures happen before any request is sent and already say when to retry.
    const signInFailure = message.startsWith('MarketSharp sign-in failed');
    if (!signInFailure && (unreachable || (status !== undefined && status >= 500))) {
      return errorResult(
        tool.tier === 'write'
          ? `${message} The create may already have gone through. Check MarketSharp before trying again, or you may create a duplicate.`
          : `${message} Try again in a minute.`
      );
    }
    return errorResult(message);
  }
}
