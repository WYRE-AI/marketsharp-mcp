import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ToolTier } from './config.js';
import { dispatchToolCall, listTools } from './tools/index.js';
import { logger } from './utils/logger.js';
import { VERSION } from './version.js';

/** `tiers` is the request's narrowed tier set (X-Conduit-Tool-Tiers); undefined means the container's configured tiers. */
export function createServer(tiers?: ReadonlySet<ToolTier>): Server {
  const server = new Server({ name: 'marketsharp-mcp', version: VERSION }, { capabilities: { tools: {}, logging: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools(process.env, tiers) }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return await dispatchToolCall(name, (args || {}) as Record<string, unknown>, process.env, tiers);
    } catch (error) {
      logger.error('Tool call failed', { tool: name, error: (error as Error).message });
      return { content: [{ type: 'text' as const, text: 'Error: Unexpected internal error while calling MarketSharp.' }], isError: true };
    }
  });

  return server;
}
