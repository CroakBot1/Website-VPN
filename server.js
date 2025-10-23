// server.js
// Multi-region rotating proxy gateway

const express = require('express');
const fetch = require('node-fetch');
const rateLimit = require('express-rate-limit');
const { URL } = require('url');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.raw({ type: '*/*', limit: '15mb' }));

const PORT = process.env.PORT || 3000;
const VALID_TOKENS = (process.env.VALID_TOKENS || '').split(',').map(s => s.trim()).filter(Boolean);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const PROXY_NODES = (process.env.PROXY_NODES || '').split(',').map(s => s.trim()).filter(Boolean);
const ROTATION_MODE = process.env.ROTATION_MODE || 'round_robin';
const PROXY_RATE_LIMIT = parseInt(process.env.PROXY_RATE_LIMIT || '120', 10);

if (!PROXY_NODES.length) {
  console.error('ERROR: PROXY_NODES env var is required');
  process.exit(1);
}

// CORS
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
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: PROXY_RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false
});

// Helpers
function isValidUrl(u) {
  try { return ['http:', 'https:'].includes(new URL(u).protocol); } catch { return false; }
}
function isValidToken(t) {
  return t && VALID_TOKENS.includes(t);
}
function hashStringToInt(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
}

// Rotation state
let rrCounter = 0;
function pickNodeRoundRobin() {
  const idx = (rrCounter++) % PROXY_NODES.length;
  return PROXY_NODES[idx];
}
function pickNodeStickyByIp(req) {
  const ip = (req.ip || req.headers['x-forwarded-for'] || '').split(',')[0] || '';
  if (ip) return PROXY_NODES[hashStringToInt(ip) % PROXY_NODES.length];
  return pickNodeRoundRobin();
}
function selectUpstream(req) {
  return ROTATION_MODE === 'sticky_by_ip' ? pickNodeStickyByIp(req) : pickNodeRoundRobin();
}

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, nodes: PROXY_NODES.length, mode: ROTATION_MODE });
});

// Token validation endpoint
app.post('/validate-key', (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).send('token required');
  if (isValidToken(token)) return res.sendStatus(200);
  return res.status(401).send('invalid token');
});

// Main proxy
app.all('/proxy', limiter, async (req, res) => {
  try {
    const token = req.headers['x-proxy-auth'] || req.query.token;
    if (!isValidToken(token)) return res.status(401).send('Unauthorized');

    const target = req.query.url;
    if (!target || !isValidUrl(target)) return res.status(400).send('Invalid url');

    const upstreamBase = selectUpstream(req);
    const upstreamUrl = `${upstreamBase.replace(/\/$/, '')}/proxy?url=${encodeURIComponent(target)}`;

    const outgoingHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!['host','connection','content-length','accept-encoding'].includes(k.toLowerCase())) {
        outgoingHeaders[k] = v;
      }
    }
    outgoingHeaders['x-proxy-auth'] = token;

    if (ROTATION_MODE === 'sticky_by_ip') {
      res.setHeader('Set-Cookie', `proxy-node=${encodeURIComponent(upstreamBase)}; HttpOnly; Secure; Path=/; SameSite=Lax`);
    }

    const fetchOptions = {
      method: req.method,
      headers: outgoingHeaders,
      redirect: 'follow',
      body: ['GET','HEAD'].includes(req.method) ? undefined : req.body && req.body.length ? req.body : undefined,
      compress: false
    };

    const upstreamResp = await fetch(upstreamUrl, fetchOptions);

    upstreamResp.headers.forEach((val, name) => {
      if (!['connection','transfer-encoding','keep-alive','proxy-authorization','proxy-authenticate','te','trailers','upgrade'].includes(name.toLowerCase())) {
        res.setHeader(name, val);
      }
    });

    res.status(upstreamResp.status);
    const buffer = await upstreamResp.buffer();
    res.send(buffer);

  } catch (err) {
    console.error('Gateway proxy error:', err.stack || err);
    res.status(502).send('Bad Gateway');
  }
});

app.use((req, res) => res.status(404).send('Not Found'));

app.listen(PORT, () => {
  console.log(`Rotating proxy gateway listening on port ${PORT}`);
  console.log(`Nodes: ${PROXY_NODES.length}, Mode: ${ROTATION_MODE}`);
});
