import http from 'http';
import https from 'https';

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
    // Since we reconstruct the body, we must remove chunked encoding and let Content-Length rule
    delete forwardHeaders['transfer-encoding'];

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
        res.status(502).json({ detail: 'Backend unavailable', error: err.message, targetUrlStr });
      } else {
        res.end();
      }
    });

    // Vercel Serverless Functions consume the incoming stream and populate req.body.
    // If we try to pipe `req`, it will hang because the stream has already ended.
    if (req.method === 'GET' || req.method === 'HEAD') {
      proxyReq.end();
    } else if (req.body) {
      let bodyData;
      if (Buffer.isBuffer(req.body) || typeof req.body === 'string') {
        // Raw buffers (like multipart file uploads) or raw strings
        bodyData = req.body;
      } else if (typeof req.body === 'object') {
        // Vercel automatically parsed JSON or Form-Urlencoded
        if (req.headers['content-type']?.includes('application/x-www-form-urlencoded')) {
          bodyData = new URLSearchParams(req.body).toString();
        } else {
          bodyData = JSON.stringify(req.body);
        }
      }
      
      if (bodyData) {
        // The reconstructed body might be a slightly different size than the original request.
        // We MUST update the content-length header to prevent the backend from hanging.
        proxyReq.setHeader('content-length', Buffer.byteLength(bodyData));
        proxyReq.write(bodyData);
      }
      proxyReq.end();
    } else {
      // Fallback if Vercel hasn't consumed the body
      req.pipe(proxyReq, { end: true });
    }
  } catch (error) {
    console.error('Proxy init error:', error);
    res.status(500).json({ detail: 'Proxy setup failed', error: error.message });
  }
}
