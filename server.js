// server.js (Node + Express)
const express = require('express');
const fetch = require('node-fetch'); // package.json will include node-fetch
const { URL } = require('url');

const app = express();
app.use(express.raw({ type: '*/*', limit: '10mb' })); // raw body passthrough
const PORT = process.env.PORT || 3000;

// CORS: allow your site (or set to *) — for production, restrict to your origin.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // change to your site origin
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function isValidUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (e) { return false; }
}

app.all('/proxy', async (req, res) => {
  const target = req.query.url;
  if (!target || !isValidUrl(target)) {
    return res.status(400).send('Missing or invalid url parameter');
  }

  try {
    // Build options for fetch
    const headers = {};
    // copy some headers from incoming request to outgoing (but avoid host-related and hop-by-hop)
    for (const [k, v] of Object.entries(req.headers)) {
      if (['host','connection','accept-encoding','content-length'].includes(k.toLowerCase())) continue;
      headers[k] = v;
    }

    const fetchOptions = {
      method: req.method,
      headers,
      redirect: 'follow',
      body: ['GET','HEAD'].includes(req.method) ? undefined : req.body && req.body.length ? req.body : undefined,
      compress: false
    };

    const upstream = await fetch(target, fetchOptions);

    // copy status and headers (filter hop-by-hop)
    upstream.headers.forEach((value, name) => {
      if (['connection','transfer-encoding','keep-alive','proxy-authorization','proxy-authenticate','te','trailers','upgrade'].includes(name.toLowerCase())) return;
      res.setHeader(name, value);
    });

    res.status(upstream.status);
    const buffer = await upstream.buffer();
    res.send(buffer);
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(502).send('Bad Gateway');
  }
});

app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
