const express = require('express');
const cors = require('cors');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const ALPACA_BASE = 'https://paper-api.alpaca.markets/v2';
const ALPACA_DATA_BASE = 'https://data.alpaca.markets/v2';
const TELEGRAM_TOKEN = '8537812125:AAGQDJEDEp8E9ewfpiBk3kL7hKqCY2dWIyQ';
const TELEGRAM_CHAT_ID = 586400717;

// Serve trading agent UI
app.use(express.static(path.join(__dirname, 'public')));

// Alpaca market data proxy (snapshots, bars, quotes)
app.all('/alpaca-data/*', async (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const url = ALPACA_DATA_BASE + '/' + req.params[0] + qs;
  try {
    const r = await fetch(url, { method: req.method, headers: { 'APCA-API-KEY-ID': req.headers['apca-api-key-id'], 'APCA-API-SECRET-KEY': req.headers['apca-api-secret-key'], 'Content-Type': 'application/json' } });
    const d = await r.json();
    res.status(r.status).json(d);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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

// --- Shared helpers ---

function classifyOrder(order) {
  if (order.order_class === 'bracket') return 'entry';
  if (order.order_type === 'stop' || order.order_type === 'stop_limit') return 'stop-loss';
  if (order.order_type === 'limit') return 'take-profit';
  return 'entry';
}

function buildTradeMessage(order) {
  const symbol = order.symbol || '?';
  const side = (order.side || '').toUpperCase();
  const qty = order.filled_qty || order.qty || '?';
  const price = parseFloat(order.filled_avg_price || 0).toFixed(2);
  const time = order.filled_at ? new Date(order.filled_at).toLocaleString() : new Date().toLocaleString();
  const type = classifyOrder(order);
  return `✅ ${symbol} filled - ${side} ${qty} shares @ $${price}\nType: ${type}\nTime: ${time}`;
}

async function sendTelegram(text) {
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text })
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Telegram API ${r.status}: ${body}`);
  }
}

async function sendTradeNotification(order) {
  try { await sendTelegram(buildTradeMessage(order)); }
  catch (e) { console.error('Telegram error:', e.message); }
}

// --- Filled-order polling (every 30s) ---

const seenOrderIds = new Set();

async function seedSeenOrders() {
  const key = process.env.ALPACA_KEY;
  const secret = process.env.ALPACA_SECRET;
  if (!key || !secret) return;
  try {
    const r = await fetch(`${ALPACA_BASE}/orders?status=filled&limit=50`, {
      headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret }
    });
    if (!r.ok) return;
    const orders = await r.json();
    for (const order of orders) seenOrderIds.add(order.id);
    console.log(`Seeded ${seenOrderIds.size} existing filled orders (no notifications)`);
  } catch (e) { console.error('Seed error:', e.message); }
}

async function pollFilledOrders() {
  const key = process.env.ALPACA_KEY;
  const secret = process.env.ALPACA_SECRET;
  if (!key || !secret) { console.warn('ALPACA_KEY / ALPACA_SECRET not set — skipping poll'); return; }

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

// --- Daily summary at 21:00 UTC (4pm ET) ---

let lastSummaryDate = null;

async function sendDailySummary() {
  const key = process.env.ALPACA_KEY;
  const secret = process.env.ALPACA_SECRET;
  if (!key || !secret) return;

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  try {
    const r = await fetch(
      `${ALPACA_BASE}/orders?status=all&limit=200&after=${todayStart.toISOString()}&nested=true`,
      { headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret } }
    );
    if (!r.ok) { console.error('Daily summary fetch error:', r.status); return; }
    const orders = await r.json();

    // Only completed bracket trades (entry filled, one leg filled)
    const brackets = orders.filter(o => o.order_class === 'bracket' && o.status === 'filled');
    let winners = 0, losers = 0, totalPnl = 0, openTrades = 0;

    for (const entry of brackets) {
      const entryPrice = parseFloat(entry.filled_avg_price || 0);
      const qty = parseFloat(entry.filled_qty || entry.qty || 0);
      const filledLeg = (entry.legs || []).find(l => l.status === 'filled');

      if (!filledLeg) { openTrades++; continue; }

      const exitPrice = parseFloat(filledLeg.filled_avg_price || 0);
      const pnl = entry.side === 'buy'
        ? (exitPrice - entryPrice) * qty
        : (entryPrice - exitPrice) * qty;

      totalPnl += pnl;
      filledLeg.order_type === 'limit' ? winners++ : losers++;
    }

    const closed = winners + losers;
    const date = new Date().toLocaleDateString('en-US', {
      timeZone: 'America/New_York', weekday: 'long', month: 'short', day: 'numeric'
    });
    const sign = totalPnl >= 0 ? '+' : '';
    const openNote = openTrades > 0 ? `\nStill open: ${openTrades}` : '';
    const text = `📊 Daily Summary — ${date}\nTrades closed: ${closed}${openNote}\nWinners ✅: ${winners}  Losers ❌: ${losers}\nNet P&L: ${sign}$${totalPnl.toFixed(2)}`;

    await sendTelegram(text);
    console.log('Daily summary sent');
  } catch (e) { console.error('Daily summary error:', e.message); }
}

setInterval(() => {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  if (now.getUTCHours() === 21 && now.getUTCMinutes() === 0 && lastSummaryDate !== dateStr) {
    lastSummaryDate = dateStr;
    sendDailySummary();
  }
}, 60_000);

app.listen(process.env.PORT || 3001, async () => {
  console.log('Server running');
  await seedSeenOrders();
  setInterval(pollFilledOrders, 30_000);
});
