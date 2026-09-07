const { createInstance } = require('@stoplight/prism-http');
const fs = require('fs');
const path = require('path');

// 1. Load the TM Forum specification file
const specPath = path.join(process.cwd(), 'tmf-spec.json');
const specContent = fs.readFileSync(specPath, 'utf-8');
const operations = JSON.parse(specContent);

// 2. Initialize the Prism engine instance
const prism = createInstance(operations, {
  mock: { dynamic: false } // Set to true if you want randomized data instead of static examples
});

module.exports = async (req, res) => {
  // CORS Headers to allow your frontend apps to connect to this mock
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle preflight OPTIONS requests immediately
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // 3. Reconstruct the full path and query string for Prism
  const urlParams = req.url.split('?');
  const pathName = urlParams[0];
  const queryString = urlParams[1] ? `?${urlParams[1]}` : '';

  try {
    // 4. Run the request through Prism's routing and mock engine
    const response = await prism.request({
      method: req.method.toLowerCase(),
      url: {
        path: pathName,
        query: req.query,
      },
      headers: req.headers,
      body: req.body,
    });

    // 5. Send Prism's generated response back to the client
    res.status(response.status);
    
    // Set headers returned by Prism
    if (response.headers) {
      Object.entries(response.headers).forEach(([key, value]) => {
        res.setHeader(key, value);
      });
    }

    res.json(response.data);
  } catch (error) {
    // Catch cases like NO_PATH_MATCHED_ERROR gracefully
    res.status(error.status || 500).json({
      type: error.type || "https://stoplight.io",
      title: error.title || "Internal Server Error",
      status: error.status || 500,
      detail: error.detail || error.message
    });
  }
};
