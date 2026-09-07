// MCP over streamable HTTP: the deployed transport, for remote clients.
//   claude mcp add --transport http tmf https://<deployment>/api/mcp
//
// Stateless (no session id), because each Vercel invocation is a fresh process
// and there is nowhere to keep session state between them. enableJsonResponse
// returns a plain JSON body rather than holding an SSE stream open, which
// serverless functions cannot do.
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const {
  StreamableHTTPServerTransport,
} = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { listTools, callTool, toContent } = require('../lib/tools.js');
const { logger } = require('../lib/prism.js');
const pkg = require('../package.json');

function buildServer() {
  const server = new Server(
    { name: 'tmf-mock-server', version: pkg.version },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async req =>
    toContent(await callTool(req.params.name, req.params.arguments || {}))
  );
  return server;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id, mcp-protocol-version');
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  // Nothing outlives the invocation, so tear both down once the response ends.
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    logger.error({ err: error }, 'MCP request failed');
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: error.message },
        id: null,
      });
    }
  }
};
