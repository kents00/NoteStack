import http from 'http';
import https from 'https';

export const config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};

export default async function handler(req, res) {
  const BACKEND_URL = process.env.BACKEND_URL;
  if (!BACKEND_URL) {
    res.status(500).json({ detail: 'BACKEND_URL is not set' });
    return;
  }

  let targetUrlStr = '';

  try {
    const originalUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let { path } = req.query || {};
    const targetPath = Array.isArray(path) ? path.join('/') : (path || '');
    
    originalUrl.searchParams.delete('path');
    const queryString = originalUrl.search;

    targetUrlStr = `${BACKEND_URL}/api/${targetPath}${queryString}`;

    const forwardHeaders = new Headers();
    for (const [key, value] of Object.entries(req.headers || {})) {
      const lowerKey = key.toLowerCase();
      // Do not forward Vercel-specific or connection headers
      if (!['host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length'].includes(lowerKey)) {
        if (Array.isArray(value)) {
          value.forEach(v => forwardHeaders.append(key, v));
        } else {
          forwardHeaders.set(key, value);
        }
      }
    }

    // Forward the original Content-Length if available
    if (req.headers['content-length']) {
      forwardHeaders.set('content-length', req.headers['content-length']);
    }

    // Bypass ngrok warning page for server-to-server API requests
    forwardHeaders.set('ngrok-skip-browser-warning', 'true');

    const fetchOptions = {
      method: req.method,
      headers: forwardHeaders,
      redirect: 'manual',
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // Read the raw request stream into a buffer
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      if (chunks.length > 0) {
        fetchOptions.body = Buffer.concat(chunks);
      }
    }

    const response = await fetch(targetUrlStr, fetchOptions);

    response.headers.forEach((value, key) => {
      const lowerKey = key.toLowerCase();
      if (lowerKey !== 'transfer-encoding' && lowerKey !== 'content-encoding') {
        res.setHeader(key, value);
      }
    });

    res.status(response.status);

    if (response.body) {
      // Stream the response back to the client
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } else {
      res.end();
    }
  } catch (error) {
    console.error('Proxy fetch error:', error);
    res.status(502).json({ 
      detail: 'Backend unavailable', 
      error: error.message, 
      targetUrlStr 
    });
  }
}
