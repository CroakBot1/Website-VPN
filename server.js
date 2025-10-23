require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const rateLimit = require('express-rate-limit');
const { URL } = require('url');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.raw({ type: '*/*', limit: '15mb' }));

const PORT = process.env.PORT || 3000;
const VALID_TOKENS = (process.env.VALID_TOKENS || '').split(',').map(s => s.trim());
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
const PROXY_NODES = (process.env.PROXY_NODES || '').split(',').map(s => s.trim());
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
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: PROXY_RATE_LIMIT
}));

// Helpers
function isValidUrl(u) { try { return ['http:', 'https:'].includes(new URL(u).protocol); } catch { return false; } }
function isValidToken(t) { return t && VALID_TOKENS.includes(t); }

let rrCounter = 0;
function pickNodeRoundRobin() {
  const idx = (rrCounter++) % PROXY_NODES.length;
  return PROXY_NODES[idx];
}
function selectUpstream(req) {
  return ROTATION_MODE === 'sticky_by_ip' ? PROXY_NODES[0] : pickNodeRoundRobin();
}

// Health
app.get('/health', (req, res) => res.json({ ok: true, nodes: PROXY_NODES.length, mode: ROTATION_MODE }));

// Proxy
app.all('/proxy', async (req, res) => {
  try {
    const token = req.headers['x-proxy-auth'] || req.query.token;
    if (!isValidToken(token)) return res.status(401).send('Unauthorized');

    const target = req.query.url;
    if (!target || !isValidUrl(target)) return res.status(400).send('Invalid url');

    const upstreamBase = selectUpstream(req);
    const upstreamUrl = `${upstreamBase.replace(/\/$/, '')}/proxy?url=${encodeURIComponent(target)}`;

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!['host','connection','content-length','accept-encoding'].includes(k.toLowerCase())) {
        headers[k] = v;
      }
    }
    headers['x-proxy-auth'] = token;

    const fetchOptions = {
      method: req.method,
      headers,
      body: ['GET','HEAD'].includes(req.method) ? undefined : req.body,
      redirect: 'follow'
    };

    const upstreamResp = await fetch(upstreamUrl, fetchOptions);
    upstreamResp.headers.forEach((val, name) => {
      if (!['connection','transfer-encoding'].includes(name.toLowerCase())) res.setHeader(name, val);
    });

    res.status(upstreamResp.status);
    const buffer = await upstreamResp.buffer();
    res.send(buffer);

  } catch (err) {
    console.error(err);
    res.status(502).send('Bad Gateway');
  }
});

app.listen(PORT, () => {
  console.log(`Rotating proxy gateway listening on port ${PORT}`);
  console.log(`Nodes: ${PROXY_NODES.length}, Mode: ${ROTATION_MODE}`);
});
