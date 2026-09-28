import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export interface McpServerConfig {
  name: string;
  version: string;
}

export function createMcpServer(config: McpServerConfig): McpServer {
  return new McpServer(config);
}

export function isMcpServerEntry(argv: readonly string[] = process.argv): boolean {
  const entryFile = argv[1] ?? '';
  return entryFile.endsWith('mcp-server.js') || entryFile.endsWith('mcp-server.bundle.js');
}

export async function startMcpServerStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
