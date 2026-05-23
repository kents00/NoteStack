const BACKEND_URL = process.env.BACKEND_URL;

export default async function handler(req, res) {
  const { path } = req.query;
  const targetPath = Array.isArray(path) ? path.join('/') : path;

  // Build the query string from the original request
  const url = new URL(req.url, `http://${req.headers.host}`);
  const queryString = url.search || '';

  const targetUrl = `${BACKEND_URL}/api/${targetPath}${queryString}`;

  // Forward select headers, skip hop-by-hop headers
  const skipHeaders = new Set([
    'host', 'connection', 'transfer-encoding', 'keep-alive',
    'upgrade', 'proxy-connection', 'te', 'trailer',
  ]);

  const forwardHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!skipHeaders.has(key.toLowerCase())) {
      forwardHeaders[key] = value;
    }
  }

  // Determine body
  let body = undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  }

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: forwardHeaders,
      body,
    });

    // Check if this is a streaming SSE response
    const contentType = upstream.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream')) {
      res.writeHead(upstream.status, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(decoder.decode(value, { stream: true }));
        }
      } catch {
        // Client disconnected
      } finally {
        res.end();
      }
      return;
    }

    // Regular response: forward status, headers, and body
    const responseHeaders = {};
    const skipResponseHeaders = new Set([
      'transfer-encoding', 'content-encoding', 'connection',
    ]);

    upstream.headers.forEach((value, key) => {
      if (!skipResponseHeaders.has(key.toLowerCase())) {
        responseHeaders[key] = value;
      }
    });

    const data = await upstream.text();
    res.writeHead(upstream.status, responseHeaders);
    res.end(data);
  } catch (error) {
    res.status(502).json({ detail: 'Backend unavailable' });
  }
}
