import http from 'http';
import https from 'https';

export default async function handler(req, res) {
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

    const forwardHeaders = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
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

    const fetchOptions = {
      method: req.method,
      headers: forwardHeaders,
      redirect: 'manual',
    };

    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
      let bodyData;
      if (Buffer.isBuffer(req.body) || typeof req.body === 'string') {
        bodyData = req.body;
      } else if (typeof req.body === 'object') {
        if (req.headers['content-type']?.includes('application/x-www-form-urlencoded')) {
          bodyData = new URLSearchParams(req.body).toString();
        } else {
          bodyData = JSON.stringify(req.body);
        }
      }
      
      if (bodyData) {
        fetchOptions.body = bodyData;
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
