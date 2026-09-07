// Local smoke test: drives api/index.js through a real HTTP server that
// mimics Vercel's Node runtime (res.status/res.json helpers + JSON body parsing).
const http = require('http');
const handler = require('../api/index.js');

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
      res.end(JSON.stringify({ crash: err.message }));
    });
  });
});

const CASES = [
  { name: 'GET collection (bare path)', method: 'GET', path: '/productOrder' },
  { name: 'GET collection (basePath)', method: 'GET', path: '/tmf-api/productOrderingManagement/v4/productOrder' },
  { name: 'GET by id', method: 'GET', path: '/productOrder/1234' },
  { name: 'GET with query', method: 'GET', path: '/productOrder?state=acknowledged&limit=2' },
  { name: 'POST create', method: 'POST', path: '/productOrder',
    body: { productOrderItem: [{ id: '1', action: 'add' }] } },
  { name: 'Prefer: code=404', method: 'GET', path: '/productOrder/1234',
    headers: { Prefer: 'code=404' } },
  { name: 'unknown path -> 404', method: 'GET', path: '/nope' },
];

function call(c) {
  return new Promise(resolve => {
    const payload = c.body ? JSON.stringify(c.body) : null;
    const req = http.request({
      port: server.address().port, method: c.method, path: c.path,
      headers: { ...(c.headers || {}), ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) },
    }, res => {
      let out = '';
      res.on('data', d => { out += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

server.listen(0, async () => {
  let failures = 0;
  for (const c of CASES) {
    const t = Date.now();
    const r = await call(c);
    const ok = r.status < 500;
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} [${String(r.status).padEnd(3)}] ${c.name} (${Date.now() - t}ms)`);
    console.log(`       ${r.body.slice(0, 180)}`);
  }
  server.close();
  process.exit(failures ? 1 : 0);
});
