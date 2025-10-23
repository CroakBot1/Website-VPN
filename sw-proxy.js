let proxyHost = null;
let authToken = null;
let enabled = false;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());

self.addEventListener('message', (e) => {
  const { type, proxyHost: h, token } = e.data || {};
  if (type === 'SET_PROXY_HOST') proxyHost = h;
  if (type === 'SET_AUTH_TOKEN') authToken = token;
  if (type === 'ENABLE_PROXY') enabled = true;
  if (type === 'DISABLE_PROXY') enabled = false;
});

self.addEventListener('fetch', (event) => {
  if (!enabled || !proxyHost) return;
  const url = event.request.url;
  if (url.startsWith(proxyHost)) return;

  event.respondWith(
    fetch(`${proxyHost}/proxy?url=${encodeURIComponent(url)}`, {
      method: event.request.method,
      headers: {
        ...Object.fromEntries(event.request.headers.entries()),
        'x-proxy-auth': authToken || ''
      },
      body: ['GET','HEAD'].includes(event.request.method) ? undefined : event.request.clone().body,
      redirect: 'follow'
    })
  );
});
