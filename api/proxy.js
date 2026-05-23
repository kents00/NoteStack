export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  const BACKEND_URL = process.env.BACKEND_URL;
  if (!BACKEND_URL) {
    return new Response(JSON.stringify({ detail: 'BACKEND_URL is not set' }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const url = new URL(req.url);
    
    // Vercel rewrites add ?path=...
    const pathParam = url.searchParams.get('path') || '';
    
    // Remove the `path` param from the query string to forward the rest
    url.searchParams.delete('path');
    const queryString = url.search;

    const targetUrl = `${BACKEND_URL}/api/${pathParam}${queryString}`;

    // Create a new headers object to forward
    const forwardHeaders = new Headers(req.headers);
    
    // Crucial: Delete host and connection headers so fetch can set them correctly for the backend
    forwardHeaders.delete('host');
    forwardHeaders.delete('connection');
    forwardHeaders.delete('keep-alive');
    forwardHeaders.delete('upgrade');
    forwardHeaders.delete('x-forwarded-host');
    forwardHeaders.delete('x-forwarded-proto');
    forwardHeaders.delete('x-forwarded-for');

    const fetchOptions = {
      method: req.method,
      headers: forwardHeaders,
      redirect: 'manual',
    };

    // Only set body for methods that allow it
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      fetchOptions.body = req.body;
      fetchOptions.duplex = 'half'; // Required for Node 18+ / Edge fetch when passing a stream
    }

    const upstreamResponse = await fetch(targetUrl, fetchOptions);

    // Filter response headers
    const responseHeaders = new Headers(upstreamResponse.headers);
    responseHeaders.delete('content-encoding'); // Let Vercel handle compression
    responseHeaders.delete('transfer-encoding');

    // Return the response stream natively
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error("Edge Proxy fetch error:", error);
    return new Response(
      JSON.stringify({ detail: 'Backend unavailable', error: error.message }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
