import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { dispatchToolCall, listTools } from './tools/index.js';
import { logger } from './utils/logger.js';
import { VERSION } from './version.js';

export function createServer(): Server {
  const server = new Server({ name: 'marketsharp-mcp', version: VERSION }, { capabilities: { tools: {}, logging: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return await dispatchToolCall(name, (args || {}) as Record<string, unknown>);
    } catch (error) {
      logger.error('Tool call failed', { tool: name, error: (error as Error).message });
      return { content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }], isError: true };
    }
  });

  return server;
}
