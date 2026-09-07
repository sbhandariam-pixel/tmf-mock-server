const { createInstance } = require('@stoplight/prism-http');
const fs = require('fs');
const path = require('path');

// 1. Load the TM Forum specification file safely
const specPath = path.join(process.cwd(), 'tmf-spec.json');
let operations = [];
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
  // CORS Headers to ensure any client can connect
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, __prism___status');

  // Handle preflight OPTIONS requests instantly
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    // 3. Use Node's URL parser to prevent any undefined length issues
    // Vercel gives us req.url (like "/productOrder?id=1") but no base domain, so we pass a placeholder base
    const parsedUrl = new URL(req.url, 'http://localhost');
    
    // Convert URLSearchParams into a plain dictionary object for Prism
    const queryObj = {};
    parsedUrl.searchParams.forEach((value, key) => {
      queryObj[key] = value;
    });

    // 4. Feed the fully-structured request object strictly into Prism's engine
    const response = await prism.request({
      method: req.method.toLowerCase(),
      url: {
        path: parsedUrl.pathname, // This isolates just the path text string safely
        query: queryObj          // This avoids the raw Vercel object mapping
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
    // Catch cases like NO_PATH_MATCHED_ERROR elegantly without crashing Vercel
    res.status(error.status || 500).json({
      type: error.type || "https://stoplight.io",
      title: error.title || "Internal Server Error",
      status: error.status || 500,
      detail: error.detail || error.message
    });
  }
};

