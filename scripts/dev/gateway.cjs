// 開發測試用：模擬 Supabase 的 API 閘道（類似 Kong）。
// /auth/v1/* → 本機 supabase/auth（GoTrue），/rest/v1/* → 本機 PostgREST。
// 會檢查 apikey 標頭，並加上 CORS 標頭，讓網頁可以像連線 Supabase 一樣連線。
// 用法：ANON_KEY=... SERVICE_KEY=... node scripts/dev/gateway.cjs
const http = require('http');

const PORT = Number(process.env.GATEWAY_PORT || 54321);
const AUTH = process.env.AUTH_URL || 'http://127.0.0.1:9999';
const REST = process.env.REST_URL || 'http://127.0.0.1:3000';
const KEYS = new Set([process.env.ANON_KEY, process.env.SERVICE_KEY].filter(Boolean));
/** 設為 1 時模擬網路中斷（回傳 503），用來測試離線與重試。 */
let offline = false;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info, prefer, accept-profile, content-profile',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-max-age': '600',
};

http
  .createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }
    if (req.url === '/__offline/on' || req.url === '/__offline/off') {
      offline = req.url.endsWith('on');
      res.writeHead(200, CORS);
      return res.end(offline ? 'offline' : 'online');
    }
    if (offline) {
      res.writeHead(503, { ...CORS, 'content-type': 'application/json' });
      return res.end('{"message":"simulated outage"}');
    }
    const apikey = req.headers.apikey;
    // 與 Supabase 相同：信件中的驗證連結（瀏覽器直接開啟）不需要 apikey
    const open = /^\/auth\/v1\/(verify|callback|authorize|health)(\?|$)/.test(req.url);
    if (!open && !KEYS.has(apikey)) {
      res.writeHead(401, { ...CORS, 'content-type': 'application/json' });
      return res.end('{"message":"Invalid API key"}');
    }
    let target;
    if (req.url.startsWith('/auth/v1/')) target = AUTH + req.url.slice('/auth/v1'.length);
    else if (req.url.startsWith('/rest/v1/')) target = REST + req.url.slice('/rest/v1'.length);
    else {
      res.writeHead(404, CORS);
      return res.end();
    }
    const url = new URL(target);
    const headers = { ...req.headers, host: url.host };
    // Kong 會在沒有 Authorization 時以 apikey 代替
    if (!headers.authorization && apikey) headers.authorization = `Bearer ${apikey}`;
    const proxy = http.request(url, { method: req.method, headers }, (upstream) => {
      const out = { ...upstream.headers, ...CORS };
      // 重新導向（例如信件連結驗證）回傳給瀏覽器
      res.writeHead(upstream.statusCode, out);
      upstream.pipe(res);
    });
    proxy.on('error', (error) => {
      res.writeHead(502, CORS);
      res.end(String(error));
    });
    req.pipe(proxy);
  })
  .listen(PORT, '127.0.0.1', () => console.log(`gateway on http://localhost:${PORT}`));
