// MCP tool definitions derived from tmf-spec.json. Both transports
// (api/mcp.js over HTTP, scripts/mcp.js over stdio) share this, so the tool
// surface is generated once and stays in step with the spec.
const { request, spec } = require('./prism.js');

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

// Bodies are described rather than schema'd: the dereferenced TMF schemas are
// cyclic (ProductOrder -> productOrderItem -> product -> productOrder), so they
// cannot be serialised into an inputSchema. Prism validates the body anyway and
// returns a 400 naming the offending field, which is enough for a caller to
// correct itself.
function describeBody(param) {
  const schema = param.schema || {};
  const name = schema.title || param.name || 'body';
  const required = schema.required || [];
  return [
    `Request body (${name}).`,
    required.length ? `Required properties: ${required.join(', ')}.` : null,
  ].filter(Boolean).join(' ');
}

function parameterSchema(param) {
  const out = {
    type: param.type === 'integer' ? 'integer' : param.type || 'string',
    description: param.description || `${param.name} (${param.in} parameter)`,
  };
  if (param.enum) out.enum = param.enum;
  return out;
}

function buildTool(method, path, op) {
  const params = op.parameters || [];
  const properties = {};
  const required = [];

  for (const param of params) {
    if (param.in === 'path') {
      properties[param.name] = parameterSchema(param);
      required.push(param.name);
    } else if (param.in === 'query') {
      properties[param.name] = parameterSchema(param);
      if (param.required) required.push(param.name);
    } else if (param.in === 'body') {
      properties.body = { type: 'object', description: describeBody(param) };
      if (param.required) required.push('body');
    }
  }

  properties.prefer = {
    type: 'string',
    description:
      'Optional mock override, e.g. "code=409" to force a documented error ' +
      'response, or "dynamic=true" for generated rather than static values.',
  };

  const codes = Object.keys(op.responses || {}).join(', ');
  const description = [
    op.summary || `${method.toUpperCase()} ${path}`,
    op.description ? op.description.split('\n')[0] : null,
    `Maps to ${method.toUpperCase()} ${path}. Documented responses: ${codes}.`,
  ].filter(Boolean).join(' ');

  return {
    name: op.operationId || `${method}_${path.replace(/[^a-z0-9]+/gi, '_')}`,
    description,
    inputSchema: { type: 'object', properties, required },
    // Kept off the wire-facing shape; used by callTool to build the request.
    _op: { method, path, params },
  };
}

const TOOLS = (() => {
  const out = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      if (item[method]) out.push(buildTool(method, path, item[method]));
    }
  }
  return out;
})();

const BY_NAME = new Map(TOOLS.map(t => [t.name, t]));

// The MCP-visible shape, without the internal routing metadata.
function listTools() {
  return TOOLS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}

async function callTool(name, args = {}) {
  const tool = BY_NAME.get(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);

  const { method, path, params } = tool._op;
  let url = path;
  const query = new URLSearchParams();

  for (const param of params) {
    const value = args[param.name];
    if (value === undefined) continue;
    if (param.in === 'path') {
      url = url.replace(`{${param.name}}`, encodeURIComponent(String(value)));
    } else if (param.in === 'query') {
      query.set(param.name, String(value));
    }
  }
  if ([...query].length) url += `?${query}`;

  const headers = { 'content-type': 'application/json' };
  if (args.prefer) headers.prefer = String(args.prefer);

  try {
    const response = await request({ method, url, headers, body: args.body });
    return {
      status: response.status,
      body: response.data,
    };
  } catch (error) {
    // Prism rejects unroutable or invalid requests; surface that as a result
    // the caller can read rather than an opaque transport failure.
    return {
      status: error.status || 500,
      body: {
        title: error.name || 'Error',
        detail: error.detail || error.message,
      },
      isError: true,
    };
  }
}

// Shapes a callTool result as an MCP tool response.
function toContent(result) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ status: result.status, body: result.body }, null, 2),
    }],
    isError: Boolean(result.isError),
  };
}

module.exports = { listTools, callTool, toContent, TOOLS };
