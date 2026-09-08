// Shared Prism engine. The REST handler (api/index.js) and both MCP entry
// points (api/mcp.js, scripts/mcp.js) go through this, so routing, Prefer
// handling and spec loading have exactly one implementation.
const { createClientFromOperations } = require('@stoplight/prism-http/dist/client');
const { getHttpOperationsFromSpec } = require('@stoplight/prism-http');

// Static require so Vercel's file tracer bundles the spec into the function.
// (fs.readFileSync(process.cwd() + '/...') is NOT traced and 404s once deployed.)
const spec = require('../tmf-spec.json');

// Prism only ever calls child/debug/info/warn/error/success on its logger, so a
// shim beats pulling in pino -- the version we'd resolve (10.x) is not the one
// Prism bundles (6.x), and its `success` level is a Prism invention regardless.
// Everything goes to stderr: stdout is the MCP stdio transport's wire format.
const LEVELS = { debug: 10, info: 20, success: 20, warn: 30, error: 40, silent: 99 };
const THRESHOLD = LEVELS[process.env.PRISM_LOG_LEVEL] || LEVELS.warn;

function makeLogger(bindings = {}) {
  const emit = level => (...args) => {
    if (LEVELS[level] < THRESHOLD) return;
    // Prism calls both log(msg) and log(context, msg).
    const [first, second] = args;
    const context = typeof first === 'object' && first !== null ? first : {};
    const msg = second !== undefined ? second : first;
    console.error(JSON.stringify({ level, ...bindings, ...context, msg }));
  };
  return {
    child: extra => makeLogger({ ...bindings, ...extra }),
    debug: emit('debug'),
    info: emit('info'),
    success: emit('success'),
    warn: emit('warn'),
    error: emit('error'),
  };
}

const logger = makeLogger();

const DEFAULT_CONFIG = {
  mock: { dynamic: process.env.PRISM_DYNAMIC === 'true' },
  validateRequest: true,
  validateResponse: true,
  checkSecurity: false,
  errors: false,
  upstreamProxy: undefined,
  logger,
};

// Prism routes on the raw OpenAPI path ("/productOrder"), but TMF clients call
// the full URL including basePath ("/tmf-api/productOrderingManagement/v4/...").
// Accept both by stripping the prefix when it's there.
const BASE_PATH = String(spec.basePath || '').replace(/\/+$/, '');

// Build the client once per warm lambda; cache the promise so concurrent
// invocations during a cold start share a single parse of the spec.
let clientPromise;
function getClient() {
  if (!clientPromise) {
    clientPromise = getHttpOperationsFromSpec(JSON.parse(JSON.stringify(spec)))
      .then(operations => {
        if (!operations.length) throw new Error('No operations found in tmf-spec.json');
        return createClientFromOperations(operations, DEFAULT_CONFIG);
      })
      .catch(err => {
        clientPromise = undefined; // let the next request retry
        throw err;
      });
  }
  return clientPromise;
}

// The `Prefer: code=404, dynamic=true` handling lives in Prism's CLI, not in the
// library, so parse it here and fold it into the per-request mock config.
function mockConfigFromPrefer(preferHeader) {
  const mock = { ...DEFAULT_CONFIG.mock };
  if (!preferHeader) return mock;

  for (const part of preferHeader.split(',')) {
    const [rawKey, ...rest] = part.split('=');
    const key = rawKey.trim().toLowerCase();
    const value = rest.join('=').trim();
    if (key === 'code') mock.code = Number(value);
    else if (key === 'dynamic') mock.dynamic = value === 'true';
    else if (key === 'example') mock.exampleKey = value;
    else if (key === 'seed') mock.seed = value;
  }
  if (Number.isNaN(mock.code)) delete mock.code;
  return mock;
}

function stripBasePath(rawUrl) {
  const url = new URL(rawUrl, 'https://prism.local');
  if (BASE_PATH && url.pathname.startsWith(BASE_PATH)) {
    url.pathname = url.pathname.slice(BASE_PATH.length) || '/';
  }
  return url.pathname + url.search;
}

// Resolves to { status, headers, data }. Rejects with a ProblemJsonError-shaped
// error carrying .status for anything Prism refuses outright.
async function request({ method, url, headers = {}, body }) {
  const client = await getClient();
  const mock = mockConfigFromPrefer(headers.prefer);
  const target = stripBasePath(url);
  const input = { method: String(method).toLowerCase(), headers, body };

  try {
    return await client.request(target, input, { ...DEFAULT_CONFIG, mock });
  } catch (error) {
    // json-schema-faker trips over TMF's recursive schemas (ProductOrder ->
    // productOrderItem -> product -> productOrder) and throws from clean().
    // It picks a generation depth at random, so this fires intermittently on
    // requests that are perfectly valid. Static values beat a 500.
    const dynamicFailed = mock.dynamic && (!error.status || error.status >= 500);
    if (!dynamicFailed) throw error;

    logger.warn(
      { url: target, err: error.message },
      'dynamic generation failed; falling back to static'
    );
    const response = await client.request(target, input, {
      ...DEFAULT_CONFIG,
      mock: { ...mock, dynamic: false },
    });
    // Say so on the wire rather than passing static data off as generated.
    return {
      ...response,
      headers: { ...response.headers, 'x-prism-dynamic-fallback': 'true' },
    };
  }
}

module.exports = { request, logger, spec, BASE_PATH };
