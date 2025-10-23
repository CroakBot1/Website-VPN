// sw-proxy.js
let PROXY_HOST = 'https://website-vpn.onrender.com';
let PROXY_ENABLED = false;
let AUTH_TOKEN = null;

self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

self.addEventListener('message', ev => {
  const msg = ev.data || {};
  if (msg.type === 'SET_PROXY_HOST' && msg.proxyHost) {
    PROXY_HOST = msg.proxyHost;
    console.log('[SW] PROXY_HOST set', PROXY_HOST);
  } else if (msg.type === 'ENABLE_PROXY') {
    PROXY_ENABLED = true;
    console.log('[SW] Proxy enabled');
  } else if (msg.type === 'DISABLE_PROXY') {
    PROXY_ENABLED = false;
    console.log('[SW] Proxy disabled');
  } else if (msg.type === 'SET_AUTH_TOKEN') {
    AUTH_TOKEN = msg.token || null;
    console.log('[SW] Auth token updated');
  }
});

function shouldProxy(req) {
  if (!PROXY_ENABLED) return false;
  try {
    const url = new URL(req.url);
    if (url.origin === location.origin) return false;
    if (!/^https?:$/.test(url.protocol)) return false;
    if (url.origin === new URL(PROXY_HOST).origin) return false;
    return true;
  } catch (e) { return false; }
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (!shouldProxy(req)) return;

  event.respondWith((async () => {
    try {
      const target = req.url;
      const proxyUrl = `${PROXY_HOST.replace(/\/$/, '')}/proxy?url=${encodeURIComponent(target)}`;

      const headers = new Headers();
      for (const [k,v] of req.headers.entries()) {
        if (['connection','proxy-authorization','keep-alive','transfer-encoding','te','trailers','upgrade'].includes(k.toLowerCase())) continue;
        headers.set(k, v);
      }
      if (AUTH_TOKEN) headers.set('x-proxy-auth', AUTH_TOKEN);

      const fetchOptions = {
        method: req.method,
        headers,
        body: (req.method !== 'GET' && req.method !== 'HEAD') ? await req.clone().arrayBuffer().catch(()=>undefined) : undefined,
        redirect: 'follow'
      };

      const upstream = await fetch(proxyUrl, fetchOptions);
      const buf = await upstream.arrayBuffer();
      const resHeaders = new Headers(upstream.headers);
      ['connection','transfer-encoding','keep-alive','proxy-authorization','proxy-authenticate','te','trailers','upgrade'].forEach(h => resHeaders.delete(h));

      return new Response(buf, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: resHeaders
      });
    } catch (err) {
      console.error('[SW] proxy error', err);
      return new Response('Proxy error', { status: 502, statusText: 'Proxy error' });
    }
  })());
});
