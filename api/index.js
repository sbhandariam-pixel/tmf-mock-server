// REST surface: every TMF operation at its spec path, mocked by Prism.
const { request, logger } = require('../lib/prism.js');

// Prism's IHttpRequest wants Dictionary<string>; Node can hand us string[].
function flattenHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    out[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
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
    const response = await request({
      method: req.method,
      url: req.url,
      headers: flattenHeaders(req.headers),
      body: req.body,
    });

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
