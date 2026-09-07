const { createClientFromOperations } = require('@stoplight/prism-http/dist/client');
const { getHttpOperationsFromSpec } = require('@stoplight/prism-http');

// Static require so Vercel's file tracer bundles the spec into the function.
// (fs.readFileSync(process.cwd() + '/...') is NOT traced and 404s once deployed.)
const spec = require('../tmf-spec.json');

// Prism only ever calls child/debug/info/warn/error/success on its logger, so a
// shim beats pulling in pino -- the version we'd resolve (10.x) is not the one
// Prism bundles (6.x), and its `success` level is a Prism invention regardless.
const LEVELS = { debug: 10, info: 20, success: 20, warn: 30, error: 40, silent: 99 };
const THRESHOLD = LEVELS[process.env.PRISM_LOG_LEVEL] || LEVELS.warn;

function makeLogger(bindings = {}) {
  const emit = level => (...args) => {
    if (LEVELS[level] < THRESHOLD) return;
    // Prism calls both log(msg) and log(context, msg).
    const [first, second] = args;
    const context = typeof first === 'object' && first !== null ? first : {};
    const msg = second !== undefined ? second : first;
    console.log(JSON.stringify({ level, ...bindings, ...context, msg }));
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

// Prism's IHttpRequest wants Dictionary<string>; Node can hand us string[].
function flattenHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    out[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Prefer');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  try {
    const client = await getClient();
    const headers = flattenHeaders(req.headers);

    const response = await client.request(
      stripBasePath(req.url),
      { method: req.method.toLowerCase(), headers, body: req.body },
      { ...DEFAULT_CONFIG, mock: mockConfigFromPrefer(headers.prefer) }
    );

    for (const [key, value] of Object.entries(response.headers || {})) {
      // Don't let a mocked content-length contradict what we actually write.
      if (key.toLowerCase() === 'content-length') continue;
      res.setHeader(key, value);
    }

    res.status(response.status);
    if (response.data === undefined) res.end();
    else res.json(response.data);
  } catch (error) {
    const status = error.status || 500;
    // A 4xx is the mock behaving correctly (unrouted path, failed validation);
    // only a 5xx is our problem, so don't drown the logs in expected errors.
    const log = status >= 500 ? logger.error : logger.debug;
    log({ err: error, url: req.url }, 'request failed');
    res.status(status).json({
      type: error.type || 'https://stoplight.io/prism/errors#UNKNOWN',
      title: error.name || 'Internal Server Error',
      status,
      detail: error.detail || error.message,
    });
  }
};
