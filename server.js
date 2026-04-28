const express = require('express');
const cors = require('cors');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const ALPACA_BASE = 'https://paper-api.alpaca.markets/v2';
const TELEGRAM_TOKEN = '8537812125:AAGQDJEDEp8E9ewfpiBk3kL7hKqCY2dWIyQ';
const TELEGRAM_CHAT_ID = 586400717;

// Serve trading agent UI
app.use(express.static(path.join(__dirname, 'public')));

// Alpaca proxy
app.all('/alpaca/*', async (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const url = ALPACA_BASE + '/' + req.params[0] + qs;
  try {
    const r = await fetch(url, { method: req.method, headers: { 'APCA-API-KEY-ID': req.headers['apca-api-key-id'], 'APCA-API-SECRET-KEY': req.headers['apca-api-secret-key'], 'Content-Type': 'application/json' }, body: req.method !== 'GET' && req.method !== 'DELETE' ? JSON.stringify(req.body) : undefined });
    const d = await r.json();
    res.status(r.status).json(d);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Claude proxy
app.post('/claude', async (req, res) => {
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': req.headers['x-api-key'], 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(req.body)
    });
    const d = await r.json();
    res.status(r.status).json(d);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Alpaca trade webhook (kept for compatibility)
app.post('/webhook/alpaca', async (req, res) => {
  res.sendStatus(200);
  const order = req.body?.data?.order || req.body?.order || req.body;
  if (!order || order.status !== 'filled') return;
  await sendTradeNotification(order);
});

// --- Filled-order polling ---

function buildTradeMessage(order) {
  const symbol = order.symbol || '?';
  const side = (order.side || '').toUpperCase();
  const qty = order.filled_qty || order.qty || '?';
  const price = parseFloat(order.filled_avg_price || 0).toFixed(2);
  const time = order.filled_at ? new Date(order.filled_at).toLocaleString() : new Date().toLocaleString();

  let type = 'entry';
  if (order.order_type === 'stop' || order.order_type === 'stop_limit') type = 'stop-loss';
  else if ((order.side || '').toLowerCase() === 'sell' && order.order_type === 'limit') type = 'take-profit';

  return `✅ ${symbol} filled - ${side} ${qty} shares @ $${price}\nType: ${type}\nTime: ${time}`;
}

async function sendTelegram(text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text })
  });
}

async function sendTradeNotification(order) {
  try {
    await sendTelegram(buildTradeMessage(order));
  } catch (e) { console.error('Telegram error:', e.message); }
}

const seenOrderIds = new Set();

async function pollFilledOrders() {
  const key = process.env.ALPACA_KEY;
  const secret = process.env.ALPACA_SECRET;
  if (!key || !secret) {
    console.warn('ALPACA_KEY / ALPACA_SECRET not set — skipping poll');
    return;
  }

  try {
    const r = await fetch(`${ALPACA_BASE}/orders?status=filled&limit=50`, {
      headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret }
    });
    if (!r.ok) { console.error('Alpaca poll error:', r.status); return; }
    const orders = await r.json();

    for (const order of orders) {
      if (seenOrderIds.has(order.id)) continue;
      seenOrderIds.add(order.id);
      await sendTradeNotification(order);
    }
  } catch (e) { console.error('Poll error:', e.message); }
}

app.listen(process.env.PORT || 3001, () => {
  console.log('Server running');
  pollFilledOrders();
  setInterval(pollFilledOrders, 30_000);
});
