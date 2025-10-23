// server.js
// Simple authenticated proxy server for browser Service Worker usage.
// - Expects x-proxy-auth header (or ?token= fallback) to match VALID_TOKENS env var.
// - Basic CORS handling, rate-limiting, hop-by-hop header filtering.
// - NOTE: This server will see proxied payloads. Use HTTPS and follow privacy rules.

const express = require('express');
const fetch = require('node-fetch'); // v2
const rateLimit = require('express-rate-limit');
const { URL } = require('url');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.raw({ type: '*/*', limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const VALID_TOKENS = (process.env.VALID_TOKENS || '').split(',').map(s => s.trim()).filter(Boolean);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const PROXY_RATE_LIMIT = parseInt(process.env.PROXY_RATE_LIMIT || '120', 10); // requests per minute per IP

// Basic CORS - prefer explicit origins in production
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.length && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (!ALLOWED_ORIGINS.length) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-proxy-auth');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Rate limiter applied to /proxy
const proxyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: PROXY_RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false
});

function isValidUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

function isValidToken(t) {
  if (!t) return false;
  if (VALID_TOKENS.length === 0) return false; // no tokens configured -> deny
  return VALID_TOKENS.includes(t);
}

// Lightweight health check
app.get('/health', (req, res) => {
  res.json({ ok: true, region: process.env.REGION || null });
});

// Optional: validate token from frontend (used by your UI if you want)
app.post('/validate-key', (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).send('token required');
  if (isValidToken(token)) return res.sendStatus(200);
  return res.status(401).send('invalid token');
});

// Proxy endpoint - requires token via header x-proxy-auth (or query ?token= for convenience)
app.all('/proxy', proxyLimiter, async (req, res) => {
  try {
    const tokenFromHeader = req.headers['x-proxy-auth'];
    const tokenFromQuery = req.query.token;
    const token = tokenFromHeader || tokenFromQuery;

    if (!isValidToken(token)) {
      return res.status(401).send('Unauthorized: invalid or missing token');
    }

    const target = req.query.url;
    if (!target || !isValidUrl(target)) {
      return res.status(400).send('Missing or invalid `url` query parameter');
    }

    // Build outgoing headers (copy most headers except hop-by-hop and host)
    const outgoingHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const name = k.toLowerCase();
      if (['host','connection','content-length','accept-encoding'].includes(name)) continue;
      outgoingHeaders[k] = v;
    }

    // If original request had a body, pass it through
    const fetchOptions = {
      method: req.method,
      headers: outgoingHeaders,
      redirect: 'follow',
      body: ['GET','HEAD'].includes(req.method) ? undefined
            : req.body && req.body.length ? req.body
            : undefined,
      // do not automatically decompress — keep simple
      compress: false
    };

    const upstream = await fetch(target, fetchOptions);

    // Forward status and filtered headers
    upstream.headers.forEach((value, name) => {
      const lname = name.toLowerCase();
      if (['connection','transfer-encoding','keep-alive','proxy-authorization','proxy-authenticate','te','trailers','upgrade'].includes(lname)) return;
      res.setHeader(name, value);
    });

    res.status(upstream.status);

    // Buffer and send (simple approach)
    const buffer = await upstream.buffer();
    res.send(buffer);

  } catch (err) {
    console.error('Proxy error:', err && err.stack ? err.stack : err);
    return res.status(502).send('Bad Gateway');
  }
});

// Fallback
app.use((req, res) => res.status(404).send('Not Found'));

app.listen(PORT, () => {
  console.log(`Authenticated proxy listening on port ${PORT}`);
  if (!VALID_TOKENS.length) {
    console.warn('WARNING: VALID_TOKENS is empty — no tokens will be accepted. Set VALID_TOKENS env var.');
  }
});
