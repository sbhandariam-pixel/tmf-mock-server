// Local smoke test. Drives api/index.js through a real HTTP server that mimics
// Vercel's Node runtime (res.status/res.json helpers + JSON body parsing).
//
// Operation coverage is generated from tmf-spec.json rather than hand-written,
// so adding a path to the spec adds a test case for free.
// Set before requiring the handler, which reads the level at module load.
// The invalid-body case trips Prism's validator on purpose; failures print
// the response body, so the logs add nothing here.
process.env.PRISM_LOG_LEVEL = process.env.PRISM_LOG_LEVEL || 'silent';

const http = require('http');
const $RefParser = require('@stoplight/json-schema-ref-parser');
const handler = require('../api/index.js');
const rawSpec = require('../tmf-spec.json');
const { listTools, callTool } = require('../lib/tools.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const SAMPLE_ID = '1234';

// Build the smallest body the schema will accept: required properties only.
// The dereferenced spec is cyclic (ProductOrder -> productOrderItem -> product
// -> productOrder), so guard the current branch and cap the depth.
function minimalBody(schema, seen = new Set(), depth = 0) {
  if (!schema || depth > 6 || seen.has(schema)) return undefined;

  if (schema.enum) return schema.enum[0];

  switch (schema.type) {
    case 'object':
    case undefined: {
      if (!schema.properties) return {};
      const branch = new Set(seen).add(schema);
      const out = {};
      for (const key of schema.required || []) {
        const value = minimalBody(schema.properties[key], branch, depth + 1);
        if (value !== undefined) out[key] = value;
      }
      return out;
    }
    case 'array': {
      const item = minimalBody(schema.items, new Set(seen).add(schema), depth + 1);
      return item === undefined ? [] : [item];
    }
    case 'string':
      if (schema.format === 'date-time') return '2024-01-01T00:00:00Z';
      if (schema.format === 'uri') return 'https://example.com';
      return 'test';
    case 'integer':
    case 'number':
      return 1;
    case 'boolean':
      return true;
    default:
      return 'test';
  }
}

function successCode(responses) {
  const codes = Object.keys(responses || {})
    .map(Number)
    .filter(c => c >= 200 && c < 300);
  return codes.length ? Math.min(...codes) : 200;
}

function specCases(spec) {
  const cases = [];
  for (const [pathKey, pathItem] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      const bodyParam = (op.parameters || []).find(p => p.in === 'body');
      cases.push({
        name: `${method.toUpperCase()} ${pathKey}`,
        method: method.toUpperCase(),
        path: pathKey.replace(/\{[^}]+\}/g, SAMPLE_ID),
        body: bodyParam ? minimalBody(bodyParam.schema) : undefined,
        expect: successCode(op.responses),
      });
    }
  }
  return cases;
}

// Behaviour the spec can't describe: routing, Prefer, validation, CORS.
const BEHAVIOUR_CASES = [
  { name: 'basePath routing', method: 'GET',
    path: '/tmf-api/productOrderingManagement/v4/productOrder', expect: 200 },
  { name: 'query parameters', method: 'GET',
    path: '/productOrder?state=acknowledged&limit=2', expect: 200 },
  { name: 'Prefer: code=404', method: 'GET', path: '/productOrder/1234',
    headers: { Prefer: 'code=404' }, expect: 404 },
  { name: 'Prefer: code=409', method: 'GET', path: '/productOrder',
    headers: { Prefer: 'code=409' }, expect: 409 },
  { name: 'Prefer: dynamic=true', method: 'GET', path: '/productOrder',
    headers: { Prefer: 'dynamic=true' }, expect: 200 },
  { name: 'invalid body rejected', method: 'POST', path: '/productOrder',
    body: { bogus: true }, expect: 400 },
  { name: 'unknown route', method: 'GET', path: '/nope', expect: 404 },
  { name: 'CORS preflight', method: 'OPTIONS', path: '/productOrder', expect: 204 },
];

const server = http.createServer((req, res) => {
  res.status = code => { res.statusCode = code; return res; };
  res.json = payload => {
    if (!res.getHeader('content-type')) res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(payload));
    return res;
  };
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    if (raw && (req.headers['content-type'] || '').includes('json')) {
      try { req.body = JSON.parse(raw); } catch { req.body = raw; }
    } else if (raw) {
      req.body = raw;
    }
    handler(req, res).catch(err => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: err.message }));
    });
  });
});

