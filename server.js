const express = require('express');
const cors = require('cors');
const path = require('path');
const WebSocket = require('ws');
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

// --- Shared trade placement helper ---
// Used by both the /trade HTTP endpoint and the chatroom monitor
async function placeTradeOrder({ symbol, direction, trigger, targets, maxDollars = 10000, stopLossPct = 3 }) {
  const key = process.env.ALPACA_KEY;
  const secret_key = process.env.ALPACA_SECRET;
  if (!key || !secret_key) return { ok: false, error: 'ALPACA_KEY / ALPACA_SECRET not set' };

  const slPct = stopLossPct / 100;
  const qty = Math.max(1, Math.floor(maxDollars / trigger));
  const side = direction === 'bull' ? 'buy' : 'sell';
  const sl = direction === 'bull'
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
      limit_price: Math.round(sl * (direction === 'bull' ? 0.995 : 1.005) * 100) / 100
    }
  };

  const r = await fetch(`${ALPACA_BASE}/orders`, {
    method: 'POST',
    headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret_key, 'Content-Type': 'application/json' },
    body: JSON.stringify(order)
  });
  const d = await r.json();
  if (!r.ok) {
    return { ok: false, error: d.message || JSON.stringify(d), symbol, side, trigger };
  }
  return { ok: true, order: d, symbol, side, qty, trigger, tp, sl };
}

