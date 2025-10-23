// server.js
// Authenticated rotating proxy gateway
// Deploy this gateway where clients connect. It will forward /proxy requests
// to one of the upstream proxy nodes (round-robin or sticky by IP).
//
// Environment variables:
// - VALID_TOKENS         (comma-separated tokens allowed to use the gateway)
// - ALLOWED_ORIGINS      (comma-separated origins for CORS, optional)
// - PROXY_NODES          (comma-separated upstream base URLs, required)
// - ROTATION_MODE        ('round_robin' (default) or 'sticky_by_ip')
// - PROXY_RATE_LIMIT     (requests per minute per IP, default 120)

const express = require('express');
const fetch = require('node-fetch');
const rateLimit = require('express-rate-limit');
const { URL } = require('url');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.raw({ type: '*/*', limit: '15mb' }));

const PORT = process.env.PORT || 3000;
const VALID_TOKENS = (process.env.VALID_TOKENS || '').split(',').map(s => s.trim()).filter(Boolean);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s=>s.trim()).filter(Boolean);
const PROXY_NODES = (process.env.PROXY_NODES || '').split(',').map(s=>s.trim()).filter(Boolean);
const ROTATION_MODE = (process.env.ROTATION_MODE || 'round_robin');
const PROXY_RATE_LIMIT = parseInt(process.env.PROXY_RATE_LIMIT || '120', 10);

if (!PROXY_NODES.length) {
  console.error('ERROR: PROXY_NODES env var is required (comma-separated list of upstream proxy base URLs).');
  process.exit(1);
}

// Basic CORS handling
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

// Rate limiter
const proxyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: PROXY_RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false
});

// helpers
function isValidUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (e) { return false; }
}
function isValidToken(t) {
  if (!t) return false;
  if (VALID_TOKENS.length === 0) return false;
  return VALID_TOKENS.includes(t);
}
function hashStringToInt(s) {
  // simple deterministic hash -> integer
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

// rotation state
let rrCounter = 0;
function pickNodeRoundRobin() {
  const idx = (rrCounter++) % PROXY_NODES.length;
  return PROXY_NODES[idx];
}
function pickNodeStickyByIp(req) {
  const ip = (req.ip || req.headers['x-forwarded-for'] || '').split(',')[0] || '';
  if (ip) {
    const idx = hashStringToInt(ip) % PROXY_NODES.length;
    return PROXY_NODES[idx];
  }
  // fallback to cookie if present
  const cookie = (req.headers.cookie || '').split(';').map(c=>c.trim()).find(c=>c.startsWith('proxy-node='));
  if (cookie) {
    const val = cookie.split('=')[1] || '';
    const idx = PROXY_NODES.indexOf(decodeURIComponent(val));
    if (idx >= 0) return PROXY_NODES[idx];
  }
  return pickNodeRoundRobin();
}
function selectUpstream(req) {
  if (ROTATION_MODE === 'sticky_by_ip') return pickNodeStickyByIp(req);
  return pickNodeRoundRobin();
}

// simple health
app.get('/health', (req, res) => {
  res.json({ ok: true, nodes: PROXY_NODES.length, mode: ROTATION_MODE });
});

// token validation endpoint (optional)
app.post('/validate-key', (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).send('token required');
  if (isValidToken(token)) return res.sendStatus(200);
  return res.status(401).send('invalid token');
});

// Main proxy endpoint - gateway that forwards to one of upstream nodes
app.all('/proxy', proxyLimiter, async (req, res) => {
  try {
    // validate client token
    const tokenFromHeader = req.headers['x-proxy-auth'];
    const tokenFromQuery = req.query.token;
    const token = tokenFromHeader || tokenFromQuery;
    if (!isValidToken(token)) return res.status(401).send('Unauthorized: invalid or missing token');

    const target = req.query.url;
    if (!target || !isValidUrl(target)) return res.status(400).send('Missing/invalid url parameter');

    // pick upstream node
    const upstreamBase = selectUpstream(req);
    if (!upstreamBase) return res.status(500).send('No upstream nodes available');

    // build upstream URL (assume upstream nodes host /proxy as well)
    const upstreamUrl = `${upstreamBase.replace(/\/$/, '')}/proxy?url=${encodeURIComponent(target)}`;

    // forward headers (exclude hop-by-hop and host)
    const outgoingHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const name = k.toLowerCase();
      if (['host','connection','content-length','accept-encoding'].includes(name)) continue;
      outgoingHeaders[k] = v;
    }
    // ensure client token forwarded so upstream node can authorize
    if (tokenFromHeader) {
      outgoingHeaders['x-proxy-auth'] = tokenFromHeader;
    } else if (tokenFromQuery) {
      // keep token in header for convenience
      outgoingHeaders['x-proxy-auth'] = tokenFromQuery;
    }

    // mark which upstream was chosen (for debugging) - also set cookie for sticky scenario
    if (ROTATION_MODE === 'sticky_by_ip') {
      // instruct client to set cookie with upstream base for future requests
      res.setHeader('Set-Cookie', `proxy-node=${encodeURIComponent(upstreamBase)}; HttpOnly; Secure; Path=/; SameSite=Lax`);
    }

    // execute fetch to upstream
    const fetchOptions = {
      method: req.method,
      headers: outgoingHeaders,
      redirect: 'follow',
      body: ['GET','HEAD'].includes(req.method) ? undefined
            : req.body && req.body.length ? req.body
            : undefined,
      compress: false
    };

    const upstreamResp = await fetch(upstreamUrl, fetchOptions);

    // copy upstream status and headers (filter hop-by-hop)
    upstreamResp.headers.forEach((val, name) => {
      const lname = name.toLowerCase();
      if (['connection','transfer-encoding','keep-alive','proxy-authorization','proxy-authenticate','te','trailers','upgrade'].includes(lname)) return;
      res.setHeader(name, val);
    });
    res.status(upstreamResp.status);

    // pipe body
    const buffer = await upstreamResp.buffer();
    res.send(buffer);

  } catch (err) {
    console.error('Gateway proxy error:', err && err.stack ? err.stack : err);
    res.status(502).send('Bad Gateway');
  }
});

app.use((req, res) => res.status(404).send('Not Found'));

app.listen(PORT, () => {
  console.log(`Rotating proxy gateway listening on port ${PORT}`);
  console.log(`Nodes: ${PROXY_NODES.length}, Mode: ${ROTATION_MODE}`);
  if (!VALID_TOKENS.length) console.warn('WARNING: VALID_TOKENS empty (no token will be accepted).');
});
