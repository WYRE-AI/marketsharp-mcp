import type { Tool, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { getCredentials, MarketSharpApiError, marketsharpRequest } from '../client.js';
import { TOOLS, type ToolDef, type ToolTier } from './definitions.js';

export { TOOLS } from './definitions.js';
export type { ToolDef } from './definitions.js';

export interface CallToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const BY_NAME = new Map<string, ToolDef>(TOOLS.map((t) => [t.name, t]));

/** Writes are off unless MARKETSHARP_ENABLE_WRITES is exactly true/1. There are no delete tools at all. */
export function writesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(true|1)$/i.test((env.MARKETSHARP_ENABLE_WRITES ?? '').trim());
}

export function annotationsFor(tier: ToolTier): ToolAnnotations {
  return tier === 'read' ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
}

export function selectTools(env: NodeJS.ProcessEnv = process.env): ToolDef[] {
  const writes = writesEnabled(env);
  return TOOLS.filter((t) => t.tier === 'read' || writes);
}

export function listTools(env: NodeJS.ProcessEnv = process.env): Tool[] {
  return selectTools(env).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: annotationsFor(t.tier),
  }));
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

/** Runs a tool. Re-checks the enabled set, so a hidden write can't be called by name. */
export async function dispatchToolCall(
  name: string,
  args: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env
): Promise<CallToolResult> {
  const tool = BY_NAME.get(name);
  if (!tool) return errorResult(`Unknown tool: ${name}`);
  if (tool.tier === 'write' && !writesEnabled(env)) {
    return errorResult(`${name} is turned off because creating records in MarketSharp is off on this server. An admin can turn it on with MARKETSHARP_ENABLE_WRITES=true.`);
  }
  try {
    const creds = getCredentials(env);
    if (!creds) {
      return errorResult('MarketSharp credentials are not configured. Set the Company ID, API key and API secret on this connection.');
    }
    const text = tool.run ? await tool.run(args, creds) : await marketsharpRequest(creds, tool.build!(args, creds));
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    const message = (err as Error).message;
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
