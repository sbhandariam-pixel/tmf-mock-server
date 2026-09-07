const { createInstance } = require('@stoplight/prism-http');
const fs = require('fs');
const path = require('path');

// 1. Load the TM Forum specification file safely
const specPath = path.join(process.cwd(), 'tmf-spec.json');
let operations;
try {
  const specContent = fs.readFileSync(specPath, 'utf-8');
  operations = JSON.parse(specContent);
} catch (e) {
  console.error("Failed to read tmf-spec.json:", e);
}

// 2. Initialize the Prism engine instance
const prism = createInstance(operations, {
  mock: { dynamic: false } 
});

module.exports = async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // 3. Extract path safely from Vercel's request object
  // req.url might look like "/productOrder?id=123", we only want the path part before the "?"
  const [pathName] = req.url.split('?');

  try {
    // 4. Feed the cleaned request attributes into Prism
    const response = await prism.request({
      method: req.method.toLowerCase(),
      url: {
        path: pathName || '/',
        query: req.query || {},
      },
      headers: req.headers,
      body: req.body,
    });

    // 5. Send Prism's generated response back to the client
    res.status(response.status || 200);
    
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
