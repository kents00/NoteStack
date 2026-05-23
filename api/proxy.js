import http from 'http';
import https from 'https';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default function handler(req, res) {
  const BACKEND_URL = process.env.BACKEND_URL;
  if (!BACKEND_URL) {
    res.status(500).json({ detail: 'BACKEND_URL is not set' });
    return;
  }

  // Vercel populates req.query with the path params from the rewrite
  let { path } = req.query;
  const targetPath = Array.isArray(path) ? path.join('/') : path || '';

  // Extract query string minus the rewrite parameter
  const originalUrl = new URL(req.url, `http://${req.headers.host}`);
  originalUrl.searchParams.delete('path');
  const queryString = originalUrl.search;

  const targetUrlStr = `${BACKEND_URL}/api/${targetPath}${queryString}`;
  const targetUrl = new URL(targetUrlStr);

  const forwardHeaders = { ...req.headers };
  // The host header must match the target backend
  delete forwardHeaders.host;

  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    path: targetUrl.pathname + targetUrl.search,
    method: req.method,
    headers: forwardHeaders,
  };

  const requestModule = targetUrl.protocol === 'https:' ? https : http;

  const proxyReq = requestModule.request(options, (proxyRes) => {
    // Forward the status and headers exactly as received
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    // Pipe the response body back to the client (supports SSE natively)
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', (err) => {
    console.error('Proxy error:', err);
    if (!res.headersSent) {
      res.status(502).json({ detail: 'Backend unavailable', error: err.message, targetUrlStr });
    } else {
      res.end();
    }
  });

  // Pipe the raw incoming request body directly to the backend
  // This preserves multipart/form-data for file uploads
  req.pipe(proxyReq, { end: true });
}
