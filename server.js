'use strict';
// ─────────────────────────────────────────────────────────────────
// Crypto AutoTrade Bot — Secure Local Proxy Server
// ─────────────────────────────────────────────────────────────────
require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const crypto     = require('crypto');
const fetch      = require('node-fetch');
const rateLimit  = require('express-rate-limit');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;
const MODE = process.env.MODE || 'paper';

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
  return crypto.createHmac('sha256', BINANCE_SECRET).update(queryString).digest('hex');
}
function timestamp() { return Date.now(); }

// ── Round quantity down to Binance stepSize ───────────────────────
function roundToStep(qty, stepSize) {
  const step = parseFloat(stepSize);
  if (!step || step === 0) return qty;
  const decimals = (stepSize.split('.')[1] || '').replace(/0+$/, '').length;
  const rounded = Math.floor(qty / step) * step;
  return parseFloat(rounded.toFixed(decimals));
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

// ── Exchange info cache (avoid hammering Binance) ─────────────────
const exchangeInfoCache = {};

async function getExchangeInfo(symbol) {
  if (exchangeInfoCache[symbol] && Date.now() - exchangeInfoCache[symbol].ts < 300000) {
    return exchangeInfoCache[symbol].data;
  }
  const r = await fetch(`${BINANCE_BASE}/api/v3/exchangeInfo?symbol=${symbol}`);
  const data = await r.json();
  if (data.code) throw new Error(data.msg);
  const sym = data.symbols?.[0];
  if (!sym) throw new Error('Symbol not found');

  const lotSize    = sym.filters.find(f => f.filterType === 'LOT_SIZE');
  const notional   = sym.filters.find(f => f.filterType === 'MIN_NOTIONAL') ||
                     sym.filters.find(f => f.filterType === 'NOTIONAL');
  const priceFilt  = sym.filters.find(f => f.filterType === 'PRICE_FILTER');

  const info = {
    stepSize:    lotSize?.stepSize    || '0.00001',
    minQty:      lotSize?.minQty      || '0.00001',
    maxQty:      lotSize?.maxQty      || '99999999',
    minNotional: notional?.minNotional || '10',
    tickSize:    priceFilt?.tickSize  || '0.01',
    baseAsset:   sym.baseAsset,
    quoteAsset:  sym.quoteAsset,
  };
  exchangeInfoCache[symbol] = { ts: Date.now(), data: info };
  return info;
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
// GET /exchangeinfo/:symbol — lot size, min notional, price filter
// ─────────────────────────────────────────────────────────────────
app.get('/exchangeinfo/:symbol', async (req, res) => {
  try {
    const info = await getExchangeInfo(req.params.symbol.toUpperCase());
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /account — fetch Binance account balances
// ─────────────────────────────────────────────────────────────────
app.get('/account', async (req, res) => {
  if (MODE === 'paper') {
    return res.json({ paper: true, balances: [] });
  }
  if (!BINANCE_API_KEY || !BINANCE_SECRET) {
    return res.status(400).json({ error: 'API keys not configured in .env' });
  }
  try {
    const ts  = timestamp();
    const qs  = `timestamp=${ts}`;
    const sig = sign(qs);
    const r   = await fetch(`${BINANCE_BASE}/api/v3/account?${qs}&signature=${sig}`, {
      headers: { 'X-MBX-APIKEY': BINANCE_API_KEY },
    });
    const data = await r.json();
    if (data.code) return res.status(400).json({ error: data.msg, code: data.code });
    const balances = (data.balances || []).filter(b => +b.free > 0 || +b.locked > 0);
    res.json({ balances, canTrade: data.canTrade });
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

  const { symbol, side, type, price } = req.body;
  let { quantity } = req.body;

  // ── PAPER MODE ───────────────────────────────────────────────
  if (MODE === 'paper') {
    console.log(`[PAPER] ${side} ${quantity} ${symbol} @ MARKET`);
    return res.json({
      paper: true,
      orderId: `PAPER_${Date.now()}`,
      symbol, side, type,
      executedQty: String(quantity),
      cummulativeQuoteQty: String(+quantity * +(price || 0)),
      status: 'FILLED',
      fills: [{ price: String(price || 0), qty: String(quantity), commission: '0' }],
    });
  }

  // ── LIVE MODE ────────────────────────────────────────────────
  if (!BINANCE_API_KEY || !BINANCE_SECRET) {
    return res.status(400).json({ error: 'API keys not configured in .env' });
  }

  try {
    // Fetch exchange info and round quantity to stepSize
    const info = await getExchangeInfo(symbol);
    quantity = roundToStep(+quantity, info.stepSize);

    // Check minimum quantity
    if (quantity < +info.minQty) {
      return res.status(400).json({
        error: `Quantity ${quantity} is below minimum ${info.minQty} for ${symbol}`,
      });
    }

    // Check minimum notional (need a price estimate for MARKET orders)
    if (price) {
      const notional = quantity * +price;
      if (notional < +info.minNotional) {
        return res.status(400).json({
          error: `Order value $${notional.toFixed(2)} is below minimum notional $${info.minNotional}`,
        });
      }
    }

    const ts = timestamp();
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
      const friendly = binanceErrorMsg(data.code, data.msg);
      console.error(`[LIVE] Binance error ${data.code}: ${data.msg}`);
      return res.status(400).json({ error: friendly, code: data.code });
    }

    console.log(`[LIVE] Order filled: orderId=${data.orderId} executedQty=${data.executedQty}`);
    res.json(data);
  } catch (err) {
    console.error('[LIVE] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Human-friendly Binance error messages ────────────────────────
function binanceErrorMsg(code, msg) {
  const map = {
    '-1013': 'Order size too small (below min notional or min qty)',
    '-1100': 'Invalid quantity format',
    '-1111': 'Quantity has too many decimal places',
    '-1121': 'Invalid trading pair symbol',
    '-2010': 'Insufficient balance for this order',
    '-1003': 'Too many requests — rate limit hit',
  };
  return map[String(code)] || msg;
}

// ─────────────────────────────────────────────────────────────────
// GET /price/:symbol — current price (no auth)
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
// Serve index.html
// ─────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, '127.0.0.1', () => {
  console.log('─────────────────────────────────────────');
  console.log('  Crypto AutoTrade Bot Server');
  console.log(`  http://127.0.0.1:${PORT}`);
  console.log(`  Mode: ${MODE.toUpperCase()}`);
  if (MODE === 'live') {
    console.log('  ⚠️  LIVE MODE — Real orders will execute!');
    console.log(`  Keys: ${BINANCE_API_KEY ? 'configured ✓' : 'MISSING ✗'}`);
  } else {
    console.log('  Paper trading — no real orders.');
  }
  console.log('─────────────────────────────────────────');
});
