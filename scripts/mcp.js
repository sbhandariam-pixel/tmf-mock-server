#!/usr/bin/env node
// MCP over stdio: the local transport, for wiring into Claude Code via
// .mcp.json. Serves the mock in-process -- no HTTP server needs to be running.
//
// stdout carries the MCP wire protocol, so nothing else may write to it.
// lib/prism.js logs to stderr for exactly this reason.
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { listTools, callTool, toContent } = require('../lib/tools.js');
const pkg = require('../package.json');

const server = new Server(
  { name: 'tmf-mock-server', version: pkg.version },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }));
server.setRequestHandler(CallToolRequestSchema, async req =>
  toContent(await callTool(req.params.name, req.params.arguments || {}))
);

server.connect(new StdioServerTransport()).catch(err => {
  console.error('MCP server failed to start:', err);
  process.exit(1);
});
