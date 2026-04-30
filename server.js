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
const TELEGRAM_CHAT_ID = 8018343254;

// Serve trading agent UI
app.use(express.static(path.join(__dirname, 'public')));

// Market data proxy — uses server-side bull keys (market data is the same for both accounts)
app.all('/alpaca-data/*', async (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const url = ALPACA_DATA_BASE + '/' + req.params[0] + qs;
  const key = process.env.ALPACA_KEY;
  const secret = process.env.ALPACA_SECRET;
  if (!key || !secret) return res.status(500).json({ error: 'ALPACA_KEY not configured on server' });
  try {
    const r = await fetch(url, { method: req.method, headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret, 'Content-Type': 'application/json' } });
    const d = await r.json();
    res.status(r.status).json(d);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Bull account proxy — server-side keys, used by UI for orders/positions/account info
app.all('/alpaca-bull/*', async (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const url = ALPACA_BASE + '/' + req.params[0] + qs;
  const key = process.env.ALPACA_KEY;
  const secret = process.env.ALPACA_SECRET;
  if (!key || !secret) return res.status(500).json({ error: 'ALPACA_KEY not configured on server' });
  try {
    const r = await fetch(url, { method: req.method, headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret, 'Content-Type': 'application/json' }, body: req.method !== 'GET' && req.method !== 'DELETE' ? JSON.stringify(req.body) : undefined });
    const d = await r.json();
    res.status(r.status).json(d);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Bear account proxy — server-side keys, used by UI for orders/positions/account info
app.all('/alpaca-bear/*', async (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const url = ALPACA_BASE + '/' + req.params[0] + qs;
  const key = process.env.ALPACA_BEAR_KEY;
  const secret = process.env.ALPACA_BEAR_SECRET;
  if (!key || !secret) return res.status(500).json({ error: 'ALPACA_BEAR_KEY not configured on server' });
  try {
    const r = await fetch(url, { method: req.method, headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret, 'Content-Type': 'application/json' }, body: req.method !== 'GET' && req.method !== 'DELETE' ? JSON.stringify(req.body) : undefined });
    const d = await r.json();
    res.status(r.status).json(d);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Legacy browser-key proxy — kept so old bookmarks / Chrome extension still work
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

// Inbound trade endpoint — called by Chrome extension or UI watchlist
// Bull trades → ALPACA_KEY account, bear trades → ALPACA_BEAR_KEY account
app.post('/trade', async (req, res) => {
  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.headers['x-webhook-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { symbol, direction, trigger, targets, maxDollars, stopLossPct } = req.body;
  if (!symbol || !direction || !trigger || !targets?.length) {
    return res.status(400).json({ error: 'Missing required fields: symbol, direction, trigger, targets' });
  }

  const isBull = direction === 'bull';
  const label = isBull ? 'BULL' : 'BEAR';
  const key = isBull ? process.env.ALPACA_KEY : process.env.ALPACA_BEAR_KEY;
  const secret_key = isBull ? process.env.ALPACA_SECRET : process.env.ALPACA_BEAR_SECRET;

  if (!key || !secret_key) {
    const missing = isBull ? 'ALPACA_KEY / ALPACA_SECRET' : 'ALPACA_BEAR_KEY / ALPACA_BEAR_SECRET';
    return res.status(500).json({ error: `${missing} not set on server` });
  }

  const dollars = parseFloat(maxDollars) || 10000;
  const slPct = parseFloat(stopLossPct) / 100 || 0.03;
  const qty = Math.max(1, Math.floor(dollars / trigger));
  const side = isBull ? 'buy' : 'sell';
  const sl = isBull
    ? Math.round(trigger * (1 - slPct) * 100) / 100
    : Math.round(trigger * (1 + slPct) * 100) / 100;
  const tp = targets[0];

  const order = {
    symbol: symbol.toUpperCase(), qty, side,
    type: 'stop_limit',
    stop_price: trigger,
    limit_price: trigger,
    time_in_force: 'day',
    order_class: 'bracket',
    take_profit: { limit_price: tp },
    stop_loss: {
      stop_price: sl,
      limit_price: Math.round(sl * (isBull ? 0.995 : 1.005) * 100) / 100
    }
  };

  try {
    const r = await fetch(`${ALPACA_BASE}/orders`, {
      method: 'POST',
      headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret_key, 'Content-Type': 'application/json' },
      body: JSON.stringify(order)
    });
    const d = await r.json();
    if (!r.ok) {
      const reason = d.message || JSON.stringify(d);
      console.error(`[${label}] Trade rejected: ${side} ${symbol} — ${reason}`);
      await sendTelegram(`🔴 [${label}] Order rejected: ${symbol} ${side.toUpperCase()} @ $${trigger}\nReason: ${reason}`);
      return res.status(r.status).json({ error: reason });
    }
    console.log(`[${label}] Trade placed: ${side} ${qty} ${symbol} @ ${trigger}`);
    await sendTelegram(`🟢 [${label}] Order placed: ${symbol} ${side.toUpperCase()} ${qty} sh @ $${trigger}\nTP $${tp} · SL $${sl}`);
    res.json({ ok: true, order: d });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Alpaca trade webhook (kept for compatibility)
app.post('/webhook/alpaca', async (req, res) => {
  res.sendStatus(200);
  const order = req.body?.data?.order || req.body?.order || req.body;
  if (!order || order.status !== 'filled') return;
  await sendTradeNotification(order, 'BULL');
});

// --- Shared helpers ---

function classifyOrder(order) {
  if (order.order_class === 'bracket') return 'entry';
  if (order.order_type === 'stop' || order.order_type === 'stop_limit') return 'stop-loss';
  if (order.order_type === 'limit') return 'take-profit';
  return 'entry';
}

function buildTradeMessage(order, label) {
  const symbol = order.symbol || '?';
  const side = (order.side || '').toUpperCase();
  const qty = order.filled_qty || order.qty || '?';
  const price = parseFloat(order.filled_avg_price || 0).toFixed(2);
  const time = order.filled_at ? new Date(order.filled_at).toLocaleString() : new Date().toLocaleString();
  const type = classifyOrder(order);
  return `✅ [${label}] ${symbol} filled - ${side} ${qty} shares @ $${price}\nType: ${type}\nTime: ${time}`;
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

async function sendTradeNotification(order, label) {
  try { await sendTelegram(buildTradeMessage(order, label)); }
  catch (e) { console.error('Telegram error:', e.message); }
}

// --- Filled-order polling (every 30s, both accounts) ---

const seenOrderIds = new Set();

async function seedAccount(key, secret) {
  if (!key || !secret) return;
  try {
    const r = await fetch(`${ALPACA_BASE}/orders?status=filled&limit=50`, {
      headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret }
    });
    if (!r.ok) return;
    const orders = await r.json();
    for (const order of orders) seenOrderIds.add(order.id);
  } catch (e) { console.error('Seed error:', e.message); }
}

async function seedSeenOrders() {
  await seedAccount(process.env.ALPACA_KEY, process.env.ALPACA_SECRET);
  await seedAccount(process.env.ALPACA_BEAR_KEY, process.env.ALPACA_BEAR_SECRET);
  console.log(`Seeded ${seenOrderIds.size} existing filled orders (no notifications)`);
}

async function pollAccount(key, secret, label) {
  if (!key || !secret) return;
  try {
    const r = await fetch(`${ALPACA_BASE}/orders?status=filled&limit=50`, {
      headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret }
    });
    if (!r.ok) { console.error(`[${label}] Alpaca poll error:`, r.status); return; }
    const orders = await r.json();
    for (const order of orders) {
      if (seenOrderIds.has(order.id)) continue;
      seenOrderIds.add(order.id);
      await sendTradeNotification(order, label);
    }
  } catch (e) { console.error(`[${label}] Poll error:`, e.message); }
}

async function pollFilledOrders() {
  await pollAccount(process.env.ALPACA_KEY, process.env.ALPACA_SECRET, 'BULL');
  await pollAccount(process.env.ALPACA_BEAR_KEY, process.env.ALPACA_BEAR_SECRET, 'BEAR');
}

// --- Daily summary at 21:00 UTC (4pm ET) ---

let lastSummaryDate = null;

async function fetchAccountStats(key, secret) {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const r = await fetch(
    `${ALPACA_BASE}/orders?status=all&limit=200&after=${todayStart.toISOString()}&nested=true`,
    { headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret } }
  );
  if (!r.ok) throw new Error(`Alpaca responded ${r.status}`);
  const orders = await r.json();
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
  return { winners, losers, totalPnl, openTrades };
}

async function sendDailySummary() {
  const bullKey = process.env.ALPACA_KEY;
  const bullSecret = process.env.ALPACA_SECRET;
  const bearKey = process.env.ALPACA_BEAR_KEY;
  const bearSecret = process.env.ALPACA_BEAR_SECRET;
  if (!bullKey || !bullSecret) return;

  const date = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York', weekday: 'long', month: 'short', day: 'numeric'
  });

  try {
    const bull = await fetchAccountStats(bullKey, bullSecret);
    const bear = bearKey && bearSecret ? await fetchAccountStats(bearKey, bearSecret) : null;
    const fmt = (stats, label) => {
      const closed = stats.winners + stats.losers;
      const sign = stats.totalPnl >= 0 ? '+' : '';
      const openNote = stats.openTrades > 0 ? ` (${stats.openTrades} open)` : '';
      return `[${label}] ${closed} trades${openNote} · ✅${stats.winners} ❌${stats.losers} · ${sign}$${stats.totalPnl.toFixed(2)}`;
    };
    const netPnl = bull.totalPnl + (bear ? bear.totalPnl : 0);
    const netSign = netPnl >= 0 ? '+' : '';
    const lines = [
      `📊 Daily Summary — ${date}`,
      fmt(bull, 'BULL'),
      bear ? fmt(bear, 'BEAR') : '[BEAR] no account configured',
      `Net P&L: ${netSign}$${netPnl.toFixed(2)}`
    ];
    await sendTelegram(lines.join('\n'));
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
