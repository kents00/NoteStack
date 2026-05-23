import http from 'http';
import https from 'https';

export const config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};

export default function handler(req, res) {
  const BACKEND_URL = process.env.BACKEND_URL;
  if (!BACKEND_URL) {
    res.status(500).json({ detail: 'BACKEND_URL is not set' });
    return;
  }

  try {
    const originalUrl = new URL(req.url, `http://${req.headers.host}`);
    let { path } = req.query;
    const targetPath = Array.isArray(path) ? path.join('/') : (path || '');
    
    originalUrl.searchParams.delete('path');
    const queryString = originalUrl.search;

    const targetUrlStr = `${BACKEND_URL}/api/${targetPath}${queryString}`;
    const targetUrl = new URL(targetUrlStr);

    const forwardHeaders = { ...req.headers };
    delete forwardHeaders.host;
    delete forwardHeaders.connection;
    delete forwardHeaders['keep-alive'];

    const options = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method: req.method,
      headers: forwardHeaders,
    };

    const requestModule = targetUrl.protocol === 'https:' ? https : http;

    const proxyReq = requestModule.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('error', (err) => {
      console.error('Proxy error:', err);
      if (!res.headersSent) {
        res.status(502).json({ detail: 'Backend unavailable', error: err.message });
      } else {
        res.end();
      }
    });

    req.pipe(proxyReq, { end: true });
  } catch (error) {
    console.error('Proxy init error:', error);
    res.status(500).json({ detail: 'Proxy setup failed', error: error.message });
  }
}