// Inbound trade endpoint — called by Chrome extension with a parsed setup
// Body: { symbol, direction: 'bull'|'bear', trigger, targets: [price,...], maxDollars?, stopLossPct? }
// Requires header: x-webhook-secret matching WEBHOOK_SECRET env var
app.post('/trade', async (req, res) => {
  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.headers['x-webhook-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { symbol, direction, trigger, targets, maxDollars, stopLossPct } = req.body;
  if (!symbol || !direction || !trigger || !targets?.length) {
    return res.status(400).json({ error: 'Missing required fields: symbol, direction, trigger, targets' });
  }

  try {
    const result = await placeTradeOrder({
      symbol, direction, trigger, targets,
      maxDollars: parseFloat(maxDollars) || 10000,
      stopLossPct: parseFloat(stopLossPct) || 3
    });
    if (!result.ok) {
      console.error(`Trade rejected: ${result.side} ${symbol} — ${result.error}`);
      await sendTelegram(`🔴 Order rejected: ${symbol} ${result.side?.toUpperCase()} @ $${trigger}\nReason: ${result.error}`);
      return res.status(400).json({ error: result.error });
    }
    console.log(`Trade placed: ${result.side} ${result.qty} ${symbol} @ ${trigger}`);
    await sendTelegram(`🟢 Order placed: ${symbol} ${result.side.toUpperCase()} ${result.qty} sh @ $${result.trigger}\nTP $${result.tp} · SL $${result.sl}`);
    res.json({ ok: true, order: result.order });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Alpaca trade webhook (kept for compatibility)
app.post('/webhook/alpaca', async (req, res) => {
  res.sendStatus(200);
  const order = req.body?.data?.order || req.body?.order || req.body;
  if (!order || order.status !== 'filled') return;
  await sendTradeNotification(order);
});

// Manual trigger — fetches chatroom alerts for a specific date and places trades
// POST /trigger-chatroom          → uses today's date
// POST /trigger-chatroom?date=YYYY-MM-DD  → uses provided date (useful for testing past setups)
app.post('/trigger-chatroom', async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }
  try {
    const results = await runChatroomMonitor(date);
    res.json({ date, ...results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Chatroom Monitor ---

// Parse a block of text from a single chat message into trade setups.
// Handles "AAPL Bullish above 180 (TGT 185, 190)" and Bearish lines that inherit the prior symbol.
function parseAlertText(text) {
  const setups = [];
  const lines = text.split('\n');
  let lastSymbol = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Full line: "AAPL Bullish above 180 (TGT 185)"
    let m = trimmed.match(/^([A-Z]{1,6})\s+(Bullish|Bearish)\s+(?:above|below)\s+([\d.]+)\s*\(TGT\s*([\d.,\s]+)\)/i);
    if (m) {
      const symbol = m[1].toUpperCase();
      const direction = m[2].toLowerCase() === 'bullish' ? 'bull' : 'bear';
      const trigger = parseFloat(m[3]);
      const targets = m[4].split(',').map(t => parseFloat(t.trim())).filter(t => !isNaN(t) && t > 0);
      if (direction === 'bull') lastSymbol = symbol;
      if (trigger > 0 && targets.length > 0) setups.push({ symbol, direction, trigger, targets });
      continue;
    }

    // Symbol-less line (Bearish inherits from prior Bullish): "Bearish below 175 (TGT 170)"
    m = trimmed.match(/^(Bullish|Bearish)\s+(?:above|below)\s+([\d.]+)\s*\(TGT\s*([\d.,\s]+)\)/i);
    if (m && lastSymbol) {
      const direction = m[1].toLowerCase() === 'bullish' ? 'bull' : 'bear';
      const trigger = parseFloat(m[2]);
      const targets = m[3].split(',').map(t => parseFloat(t.trim())).filter(t => !isNaN(t) && t > 0);
      if (trigger > 0 && targets.length > 0) setups.push({ symbol: lastSymbol, direction, trigger, targets });
    }
  }

  return setups;
}

// Connect to the ProTradingRoom WebSocket, collect the alerts log, then process it.
// targetDate is "YYYY-MM-DD" — only alerts posted on that date are traded.
async function runChatroomMonitor(targetDate) {
  const ptrToken = process.env.PTR_TOKEN;
  if (!ptrToken) {
    console.error('Chatroom monitor: PTR_TOKEN env var not set');
    return { error: 'PTR_TOKEN not set' };
  }

  console.log(`Chatroom monitor starting for ${targetDate}`);

  return new Promise((resolve) => {
    const ws = new WebSocket('wss://chat5.protradingroom.com/?id=61cb5b432fcdee7bc8e97935&sl=1', {
      headers: { 'Origin': 'https://chat5.protradingroom.com' }
    });
    const collectedAlerts = [];
    let settled = false;

    function finish() {
      if (settled) return;
      settled = true;
      ws.terminate();
    }

    // Disconnect after 10 seconds no matter what
    const timeout = setTimeout(finish, 10000);

    ws.on('open', () => {
      console.log('PTR WebSocket connected');
      ws.send(JSON.stringify({ event: 'cmd', data: { cmd: 'login', data: { token: ptrToken } } }));
      ws.send(JSON.stringify({ event: 'cmd', data: { cmd: 'getAlertsLog', data: { page: 1 } } }));
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        // Log a preview so we can see the structure if something looks wrong
        console.log('PTR message:', msg.event, JSON.stringify(msg).slice(0, 300));

        // The server might return alerts under different key names — try them all
        const candidates = [
          msg.data?.alerts,
          msg.data?.data?.alerts,
          msg.data?.messages,
          msg.data?.data?.messages,
          Array.isArray(msg.data) ? msg.data : null
        ].filter(Array.isArray);

        for (const list of candidates) collectedAlerts.push(...list);
      } catch (e) {
        console.error('PTR WS parse error:', e.message);
      }
    });

    ws.on('close', async () => {
      clearTimeout(timeout);
      console.log(`PTR WebSocket closed. Raw alerts collected: ${collectedAlerts.length}`);
      try {
        const results = await processAlerts(collectedAlerts, targetDate);
        resolve(results);
      } catch (e) {
        console.error('processAlerts error:', e.message);
        resolve({ error: e.message });
      }
    });

    ws.on('error', (e) => {
      clearTimeout(timeout);
      console.error('PTR WS error:', e.message);
      resolve({ error: e.message });
    });
  });
}

// Filter alerts to StefanieK + targetDate, parse each message, place bracket orders.
async function processAlerts(alerts, targetDate) {
  const placed = [];
  const rejected = [];
  const skipped = [];

  for (const alert of alerts) {
    // Normalize field names — the PTR server may use different keys
    const author = alert.user || alert.author || alert.username || alert.name || '';
    const text = alert.message || alert.text || alert.content || alert.body || '';
    const timestamp = alert.timestamp || alert.date || alert.created_at || alert.time || '';

    if (!author.toLowerCase().includes('stefaniek')) {
      skipped.push(`not StefanieK (got "${author}")`);
      continue;
    }

    if (timestamp) {
      const alertDate = new Date(timestamp).toISOString().slice(0, 10);
      if (alertDate !== targetDate) {
        skipped.push(`wrong date ${alertDate}`);
        continue;
      }
    }

    const setups = parseAlertText(text);
    if (setups.length === 0) {
      skipped.push(`no setups parsed: "${text.slice(0, 80)}"`);
      continue;
    }

    for (const setup of setups) {
      try {
        const result = await placeTradeOrder(setup);
        if (result.ok) {
          console.log(`Chatroom trade placed: ${result.side} ${result.qty} ${result.symbol} @ ${result.trigger}`);
          await sendTelegram(`🟢 Order placed: ${result.symbol} ${result.side.toUpperCase()} ${result.qty} sh @ $${result.trigger}\nTP $${result.tp} · SL $${result.sl}`);
          placed.push({ symbol: result.symbol, side: result.side, qty: result.qty, trigger: result.trigger });
        } else {
          console.error(`Chatroom trade rejected: ${setup.symbol} — ${result.error}`);
          await sendTelegram(`🔴 Order rejected: ${setup.symbol} ${setup.direction === 'bull' ? 'BUY' : 'SELL'} @ $${setup.trigger}\nReason: ${result.error}`);
          rejected.push({ symbol: setup.symbol, error: result.error });
        }
      } catch (e) {
        console.error('Chatroom placeTradeOrder error:', e.message);
        rejected.push({ symbol: setup.symbol, error: e.message });
      }
    }
  }

  const summary = `📋 Chatroom Monitor — ${targetDate}\nPlaced: ${placed.length} · Rejected: ${rejected.length} · Skipped alerts: ${skipped.length}`;
  await sendTelegram(summary).catch(e => console.error('Summary telegram error:', e.message));
  console.log(summary);

  return { placed, rejected, skippedCount: skipped.length };
}

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

// --- Daily chatroom monitor at 14:00 UTC (6am PST) ---

let lastChatroomDate = null;

setInterval(() => {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  if (now.getUTCHours() === 14 && now.getUTCMinutes() === 0 && lastChatroomDate !== dateStr) {
    lastChatroomDate = dateStr;
    runChatroomMonitor(dateStr).catch(e => console.error('Chatroom monitor error:', e.message));
  }
}, 60_000);

// --- Daily P&L summary at 21:00 UTC (4pm ET) ---

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
