'use strict';
// ─────────────────────────────────────────────────────────────────
// Crypto AutoTrade Bot — Secure Local Proxy Server
// ─────────────────────────────────────────────────────────────────
// This server runs on YOUR machine only.
// It signs Binance API requests using your secret key so the key
// is NEVER sent to the browser or exposed in network traffic.
// ─────────────────────────────────────────────────────────────────

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const crypto     = require('crypto');
const fetch      = require('node-fetch');
const rateLimit  = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 3001;
const MODE = process.env.MODE || 'paper'; // 'paper' or 'live'

const BINANCE_BASE    = 'https://api.binance.com';
const BINANCE_API_KEY = process.env.BINANCE_API_KEY || '';
const BINANCE_SECRET  = process.env.BINANCE_API_SECRET || '';

// ── Security: only allow requests from localhost ──────────────────
app.use(cors({
  origin: ['http://localhost:3001', 'http://127.0.0.1:3001', 'null'],
  methods: ['GET', 'POST', 'DELETE'],
}));

app.use(express.json());

// ── Rate limit: max 30 trade requests per minute ─────────────────
const tradeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests, slow down.' },
});

// ── HMAC-SHA256 signing ───────────────────────────────────────────
function sign(queryString) {
  return crypto
    .createHmac('sha256', BINANCE_SECRET)
    .update(queryString)
    .digest('hex');
}

function timestamp() {
  return Date.now();
}

// ── Validate order params before sending ─────────────────────────
function validateOrder(body) {
  const { symbol, side, type, quantity } = body;
  if (!symbol || typeof symbol !== 'string' || !/^[A-Z0-9]{3,12}$/.test(symbol))
    return 'Invalid symbol';
  if (!['BUY', 'SELL'].includes(side))
    return 'Invalid side';
  if (!['MARKET', 'LIMIT'].includes(type))
    return 'Invalid type';
  if (!quantity || isNaN(quantity) || +quantity <= 0)
    return 'Invalid quantity';
  return null;
}

// ─────────────────────────────────────────────────────────────────
// GET /status — health check + current mode
// ─────────────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
  const hasKeys = BINANCE_API_KEY.length > 0 && BINANCE_SECRET.length > 0;
  res.json({
    ok: true,
    mode: MODE,
    keysConfigured: hasKeys,
    message: MODE === 'paper'
      ? 'Paper trading — no real orders sent'
      : 'LIVE trading — real orders will execute on Binance',
  });
});

// ─────────────────────────────────────────────────────────────────
// GET /account — fetch Binance account balances
// ─────────────────────────────────────────────────────────────────
app.get('/account', async (req, res) => {
  if (MODE === 'paper') {
    return res.json({ paper: true, balances: [] });
  }
  try {
    const ts = timestamp();
    const qs = `timestamp=${ts}`;
    const sig = sign(qs);
    const url = `${BINANCE_BASE}/api/v3/account?${qs}&signature=${sig}`;
    const r = await fetch(url, {
      headers: { 'X-MBX-APIKEY': BINANCE_API_KEY },
    });
    const data = await r.json();
    if (data.code) return res.status(400).json({ error: data.msg });
    // Return only non-zero balances for safety
    const balances = (data.balances || []).filter(b => +b.free > 0 || +b.locked > 0);
    res.json({ balances });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /order — place a BUY or SELL order
// Body: { symbol, side, type, quantity, [price] }
// ─────────────────────────────────────────────────────────────────
app.post('/order', tradeLimiter, async (req, res) => {
  const validErr = validateOrder(req.body);
  if (validErr) return res.status(400).json({ error: validErr });

  const { symbol, side, type, quantity, price } = req.body;

  // ── PAPER MODE: simulate order, no real API call ──────────────
  if (MODE === 'paper') {
    console.log(`[PAPER] ${side} ${quantity} ${symbol} @ MARKET`);
    return res.json({
      paper: true,
      orderId: `PAPER_${Date.now()}`,
      symbol, side, type, quantity,
      status: 'FILLED',
      message: 'Paper trade — no real order placed',
    });
  }

  // ── LIVE MODE: sign and send to Binance ───────────────────────
  if (!BINANCE_API_KEY || !BINANCE_SECRET) {
    return res.status(400).json({ error: 'API keys not configured in .env' });
  }

  try {
    const ts  = timestamp();
    let params = `symbol=${symbol}&side=${side}&type=${type}&quantity=${quantity}&timestamp=${ts}`;
    if (type === 'LIMIT' && price) {
      params += `&price=${price}&timeInForce=GTC`;
    }
    const sig = sign(params);
    const url = `${BINANCE_BASE}/api/v3/order`;

    console.log(`[LIVE] ${side} ${quantity} ${symbol} type=${type}`);

    const r = await fetch(`${url}?${params}&signature=${sig}`, {
      method: 'POST',
      headers: { 'X-MBX-APIKEY': BINANCE_API_KEY },
    });
    const data = await r.json();
    if (data.code) {
      console.error(`[LIVE] Binance error ${data.code}: ${data.msg}`);
      return res.status(400).json({ error: data.msg, code: data.code });
    }
    console.log(`[LIVE] Order filled: ${JSON.stringify(data)}`);
    res.json(data);
  } catch (err) {
    console.error('[LIVE] Fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /price/:symbol — get current price (no auth needed)
// ─────────────────────────────────────────────────────────────────
app.get('/price/:symbol', async (req, res) => {
  try {
    const r = await fetch(`${BINANCE_BASE}/api/v3/ticker/price?symbol=${req.params.symbol}USDT`);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// DELETE /order — cancel an open order
// Body: { symbol, orderId }
// ─────────────────────────────────────────────────────────────────
app.delete('/order', tradeLimiter, async (req, res) => {
  if (MODE === 'paper') {
    return res.json({ paper: true, message: 'Paper order cancelled' });
  }
  const { symbol, orderId } = req.body;
  if (!symbol || !orderId) return res.status(400).json({ error: 'symbol and orderId required' });
  try {
    const ts  = timestamp();
    const params = `symbol=${symbol}&orderId=${orderId}&timestamp=${ts}`;
    const sig = sign(params);
    const r = await fetch(`${BINANCE_BASE}/api/v3/order?${params}&signature=${sig}`, {
      method: 'DELETE',
      headers: { 'X-MBX-APIKEY': BINANCE_API_KEY },
    });
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// Serve the bot HTML file at root
// ─────────────────────────────────────────────────────────────────
const path = require('path');
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '127.0.0.1', () => {
  console.log('─────────────────────────────────────────');
  console.log(`  Crypto AutoTrade Bot Server`);
  console.log(`  Running at http://127.0.0.1:${PORT}`);
  console.log(`  Mode: ${MODE.toUpperCase()}`);
  if (MODE === 'live') {
    console.log(`  ⚠️  LIVE MODE — Real orders will execute!`);
    console.log(`  Keys configured: ${BINANCE_API_KEY ? 'YES' : 'NO'}`);
  } else {
    console.log(`  Paper trading — no real orders.`);
  }
  console.log('─────────────────────────────────────────');
});
