import type { Tool, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { getCredentials, marketsharpRequest } from '../client.js';
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
    return errorResult(`${name} is turned off. Making changes in MarketSharp is off by default for this connection.`);
  }
  try {
    const creds = getCredentials(env);
    if (!creds) {
      return errorResult('MarketSharp credentials are not configured. Set the Company ID, API key and API secret on this connection.');
    }
    const text = tool.run ? await tool.run(args, creds) : await marketsharpRequest(creds, tool.build!(args, creds));
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return errorResult((err as Error).message);
  }
}