function call(c) {
  return new Promise((resolve, reject) => {
    const payload = c.body !== undefined ? JSON.stringify(c.body) : null;
    const req = http.request({
      port: server.address().port,
      method: c.method,
      path: c.path,
      headers: {
        ...(c.headers || {}),
        ...(payload ? {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        } : {}),
      },
    }, res => {
      let out = '';
      res.on('data', d => { out += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function run(title, cases, width) {
  console.log(`\n${title}`);
  let failed = 0;
  for (const c of cases) {
    const started = Date.now();
    const r = await call(c);
    const ok = r.status === c.expect;
    if (!ok) failed++;
    console.log(
      `  ${ok ? 'ok  ' : 'FAIL'} ${c.name.padEnd(width)} ` +
      `${String(r.status).padEnd(3)} ${ok ? '' : `(expected ${c.expect})`}` +
      `${ok ? `${Date.now() - started}ms` : ` ${r.body.slice(0, 120)}`}`
    );
  }
  return failed;
}

// Every operation again, this time through the MCP tool layer rather than HTTP.
async function runMcpTools(spec, width) {
  console.log(`\nMCP tools (${listTools().length})`);
  let failed = 0;

  for (const [pathKey, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op || !op.operationId) continue;

      const args = {};
      for (const param of op.parameters || []) {
        if (param.in === 'path') args[param.name] = SAMPLE_ID;
        else if (param.in === 'body') args.body = minimalBody(param.schema);
      }

      const expect = successCode(op.responses);
      const started = Date.now();
      const result = await callTool(op.operationId, args);
      const ok = result.status === expect;
      if (!ok) failed++;
      console.log(
        `  ${ok ? 'ok  ' : 'FAIL'} ${op.operationId.padEnd(width)} ` +
        `${String(result.status).padEnd(3)} ` +
        `${ok ? `${Date.now() - started}ms` : `(expected ${expect})`}`
      );
    }
  }
  return failed;
}

// The tool layer is reachable in-process; this proves the stdio transport
// actually speaks MCP, which is the part a client depends on.
async function runStdioTransport(width) {
  console.log('\nMCP stdio transport (2)');
  const client = new Client({ name: 'smoke', version: '1.0.0' }, { capabilities: {} });
  let failed = 0;
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [require.resolve('./mcp.js')],
      stderr: 'ignore',
    }));

    const { tools } = await client.listTools();
    const listOk = tools.length === listTools().length;
    if (!listOk) failed++;
    console.log(`  ${listOk ? 'ok  ' : 'FAIL'} ${'tools/list'.padEnd(width)} ${tools.length} tools`);

    const res = await client.callTool({
      name: 'retrieveProductOrder',
      arguments: { id: SAMPLE_ID, prefer: 'code=409' },
    });
    const status = JSON.parse(res.content[0].text).status;
    const callOk = status === 409;
    if (!callOk) failed++;
    console.log(`  ${callOk ? 'ok  ' : 'FAIL'} ${'tools/call (Prefer)'.padEnd(width)} ${status}`);

    await client.close();
  } catch (err) {
    console.log(`  FAIL ${'stdio transport'.padEnd(width)} ${err.message}`);
    failed += 2;
  }
  return failed;
}

(async () => {
  const spec = await new $RefParser().dereference(JSON.parse(JSON.stringify(rawSpec)));
  const operations = specCases(spec);
  const width = Math.max(
    ...[...operations, ...BEHAVIOUR_CASES].map(c => c.name.length),
    ...listTools().map(t => t.name.length)
  );

  await new Promise(resolve => server.listen(0, resolve));

  const failed =
    await run(`REST operations (${operations.length})`, operations, width) +
    await run(`REST behaviour (${BEHAVIOUR_CASES.length})`, BEHAVIOUR_CASES, width) +
    await runMcpTools(spec, width) +
    await runStdioTransport(width);

  const total = operations.length + BEHAVIOUR_CASES.length + listTools().length + 2;
  console.log(`\n${total - failed}/${total} passed\n`);
  server.close();
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
