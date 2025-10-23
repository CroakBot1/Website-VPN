// sw-proxy.js
// Handles routing all fetch requests through your rotating proxy gateway

let proxyHost = null;
let authToken = null;
let enabled = false;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());

// Message handler from frontend
self.addEventListener('message', (e) => {
  const { type, proxyHost: h, token } = e.data || {};
  if (type === 'SET_PROXY_HOST') proxyHost = h;
  if (type === 'SET_AUTH_TOKEN') authToken = token;
  if (type === 'ENABLE_PROXY') enabled = true;
  if (type === 'DISABLE_PROXY') enabled = false;
  console.log('[SW] State:', { enabled, proxyHost });
});

// Intercept all fetch requests
self.addEventListener('fetch', (event) => {
  if (!enabled || !proxyHost) return; // normal fetch
  const req = event.request;
  const url = req.url;

  // Prevent recursion
  if (url.startsWith(proxyHost)) return;

  event.respondWith(
    fetch(`${proxyHost}/proxy?url=${encodeURIComponent(url)}`, {
      method: req.method,
      headers: {
        ...Object.fromEntries(req.headers.entries()),
        'x-proxy-auth': authToken || ''
      },
      body: ['GET','HEAD'].includes(req.method) ? undefined : req.clone().body,
      redirect: 'follow'
    })
  );
});
