// sw-proxy.js - Service Worker
let PROXY_HOST = 'https://website-vpn.onrender.com'; // default
let PROXY_ENABLED = true; // auto enable; page can toggle it via postMessage

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

// receive messages from the page script
self.addEventListener('message', (ev) => {
  const msg = ev.data || {};
  if (msg.type === 'SET_PROXY_HOST' && msg.proxyHost) {
    PROXY_HOST = msg.proxyHost;
    console.log('[SW-Proxy] PROXY_HOST set to', PROXY_HOST);
  } else if (msg.type === 'ENABLE_PROXY') {
    PROXY_ENABLED = true;
    console.log('[SW-Proxy] Proxy enabled');
  } else if (msg.type === 'DISABLE_PROXY') {
    PROXY_ENABLED = false;
    console.log('[SW-Proxy] Proxy disabled');
  }
});

// a simple predicate: which requests to proxy
function shouldProxyRequest(request) {
  // Don't proxy requests for same-origin static assets of this site (so SW itself, etc. not loop)
  try {
    const url = new URL(request.url);
    const selfOrigin = self.location.origin;
    // Only proxy cross-origin requests OR if you want to proxy everything set to true
    if (url.origin === selfOrigin) return false;
    // Skip chrome-extension:, data:, blob:, about:, filesystem: etc.
    if (!/^https?:$/.test(url.protocol)) return false;
    return PROXY_ENABLED;
  } catch (err) {
    return false;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;

  if (!shouldProxyRequest(req)) {
    return; // let it go to network normally
  }

  event.respondWith((async () => {
    try {
      // build proxy URL
      const target = req.url;
      const proxyUrl = `${PROXY_HOST.replace(/\/$/, '')}/proxy?url=${encodeURIComponent(target)}`;

      // clone headers (we allow passing most headers, but remove hop-by-hop)
      const headers = {};
      for (const [k, v] of req.headers.entries()) {
        if (['connection','proxy-authorization','proxy-authenticate','keep-alive','transfer-encoding','te','trailers','upgrade'].includes(k.toLowerCase())) continue;
        headers[k] = v;
      }

      // read body if present
      let body = undefined;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        try {
          body = await req.clone().arrayBuffer();
        } catch (e) {
          // if can't read body, proceed without body
          body = undefined;
        }
      }

      const proxyResp = await fetch(proxyUrl, {
        method: req.method,
        headers,
        body
      });

      // return response (clone so we can inspect)
      const resHeaders = new Headers(proxyResp.headers);
      // Remove disallowed hop-by-hop headers if present
      ['connection','transfer-encoding','keep-alive','proxy-authorization','proxy-authenticate','te','trailers','upgrade'].forEach(h => resHeaders.delete(h));

      const respBody = await proxyResp.arrayBuffer();
      return new Response(respBody, {
        status: proxyResp.status,
        statusText: proxyResp.statusText,
        headers: resHeaders
      });

    } catch (err) {
      console.error('[SW-Proxy] proxy failed', err);
      return new Response('Proxy error', { status: 502, statusText: 'Proxy error' });
    }
  })());
});
