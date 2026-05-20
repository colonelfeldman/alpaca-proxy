const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const Database = require('better-sqlite3');
const multer = require('multer');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const ALPACA_BASE = 'https://paper-api.alpaca.markets/v2';
const ALPACA_DATA_BASE = 'https://data.alpaca.markets/v2';
const TELEGRAM_TOKEN = '8537812125:AAGQDJEDEp8E9ewfpiBk3kL7hKqCY2dWIyQ';
const TELEGRAM_CHAT_ID = 8018343254;

// ── SQLite Database ────────────────────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'trading.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS parsed_setups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT, symbol TEXT, direction TEXT,
    trigger_price REAL, target1 REAL, target2 REAL, target3 REAL,
    account TEXT, created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alpaca_order_id TEXT UNIQUE, symbol TEXT, direction TEXT, account TEXT,
    entry_price REAL, shares REAL, dollar_amount REAL,
    t1_price REAL, t1_filled_at TEXT, t1_pnl REAL,
    t2_price REAL, t2_filled_at TEXT, t2_pnl REAL,
    t3_price REAL, t3_type TEXT, t3_filled_at TEXT, t3_pnl REAL,
    stop_loss_price REAL, stop_loss_hit INTEGER DEFAULT 0,
    total_pnl REAL, total_pct REAL, exit_reason TEXT,
    entry_time_et TEXT, exit_time_et TEXT, hold_minutes REAL, order_mode TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS chatroom_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT, symbol TEXT, direction TEXT,
    whisper_level REAL, entry_price REAL, exit_price REAL,
    gain_pct REAL, targets_hit TEXT, source TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS setup_comparisons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id INTEGER, chatroom_result_id INTEGER,
    our_entry REAL, their_entry REAL, entry_diff REAL,
    our_exit REAL, their_exit REAL, exit_diff REAL,
    our_pnl_pct REAL, their_pnl_pct REAL, pnl_diff REAL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Add columns for multi-target order tracking (safe to run on existing DB)
try { db.exec(`ALTER TABLE trades ADD COLUMN sl_order_id TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE trades ADD COLUMN trail_order_id TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE trades ADD COLUMN status TEXT DEFAULT 'pending'`); } catch(e) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`); } catch(e) {}
// Prevents two extension instances from placing the same setup twice on the same day
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_setup_daily ON parsed_setups(date, symbol, direction, trigger_price)`); } catch(e) {}

function getSetting(key, defaultVal) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? JSON.parse(row.value) : defaultVal;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
}

function dateET(d) {
  return new Date(d || Date.now()).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
function nowETStr() {
  return new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
}

// ── Static files ───────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Market data proxy ──────────────────────────────────────────────────────────
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

// ── Bull account proxy ─────────────────────────────────────────────────────────
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

// ── Bear account proxy ─────────────────────────────────────────────────────────
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

// ── Legacy browser-key proxy ───────────────────────────────────────────────────
app.all('/alpaca/*', async (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const url = ALPACA_BASE + '/' + req.params[0] + qs;
  try {
    const r = await fetch(url, { method: req.method, headers: { 'APCA-API-KEY-ID': req.headers['apca-api-key-id'], 'APCA-API-SECRET-KEY': req.headers['apca-api-secret-key'], 'Content-Type': 'application/json' }, body: req.method !== 'GET' && req.method !== 'DELETE' ? JSON.stringify(req.body) : undefined });
    const d = await r.json();
    res.status(r.status).json(d);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Claude proxy ───────────────────────────────────────────────────────────────
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

// ── Order metadata (for dashboard multi-target display) ────────────────────────
app.get('/api/order-metadata', (req, res) => {
  res.json(orderMetadata);
});

// Used by the Chrome extension to pre-check if a setup was already placed today
// (works across multiple computers since both talk to the same server/DB)
app.get('/api/setup-traded', (req, res) => {
  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.headers['x-webhook-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { symbol, direction, trigger } = req.query;
  if (!symbol || !direction || !trigger) {
    return res.status(400).json({ error: 'Missing symbol, direction, or trigger' });
  }
  const row = db.prepare(
    `SELECT id FROM parsed_setups WHERE date = ? AND symbol = ? AND direction = ? AND trigger_price = ?`
  ).get(dateET(), symbol.toUpperCase(), direction, parseFloat(trigger));
  res.json({ traded: !!row });
});

// ── DB: save parsed setup ──────────────────────────────────────────────────────
app.post('/db/setup', (req, res) => {
  try {
    const { date, symbol, direction, trigger_price, target1, target2, target3, account } = req.body;
    const result = db.prepare(
      `INSERT INTO parsed_setups (date,symbol,direction,trigger_price,target1,target2,target3,account) VALUES (?,?,?,?,?,?,?,?)`
    ).run(date || dateET(), symbol, direction, trigger_price, target1, target2, target3, account);
    res.json({ ok: true, id: result.lastInsertRowid });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DB: save or update trade record ───────────────────────────────────────────
app.post('/db/trade', (req, res) => {
  try {
    const t = req.body;
    db.prepare(`
      INSERT INTO trades (
        alpaca_order_id,symbol,direction,account,entry_price,shares,dollar_amount,
        t1_price,t1_filled_at,t1_pnl,t2_price,t2_filled_at,t2_pnl,
        t3_price,t3_type,t3_filled_at,t3_pnl,
        stop_loss_price,stop_loss_hit,total_pnl,total_pct,exit_reason,
        entry_time_et,exit_time_et,hold_minutes,order_mode
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(alpaca_order_id) DO UPDATE SET
        entry_price=excluded.entry_price, shares=excluded.shares, dollar_amount=excluded.dollar_amount,
        t1_price=excluded.t1_price, t1_filled_at=excluded.t1_filled_at, t1_pnl=excluded.t1_pnl,
        t2_price=excluded.t2_price, t2_filled_at=excluded.t2_filled_at, t2_pnl=excluded.t2_pnl,
        t3_price=excluded.t3_price, t3_type=excluded.t3_type, t3_filled_at=excluded.t3_filled_at, t3_pnl=excluded.t3_pnl,
        stop_loss_price=excluded.stop_loss_price, stop_loss_hit=excluded.stop_loss_hit,
        total_pnl=excluded.total_pnl, total_pct=excluded.total_pct, exit_reason=excluded.exit_reason,
        exit_time_et=excluded.exit_time_et, hold_minutes=excluded.hold_minutes
    `).run(
      t.alpaca_order_id, t.symbol, t.direction, t.account, t.entry_price, t.shares, t.dollar_amount,
      t.t1_price, t.t1_filled_at, t.t1_pnl, t.t2_price, t.t2_filled_at, t.t2_pnl,
      t.t3_price, t.t3_type, t.t3_filled_at, t.t3_pnl,
      t.stop_loss_price, t.stop_loss_hit ? 1 : 0, t.total_pnl, t.total_pct, t.exit_reason,
      t.entry_time_et, t.exit_time_et, t.hold_minutes, t.order_mode
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DB: save chatroom results (array) ─────────────────────────────────────────
app.post('/db/chatroom-results', (req, res) => {
  try {
    const rows = Array.isArray(req.body) ? req.body : [req.body];
    const stmt = db.prepare(
      `INSERT INTO chatroom_results (date,symbol,direction,whisper_level,entry_price,exit_price,gain_pct,targets_hit,source) VALUES (?,?,?,?,?,?,?,?,?)`
    );
    db.transaction(() => {
      for (const r of rows)
        stmt.run(r.date || dateET(), r.symbol, r.direction, r.whisper_level, r.entry_price, r.exit_price, r.gain_pct, r.targets_hit, r.source || 'manual_upload');
    })();
    res.json({ ok: true, count: rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DB: backfill trades from Alpaca for a given date ──────────────────────────
app.post('/db/backfill', async (req, res) => {
  try {
    const date = req.body?.date || dateET();
    const after  = new Date(`${date}T00:00:00-05:00`).toISOString();
    const until  = new Date(`${date}T23:59:59-05:00`).toISOString();
    const accounts = [
      { key: process.env.ALPACA_KEY,      secret: process.env.ALPACA_SECRET,      label: 'bull', entrySide: 'buy'  },
      { key: process.env.ALPACA_BEAR_KEY, secret: process.env.ALPACA_BEAR_SECRET, label: 'bear', entrySide: 'sell' },
    ].filter(a => a.key && a.secret);

    let inserted = 0, skipped = 0;
    for (const acct of accounts) {
      const r = await fetch(
        `${ALPACA_BASE}/orders?status=filled&limit=200&after=${after}&until=${until}&nested=true`,
        { headers: { 'APCA-API-KEY-ID': acct.key, 'APCA-API-SECRET-KEY': acct.secret } }
      );
      if (!r.ok) { console.error(`Backfill fetch error [${acct.label}]:`, r.status); continue; }
      const orders = await r.json();

      for (const order of orders) {
        // Only save entry orders (buys for bull, sells for bear)
        if (order.side !== acct.entrySide) continue;
        // Skip if it's a leg of a bracket (legs don't appear at top level with nested=true, but guard anyway)
        if (order.order_class === 'simple' && order.legs?.length) continue;

        const direction  = acct.label === 'bull' ? 'bull' : 'bear';
        const entryPrice = parseFloat(order.filled_avg_price || 0);
        const shares     = parseFloat(order.filled_qty || order.qty || 0);
        const entryTimeET = order.filled_at
          ? new Date(order.filled_at).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false })
          : date;
        const orderMode = order.order_class === 'bracket' ? 'bracket' : 'multi';
        let t1Price = null, slPrice = null;
        if (order.order_class === 'bracket') {
          const legs = order.legs || [];
          const tpLeg = legs.find(l => l.type === 'limit');
          const slLeg = legs.find(l => l.type === 'stop_limit' || l.type === 'stop');
          t1Price = tpLeg ? parseFloat(tpLeg.limit_price) : null;
          slPrice = slLeg ? parseFloat(slLeg.stop_price)  : null;
        }

        const createdAt = order.filled_at
          ? new Date(order.filled_at).toISOString().replace('T', ' ').slice(0, 19)
          : `${date}T15:00:00`;

        const changes = db.prepare(`
          INSERT INTO trades (alpaca_order_id,symbol,direction,account,entry_price,shares,dollar_amount,t1_price,stop_loss_price,entry_time_et,order_mode,status,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,'filled',?)
          ON CONFLICT(alpaca_order_id) DO UPDATE SET created_at=excluded.created_at, entry_time_et=excluded.entry_time_et, status='filled'
        `).run(order.id, order.symbol, direction, acct.label, entryPrice, shares, entryPrice * shares, t1Price, slPrice, entryTimeET, orderMode, createdAt);

        changes.changes > 0 ? inserted++ : skipped++;
      }
    }
    res.json({ ok: true, date, inserted, skipped });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DB: get trades for date ────────────────────────────────────────────────────
app.get('/db/trades', (req, res) => {
  try {
    const date = req.query.date || dateET();
    const account = req.query.account;
    const params = [date];
    let q = `SELECT * FROM trades WHERE date(created_at) = ?`;
    if (account && account !== 'all') { q += ` AND account = ?`; params.push(account); }
    q += ` ORDER BY created_at DESC`;
    res.json(db.prepare(q).all(...params));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DB: daily summary stats ────────────────────────────────────────────────────
app.get('/db/summary', (req, res) => {
  try {
    const date = req.query.date || dateET();
    const trades = db.prepare(`SELECT * FROM trades WHERE date(created_at) = ?`).all(date);
    const closed = trades.filter(t => t.exit_reason);
    const winners = closed.filter(t => t.total_pnl > 0);
    const losers  = closed.filter(t => t.total_pnl <= 0);
    const netPnl  = closed.reduce((s, t) => s + (t.total_pnl || 0), 0);
    const totalProfit = winners.reduce((s, t) => s + (t.total_pnl || 0), 0);
    const totalLoss   = losers.reduce((s, t) => s + (t.total_pnl || 0), 0);
    const avgHold = closed.length ? closed.reduce((s, t) => s + (t.hold_minutes || 0), 0) / closed.length : 0;
    const best  = closed.reduce((b, t) => (!b || t.total_pnl > b.total_pnl ? t : b), null);
    const worst = closed.reduce((b, t) => (!b || t.total_pnl < b.total_pnl ? t : b), null);
    const bull  = closed.filter(t => t.direction === 'bull');
    const bear  = closed.filter(t => t.direction === 'bear');
    res.json({
      date, totalTrades: trades.length, closedTrades: closed.length,
      winners: winners.length, losers: losers.length,
      winRate: closed.length ? (winners.length / closed.length * 100) : 0,
      netPnl, totalProfit, totalLoss,
      avgWinner: winners.length ? totalProfit / winners.length : 0,
      avgLoser:  losers.length  ? totalLoss  / losers.length  : 0,
      avgHold, profitFactor: totalLoss ? Math.abs(totalProfit / totalLoss) : null,
      best, worst,
      bull: { total: bull.length, winners: bull.filter(t=>t.total_pnl>0).length, netPnl: bull.reduce((s,t)=>s+(t.total_pnl||0),0) },
      bear: { total: bear.length, winners: bear.filter(t=>t.total_pnl>0).length, netPnl: bear.reduce((s,t)=>s+(t.total_pnl||0),0) }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DB: comparison (our results vs chatroom) ───────────────────────────────────
app.get('/db/comparison', (req, res) => {
  try {
    const date = req.query.date || dateET();
    const comparisons = db.prepare(`
      SELECT sc.*, t.symbol, t.direction, cr.entry_price as their_entry_fill, cr.gain_pct as their_pct
      FROM setup_comparisons sc
      JOIN trades t ON sc.trade_id = t.id
      JOIN chatroom_results cr ON sc.chatroom_result_id = cr.id
      WHERE date(sc.created_at) = ?
    `).all(date);
    const ourTrades   = db.prepare(`SELECT * FROM trades WHERE date(created_at) = ?`).all(date);
    const theirResults = db.prepare(`SELECT * FROM chatroom_results WHERE date = ?`).all(date);
    res.json({ comparisons, ourTrades, theirResults });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DB: upload chatroom results image → Claude vision → save ───────────────────
app.post('/db/upload-results', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file provided' });
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

    const base64 = req.file.buffer.toString('base64');
    const mediaType = req.file.mimetype || 'image/png';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: `Extract the trade results table from this image. Return a JSON array only (no markdown, no explanation). Each item: {"symbol":"AAPL","direction":"bull","whisper_level":185.50,"entry_price":185.80,"exit_price":188.20,"gain_pct":1.29,"targets_hit":"T1,T2"}. direction is bull for long/buy trades, bear for short/sell trades.` }
          ]
        }]
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || JSON.stringify(data) });

    const text = (data.content?.[0]?.text || '').replace(/```json\n?|\n?```/g, '').trim();
    let results;
    try { results = JSON.parse(text); } catch(e) { return res.status(422).json({ error: 'Could not parse Claude response', raw: text }); }

    const date = req.body?.date || dateET();
    const stmt = db.prepare(
      `INSERT INTO chatroom_results (date,symbol,direction,whisper_level,entry_price,exit_price,gain_pct,targets_hit,source) VALUES (?,?,?,?,?,?,?,?,'chrome_extension')`
    );
    db.transaction(() => {
      for (const r of results)
        stmt.run(date, r.symbol, r.direction, r.whisper_level, r.entry_price, r.exit_price, r.gain_pct, r.targets_hit);
    })();

    res.json({ ok: true, count: results.length, results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Alpaca trade webhook ───────────────────────────────────────────────────────
app.post('/webhook/alpaca', async (req, res) => {
  res.sendStatus(200);
  const order = req.body?.data?.order || req.body?.order || req.body;
  if (!order || order.status !== 'filled') return;
  await sendTradeNotification(order, 'BULL');
});

// ── Order metadata storage endpoint ───────────────────────────────────────────
app.post('/alpaca/orders/metadata', (req, res) => {
  const { orderId, mode, target1, target2, trailPct, stopLossPrice, acct, symbol, isBull } = req.body;
  if (!orderId || !mode) return res.status(400).json({ error: 'orderId and mode required' });
  orderMetadata[orderId] = {
    mode, symbol, isBull, target1, target2,
    trailPct: parseFloat(trailPct) || 1.5,
    stopLossPrice, acct,
    label: isBull ? 'BULL' : 'BEAR',
    status: 'pending_fill', exitOrderIds: null
  };
  saveOrderMetadata();
  res.json({ ok: true });
});

// ── Trade placement ────────────────────────────────────────────────────────────
app.post('/trade', async (req, res) => {
  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.headers['x-webhook-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { symbol, direction, trigger, targets, maxDollars, stopLossPct, mode, trailPct } = req.body;
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

  const acctEmoji = label === 'BULL' ? '🟢' : '🔵';
  const apiHeaders = { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret_key, 'Content-Type': 'application/json' };

  // Save setup to DB — reject as duplicate if this exact setup was already placed today
  try {
    db.prepare(`INSERT INTO parsed_setups (date,symbol,direction,trigger_price,target1,target2,target3,account) VALUES (?,?,?,?,?,?,?,?)`)
      .run(dateET(), symbol.toUpperCase(), direction, trigger, targets[0]||null, targets[1]||null, targets[2]||null, isBull?'bull':'bear');
  } catch(e) {
    if (e.message.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'Setup already traded today', alreadyTraded: true });
    }
    console.error('DB setup save error:', e.message);
  }

  try {
    if (mode === 'multi') {
      const entryOrder = {
        symbol: symbol.toUpperCase(), qty, side,
        type: 'stop_limit', stop_price: trigger, limit_price: trigger,
        time_in_force: 'day'
      };
      const r = await fetch(`${ALPACA_BASE}/orders`, { method: 'POST', headers: apiHeaders, body: JSON.stringify(entryOrder) });
      const d = await r.json();
      if (!r.ok) {
        const reason = d.message || JSON.stringify(d);
        console.error(`[${label}] Trade rejected: ${side} ${symbol} — ${reason}`);
        await sendTelegram(`❌ ${label} | ${symbol} — Order rejected\n${side.toUpperCase()} @ $${trigger}\nReason: ${reason}`);
        return res.status(r.status).json({ error: reason });
      }
      // 1 target → all shares at T1. 2 targets → 50/50 split. 3+ → 1/3 each with trailing stop.
      const t2 = targets.length >= 2 ? targets[1] : null;
      const trail = targets.length >= 3 ? (parseFloat(trailPct) || 1.5) : null;
      orderMetadata[d.id] = {
        mode: 'multi', symbol: symbol.toUpperCase(), isBull, label,
        target1: tp, target2: t2, trailPct: trail, stopLossPrice: sl,
        acct: isBull ? 'bull' : 'bear', status: 'pending_fill', exitOrderIds: null, qty
      };
      saveOrderMetadata();
      try {
        db.prepare(`INSERT INTO trades (alpaca_order_id,symbol,direction,account,entry_price,shares,dollar_amount,t1_price,stop_loss_price,entry_time_et,order_mode,status) VALUES (?,?,?,?,?,?,?,?,?,?,'multi','pending') ON CONFLICT(alpaca_order_id) DO NOTHING`)
          .run(d.id, symbol.toUpperCase(), direction, isBull ? 'bull' : 'bear', trigger, qty, trigger * qty, tp, sl, nowETStr());
      } catch(e) { console.error('DB pending save error:', e.message); }
      const modeDesc = !t2
        ? `All ${qty} sh → $${tp}`
        : !trail
          ? `½ ${Math.floor(qty/2)} sh → $${tp}  ·  ½ ${qty - Math.floor(qty/2)} sh → $${t2}`
          : `⅓ ${Math.floor(qty/3)} sh → $${tp}  ·  ⅓ ${Math.floor(qty/3)} sh → $${t2}  ·  ⅓ Trail ${trail}%`;
      console.log(`[${label}] Multi-target trade placed: ${side} ${qty} ${symbol} @ ${trigger}`);
      await sendTelegram(`🟢 ${label} | ${symbol} — Multi-target placed\nStop-limit ${side.toUpperCase()} ${qty} sh → trigger $${trigger}\n${modeDesc}\nSL: $${sl}`);
      return res.json({ ok: true, order: d, orderId: d.id });
    }

    // Bracket mode
    const order = {
      symbol: symbol.toUpperCase(), qty, side,
      type: 'stop_limit', stop_price: trigger, limit_price: trigger,
      time_in_force: 'day', order_class: 'bracket',
      take_profit: { limit_price: tp },
      stop_loss: {
        stop_price: sl,
        limit_price: Math.round(sl * (isBull ? 0.995 : 1.005) * 100) / 100
      }
    };
    const r = await fetch(`${ALPACA_BASE}/orders`, { method: 'POST', headers: apiHeaders, body: JSON.stringify(order) });
    const d = await r.json();
    if (!r.ok) {
      const reason = d.message || JSON.stringify(d);
      console.error(`[${label}] Trade rejected: ${side} ${symbol} — ${reason}`);
      await sendTelegram(`❌ ${label} | ${symbol} — Order rejected\n${side.toUpperCase()} @ $${trigger}\nReason: ${reason}`);
      return res.status(r.status).json({ error: reason });
    }
    try {
      db.prepare(`INSERT INTO trades (alpaca_order_id,symbol,direction,account,entry_price,shares,dollar_amount,t1_price,stop_loss_price,entry_time_et,order_mode,status) VALUES (?,?,?,?,?,?,?,?,?,?,'bracket','pending') ON CONFLICT(alpaca_order_id) DO NOTHING`)
        .run(d.id, symbol.toUpperCase(), direction, isBull ? 'bull' : 'bear', trigger, qty, trigger * qty, tp, sl, nowETStr());
    } catch(e) { console.error('DB pending save error:', e.message); }
    console.log(`[${label}] Trade placed: ${side} ${qty} ${symbol} @ ${trigger}`);
    await sendTelegram(`🟢 ${label} | ${symbol} — Bracket placed\nStop-limit ${side.toUpperCase()} ${qty} sh → trigger $${trigger}\nTP: $${tp}  ·  SL: $${sl}`);
    res.json({ ok: true, order: d });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Schwab OAuth & Trading ─────────────────────────────────────────────────────

const SCHWAB_AUTH_BASE  = 'https://api.schwabapi.com/v1/oauth';
const SCHWAB_TRADE_BASE = 'https://api.schwabapi.com/trader/v1';
const SCHWAB_CALLBACK   = 'https://alpaca-proxy-production.up.railway.app/schwab/callback';
const SCHWAB_TOKEN_FILE = path.join(__dirname, '.schwab-tokens.json');

function loadSchwabTokens() {
  try {
    if (fs.existsSync(SCHWAB_TOKEN_FILE)) return JSON.parse(fs.readFileSync(SCHWAB_TOKEN_FILE, 'utf8'));
  } catch (e) { console.error('Failed to load Schwab tokens:', e.message); }
  return { accessToken: null, refreshToken: null, expiresAt: null };
}

function saveSchwabTokens(tokens) {
  try { fs.writeFileSync(SCHWAB_TOKEN_FILE, JSON.stringify(tokens), 'utf8'); }
  catch (e) { console.error('Failed to save Schwab tokens:', e.message); }
}

let schwabTokens = loadSchwabTokens();
if (schwabTokens.accessToken) console.log('Schwab tokens loaded from disk — expires', new Date(schwabTokens.expiresAt).toISOString());

function schwabBasicAuth() {
  const key    = process.env.SCHWAB_APP_KEY;
  const secret = process.env.SCHWAB_APP_SECRET;
  if (!key || !secret) throw new Error('SCHWAB_APP_KEY / SCHWAB_APP_SECRET not set');
  return 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64');
}

app.get('/schwab/auth', (req, res) => {
  const key = process.env.SCHWAB_APP_KEY;
  if (!key) return res.status(500).send('SCHWAB_APP_KEY not set on server');
  const url = `${SCHWAB_AUTH_BASE}/authorize?client_id=${encodeURIComponent(key)}&redirect_uri=${encodeURIComponent(SCHWAB_CALLBACK)}&response_type=code`;
  res.redirect(url);
});

app.get('/schwab/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing authorization code');
  try {
    const r = await fetch(`${SCHWAB_AUTH_BASE}/token`, {
      method: 'POST',
      headers: { 'Authorization': schwabBasicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: SCHWAB_CALLBACK }).toString()
    });
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: d.error_description || JSON.stringify(d) });
    schwabTokens.accessToken  = d.access_token;
    schwabTokens.refreshToken = d.refresh_token;
    schwabTokens.expiresAt    = Date.now() + (d.expires_in || 1800) * 1000;
    saveSchwabTokens(schwabTokens);
    console.log('Schwab tokens stored — expires', new Date(schwabTokens.expiresAt).toISOString());
    await sendTelegram('🔗 Schwab connected — OAuth tokens stored. Ready to trade.');
    res.send('<h2>Schwab connected ✓</h2><p>You can close this tab.</p>');
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function schwabRefresh() {
  if (!schwabTokens.refreshToken) { console.warn('Schwab: no refresh token — visit /schwab/auth'); return; }
  try {
    const r = await fetch(`${SCHWAB_AUTH_BASE}/token`, {
      method: 'POST',
      headers: { 'Authorization': schwabBasicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: schwabTokens.refreshToken }).toString()
    });
    const d = await r.json();
    if (!r.ok) { console.error('Schwab refresh failed:', d.error_description || JSON.stringify(d)); return; }
    schwabTokens.accessToken  = d.access_token;
    if (d.refresh_token) schwabTokens.refreshToken = d.refresh_token;
    schwabTokens.expiresAt    = Date.now() + (d.expires_in || 1800) * 1000;
    saveSchwabTokens(schwabTokens);
    console.log('Schwab token refreshed — expires', new Date(schwabTokens.expiresAt).toISOString());
  } catch (e) { console.error('Schwab refresh error:', e.message); }
}

app.get('/schwab/refresh', async (req, res) => {
  await schwabRefresh();
  if (schwabTokens.accessToken) res.json({ ok: true, expiresAt: new Date(schwabTokens.expiresAt).toISOString() });
  else res.status(500).json({ error: 'Refresh failed or no refresh token — visit /schwab/auth' });
});

setInterval(schwabRefresh, 25 * 60 * 1000);

app.get('/schwab/account', async (req, res) => {
  if (!schwabTokens.accessToken) return res.status(401).json({ error: 'Not authenticated — visit /schwab/auth' });
  try {
    const r = await fetch(`${SCHWAB_TRADE_BASE}/accounts`, { headers: { 'Authorization': `Bearer ${schwabTokens.accessToken}` } });
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/schwab/account/numbers', async (req, res) => {
  if (!schwabTokens.accessToken) return res.status(401).json({ error: 'Not authenticated — visit /schwab/auth' });
  try {
    const r = await fetch(`${SCHWAB_TRADE_BASE}/accounts/accountNumbers`, { headers: { 'Authorization': `Bearer ${schwabTokens.accessToken}` } });
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/schwab/orders', async (req, res) => {
  if (!schwabTokens.accessToken) return res.status(401).json({ error: 'Not authenticated — visit /schwab/auth' });
  const { accountId, ...orderBody } = req.body;
  if (!accountId) return res.status(400).json({ error: 'accountId is required' });
  try {
    const r = await fetch(`${SCHWAB_TRADE_BASE}/accounts/${accountId}/orders`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${schwabTokens.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(orderBody)
    });
    if (r.status === 201) return res.json({ ok: true });
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/schwab/bracket', async (req, res) => {
  if (!schwabTokens.accessToken) return res.status(401).json({ error: 'Not authenticated — visit /schwab/auth' });
  const accountId = process.env.SCHWAB_ACCOUNT_ID;
  if (!accountId) return res.status(500).json({ error: 'SCHWAB_ACCOUNT_ID not set on server' });
  const { symbol, direction, trigger, targets, maxDollars, stopLossPct } = req.body;
  if (!symbol || !direction || !trigger || !targets?.length) {
    return res.status(400).json({ error: 'Missing required fields: symbol, direction, trigger, targets' });
  }
  const isBull = direction === 'bull';
  const dollars = parseFloat(maxDollars) || 10000;
  const slPct   = parseFloat(stopLossPct) / 100 || 0.03;
  const qty     = Math.max(1, Math.floor(dollars / trigger));
  const entryInstruction = isBull ? 'BUY'  : 'SELL_SHORT';
  const exitInstruction  = isBull ? 'SELL' : 'BUY_TO_COVER';
  const tp = targets[0];
  const sl = isBull ? Math.round(trigger*(1-slPct)*100)/100 : Math.round(trigger*(1+slPct)*100)/100;
  const instrument = { symbol: symbol.toUpperCase(), assetType: 'EQUITY' };
  const order = {
    orderStrategyType: 'TRIGGER', orderType: 'STOP', stopPrice: trigger, duration: 'DAY', session: 'NORMAL',
    orderLegCollection: [{ instruction: entryInstruction, quantity: qty, instrument }],
    childOrderStrategies: [{
      orderStrategyType: 'OCO',
      childOrderStrategies: [
        { orderStrategyType:'SINGLE', orderType:'LIMIT', price: tp, duration:'DAY', session:'NORMAL', orderLegCollection:[{instruction:exitInstruction,quantity:qty,instrument}] },
        { orderStrategyType:'SINGLE', orderType:'STOP', stopPrice: sl, duration:'DAY', session:'NORMAL', orderLegCollection:[{instruction:exitInstruction,quantity:qty,instrument}] }
      ]
    }]
  };
  try {
    const r = await fetch(`${SCHWAB_TRADE_BASE}/accounts/${accountId}/orders`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${schwabTokens.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(order)
    });
    if (r.status === 201) {
      const lbl = isBull ? 'BULL' : 'BEAR';
      console.log(`[SCHWAB ${lbl}] Bracket placed: ${entryInstruction} ${qty} ${symbol} @ ${trigger}`);
      await sendTelegram(`🟡 [SCHWAB ${lbl}] Bracket placed: ${symbol} ${entryInstruction} ${qty} sh @ $${trigger}\nTP $${tp} · SL $${sl} 🟡`);
      return res.json({ ok: true, symbol, direction, qty, trigger, tp, sl });
    }
    const d = await r.json();
    const reason = d.message || JSON.stringify(d);
    console.error(`[SCHWAB] Order rejected: ${reason}`);
    await sendTelegram(`🟡 [SCHWAB] Order rejected: ${symbol} @ $${trigger}\nReason: ${reason}`);
    res.status(r.status).json({ error: reason });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Shared helpers ─────────────────────────────────────────────────────────────

function classifyOrder(order) {
  if (order.order_class === 'bracket') return 'entry';
  if (order.order_type === 'stop' || order.order_type === 'stop_limit') return 'stop-loss';
  if (order.order_type === 'limit') return 'take-profit';
  return 'entry';
}

function buildTradeMessage(order, label, ctx = {}) {
  const symbol  = order.symbol || '?';
  const side    = (order.side || '').toUpperCase();
  const qty     = parseFloat(order.filled_qty || order.qty || 0);
  const price   = parseFloat(order.filled_avg_price || 0);
  const isLong  = order.side === 'buy';
  const $       = n => '$' + parseFloat(n).toFixed(2);
  const timeET  = order.filled_at
    ? new Date(order.filled_at).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: true, hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : nowETStr();
  const { entryMeta, entryPrice, isT1, isT2, isTrail, isSL } = ctx;
  const isExit = isT1 || isT2 || isTrail || isSL;

  if (!isExit) {
    // Entry fill — 📈 for long, 📉 for short
    const dirEmoji = isLong ? '📈' : '📉';
    const dirLabel = isLong ? 'Long' : 'Short';
    const lines = [`${dirEmoji} ${label} | ${symbol} — ${dirLabel} entry filled`];
    lines.push(`${side} ${qty} sh @ ${$(price)}${price && qty ? ` · ${$(price * qty)} invested` : ''}`);
    if (entryMeta) {
      const parts = [
        entryMeta.target1       && `T1 ${$(entryMeta.target1)}`,
        entryMeta.target2       && `T2 ${$(entryMeta.target2)}`,
        entryMeta.trailPct      && `Trail ${entryMeta.trailPct}%`,
        entryMeta.stopLossPrice && `SL ${$(entryMeta.stopLossPrice)}`,
      ].filter(Boolean);
      if (parts.length) lines.push(parts.join(' · '));
    }
    lines.push(timeET);
    return lines.join('\n');
  }

  // Exit fill — P&L direction: closing sell = was long, closing buy = was short
  const wasLong  = order.side === 'sell';
  const legEmoji = isSL ? '🛑' : isT2 ? '✅✅' : isTrail ? '🔄' : '✅';
  const legLabel = isSL ? 'Stop loss hit' : isT2 ? 'T2 hit' : isTrail ? 'Trailing stop' : 'T1 hit';
  const pnl = entryPrice && price && qty
    ? (wasLong ? price - entryPrice : entryPrice - price) * qty : null;
  const pct = pnl != null && entryPrice ? (pnl / (entryPrice * qty)) * 100 : null;
  const sgn = n => n >= 0 ? '+' : '';

  const lines = [`${legEmoji} ${label} | ${symbol} — ${legLabel}`];
  lines.push(`${side} ${qty} sh @ ${$(price)}${entryPrice ? ` · Entry ${$(entryPrice)}` : ''}`);
  if (pnl != null) lines.push(`P&L: ${sgn(pnl)}${$(Math.abs(pnl))} (${sgn(pct)}${pct.toFixed(2)}%)`);
  if (isT2) lines.push(`SL cancelled · Trailing stop protecting final position`);
  lines.push(timeET);
  return lines.join('\n');
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

async function sendTradeNotification(order, label, ctx = {}) {
  try { await sendTelegram(buildTradeMessage(order, label, ctx)); }
  catch (e) { console.error('Telegram error:', e.message); }
}

// ── Multi-target exit management ───────────────────────────────────────────────

async function placeMultiTargetExits(entryOrder, meta, key, secret) {
  const { symbol, target1, target2, trailPct, stopLossPrice, isBull, label } = meta;
  const qty  = parseInt(entryOrder.filled_qty || entryOrder.qty || meta.qty);
  const side = isBull ? 'sell' : 'buy';
  const headers = { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret, 'Content-Type': 'application/json' };
  const placed = { t1OrderId: null, t2OrderId: null, trailOrderId: null, slOrderId: null };

  try {
    if (!target2) {
      // 1 target: all shares exit at T1, SL covers all
      const [t1Res, slRes] = await Promise.all([
        fetch(`${ALPACA_BASE}/orders`, { method:'POST', headers, body: JSON.stringify({ symbol, qty:String(qty), side, type:'limit', limit_price:String(target1), time_in_force:'day' }) }),
        fetch(`${ALPACA_BASE}/orders`, { method:'POST', headers, body: JSON.stringify({ symbol, qty:String(qty), side, type:'stop', stop_price:String(stopLossPrice), time_in_force:'day' }) })
      ]);
      const [t1d, sld] = await Promise.all([t1Res.json(), slRes.json()]);
      placed.t1OrderId = t1d.id; placed.slOrderId = sld.id;
      await sendTelegram(`📐 ${label} | ${symbol} — Exits armed\nAll ${qty} sh → limit $${target1}\nSL: $${stopLossPrice}`);
    } else if (!trailPct) {
      // 2 targets: 50/50 split, no trailing stop
      const half1 = Math.floor(qty / 2), half2 = qty - half1;
      const [t1Res, t2Res, slRes] = await Promise.all([
        fetch(`${ALPACA_BASE}/orders`, { method:'POST', headers, body: JSON.stringify({ symbol, qty:String(half1), side, type:'limit', limit_price:String(target1), time_in_force:'day' }) }),
        fetch(`${ALPACA_BASE}/orders`, { method:'POST', headers, body: JSON.stringify({ symbol, qty:String(half2), side, type:'limit', limit_price:String(target2), time_in_force:'day' }) }),
        fetch(`${ALPACA_BASE}/orders`, { method:'POST', headers, body: JSON.stringify({ symbol, qty:String(qty), side, type:'stop', stop_price:String(stopLossPrice), time_in_force:'day' }) })
      ]);
      const [t1d, t2d, sld] = await Promise.all([t1Res.json(), t2Res.json(), slRes.json()]);
      placed.t1OrderId = t1d.id; placed.t2OrderId = t2d.id; placed.slOrderId = sld.id;
      await sendTelegram(`📐 ${label} | ${symbol} — Exits armed\n½ ${half1} sh → $${target1}\n½ ${half2} sh → $${target2}\nSL: $${stopLossPrice}`);
    } else {
      // 3+ targets: 1/3 each with trailing stop (T3)
      const share1 = Math.floor(qty / 3), share2 = Math.floor(qty / 3), share3 = qty - share1 - share2;
      const [t1Res, t2Res, trailRes, slRes] = await Promise.all([
        fetch(`${ALPACA_BASE}/orders`, { method:'POST', headers, body: JSON.stringify({ symbol, qty:String(share1), side, type:'limit', limit_price:String(target1), time_in_force:'day' }) }),
        fetch(`${ALPACA_BASE}/orders`, { method:'POST', headers, body: JSON.stringify({ symbol, qty:String(share2), side, type:'limit', limit_price:String(target2), time_in_force:'day' }) }),
        fetch(`${ALPACA_BASE}/orders`, { method:'POST', headers, body: JSON.stringify({ symbol, qty:String(share3), side, type:'trailing_stop', trail_percent:String(trailPct), time_in_force:'day' }) }),
        fetch(`${ALPACA_BASE}/orders`, { method:'POST', headers, body: JSON.stringify({ symbol, qty:String(qty), side, type:'stop', stop_price:String(stopLossPrice), time_in_force:'day' }) })
      ]);
      const [t1d, t2d, trld, sld] = await Promise.all([t1Res.json(), t2Res.json(), trailRes.json(), slRes.json()]);
      placed.t1OrderId = t1d.id; placed.t2OrderId = t2d.id;
      placed.trailOrderId = trld.id; placed.slOrderId = sld.id;
      await sendTelegram(`📐 ${label} | ${symbol} — Exits armed\n⅓ ${share1} sh → $${target1}\n⅓ ${share2} sh → $${target2}\n⅓ ${share3} sh → Trail ${trailPct}%\nSL: $${stopLossPrice}`);
    }
    meta.exitOrderIds = placed;
    meta.status = 'exits_placed';
    meta.filledQty = qty;
    if (placed.t1OrderId)    exitToEntry[placed.t1OrderId]    = entryOrder.id;
    if (placed.t2OrderId)    exitToEntry[placed.t2OrderId]    = entryOrder.id;
    if (placed.trailOrderId) exitToEntry[placed.trailOrderId] = entryOrder.id;
    if (placed.slOrderId)    exitToEntry[placed.slOrderId]    = entryOrder.id;
    saveOrderMetadata();
    try {
      db.prepare(`UPDATE trades SET sl_order_id=?, trail_order_id=? WHERE alpaca_order_id=?`)
        .run(placed.slOrderId || null, placed.trailOrderId || null, entryOrder.id);
    } catch(e) { console.error('Failed to save SL/trail order IDs to trades:', e.message); }
  } catch(e) {
    console.error(`[${label}] Multi-target exits error: ${e.message}`);
    await sendTelegram(`⚠️ [${label}] Failed to place multi exits for ${symbol}: ${e.message}`).catch(() => {});
  }
}

async function handleTarget2Fill(entryId, meta, key, secret) {
  const { symbol, label, exitOrderIds } = meta;
  const headers = { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret, 'Content-Type': 'application/json' };
  if (exitOrderIds?.slOrderId) {
    try {
      await fetch(`${ALPACA_BASE}/orders/${exitOrderIds.slOrderId}`, { method:'DELETE', headers });
      console.log(`[${label}] Cancelled stop loss ${exitOrderIds.slOrderId} after T2 fill for ${symbol}`);
    } catch(e) { console.error(`[${label}] Cancel SL error: ${e.message}`); }
  }
  meta.status = 'target2_filled';
  saveOrderMetadata();
}

// ── Order metadata persistence ─────────────────────────────────────────────────

const ORDER_META_FILE = process.env.DB_PATH
  ? path.join(path.dirname(process.env.DB_PATH), '.order-metadata.json')
  : path.join(__dirname, '.order-metadata.json');

function loadOrderMetadata() {
  try {
    if (fs.existsSync(ORDER_META_FILE)) return JSON.parse(fs.readFileSync(ORDER_META_FILE, 'utf8'));
  } catch(e) { console.error('Failed to load order metadata:', e.message); }
  return {};
}

function saveOrderMetadata() {
  try { fs.writeFileSync(ORDER_META_FILE, JSON.stringify(orderMetadata), 'utf8'); }
  catch(e) { console.error('Failed to save order metadata:', e.message); }
}

// ── Filled-order polling ───────────────────────────────────────────────────────

const seenOrderIds = new Set();
const orderMetadata = loadOrderMetadata();
const exitToEntry = {};

function rebuildExitToEntry() {
  for (const [entryId, meta] of Object.entries(orderMetadata)) {
    if (!meta.exitOrderIds) continue;
    const { t1OrderId, t2OrderId, trailOrderId, slOrderId } = meta.exitOrderIds;
    if (t1OrderId)    exitToEntry[t1OrderId]    = entryId;
    if (t2OrderId)    exitToEntry[t2OrderId]    = entryId;
    if (trailOrderId) exitToEntry[trailOrderId] = entryId;
    if (slOrderId)    exitToEntry[slOrderId]    = entryId;
  }
}

async function recoverMultiTargetOrders() {
  const pending = Object.entries(orderMetadata).filter(([, m]) => m.mode === 'multi' && m.status === 'pending_fill');
  if (!pending.length) return;
  console.log(`[Recovery] Checking ${pending.length} pending multi-target order(s)...`);
  for (const [orderId, meta] of pending) {
    const key    = meta.acct === 'bull' ? process.env.ALPACA_KEY    : process.env.ALPACA_BEAR_KEY;
    const secret = meta.acct === 'bull' ? process.env.ALPACA_SECRET : process.env.ALPACA_BEAR_SECRET;
    if (!key || !secret) continue;
    try {
      const r = await fetch(`${ALPACA_BASE}/orders/${orderId}`, { headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret } });
      if (!r.ok) continue;
      const order = await r.json();
      if (order.status === 'filled') {
        console.log(`[Recovery][${meta.label}] Entry filled during downtime — placing exits for ${meta.symbol}`);
        seenOrderIds.add(orderId);
        await placeMultiTargetExits(order, meta, key, secret);
        saveOrderMetadata();
      } else if (['canceled','expired'].includes(order.status)) {
        delete orderMetadata[orderId];
        saveOrderMetadata();
      }
    } catch(e) { console.error(`[Recovery] Error checking ${orderId}: ${e.message}`); }
  }
}

async function seedAccount(key, secret) {
  if (!key || !secret) return;
  try {
    const r = await fetch(`${ALPACA_BASE}/orders?status=filled&limit=50`, { headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret } });
    if (!r.ok) return;
    const orders = await r.json();
    // Don't seed orders that are still pending exit placement — they need to be processed
    const pendingEntryIds = new Set(
      Object.entries(orderMetadata)
        .filter(([, m]) => m.mode === 'multi' && m.status === 'pending_fill')
        .map(([id]) => id)
    );
    for (const order of orders) {
      if (!pendingEntryIds.has(order.id)) seenOrderIds.add(order.id);
    }
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
    const r = await fetch(`${ALPACA_BASE}/orders?status=filled&limit=50`, { headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret } });
    if (!r.ok) { console.error(`[${label}] Alpaca poll error:`, r.status); return; }
    const orders = await r.json();
    for (const order of orders) {
      if (seenOrderIds.has(order.id)) continue;
      seenOrderIds.add(order.id);

      const meta = orderMetadata[order.id];
      if (meta && meta.mode === 'multi' && meta.status === 'pending_fill') {
        await placeMultiTargetExits(order, meta, key, secret);
      }

      const entryId  = exitToEntry[order.id];
      const exitMeta = entryId ? orderMetadata[entryId] : null;
      if (exitMeta && order.id === exitMeta.exitOrderIds?.t2OrderId && exitMeta.status === 'exits_placed') {
        await handleTarget2Fill(entryId, exitMeta, key, secret);
      }

      // Look up the original entry fill price so exit notifications can show P&L
      let entryFillPrice = null;
      if (entryId) {
        try {
          const row = db.prepare('SELECT entry_price FROM trades WHERE alpaca_order_id=?').get(entryId);
          entryFillPrice = row?.entry_price || null;
        } catch(e) {}
      }
      // For bracket exits exitMeta is null — determine type from order_type
      const isBracketExit = !!entryId && !exitMeta;
      await sendTradeNotification(order, label, {
        entryMeta:  meta,
        entryPrice: entryFillPrice,
        isT1:    exitMeta ? order.id === exitMeta.exitOrderIds?.t1OrderId    : (isBracketExit && order.order_type === 'limit'),
        isT2:    exitMeta ? order.id === exitMeta.exitOrderIds?.t2OrderId    : false,
        isTrail: exitMeta ? order.id === exitMeta.exitOrderIds?.trailOrderId : false,
        isSL:    exitMeta ? order.id === exitMeta.exitOrderIds?.slOrderId    : (isBracketExit && (order.order_type === 'stop' || order.order_type === 'stop_limit')),
      });

      // Save filled entry orders to trades DB; also record P&L for multi-target exits
      try {
        const isExitOrder = !!exitToEntry[order.id];
        if (isExitOrder && entryId) {
          // Write P&L for exit fills (multi-target and bracket)
          const isSL    = exitMeta ? order.id === exitMeta.exitOrderIds?.slOrderId    : (order.order_type === 'stop' || order.order_type === 'stop_limit');
          const isT1loc = exitMeta ? order.id === exitMeta.exitOrderIds?.t1OrderId    : (order.order_type === 'limit');
          const isT2loc = exitMeta ? order.id === exitMeta.exitOrderIds?.t2OrderId    : false;
          const isTrl   = exitMeta ? order.id === exitMeta.exitOrderIds?.trailOrderId : false;
          const exitPrice = parseFloat(order.filled_avg_price || 0);
          const exitQty   = parseFloat(order.filled_qty || order.qty || 0);
          if (entryFillPrice && exitPrice && exitQty) {
            const row = db.prepare('SELECT direction, dollar_amount FROM trades WHERE alpaca_order_id=?').get(entryId);
            if (row && !row.exit_reason) {
              const isBull = row.direction === 'bull';
              const pnl    = isBull ? (exitPrice - entryFillPrice) * exitQty : (entryFillPrice - exitPrice) * exitQty;
              const pct    = row.dollar_amount ? pnl / row.dollar_amount * 100 : 0;
              const exitReason = isSL ? 'stop_loss' : isT2loc ? 'target2' : isTrl ? 'trail' : 'target1';
              const exitTimeET = order.filled_at
                ? new Date(order.filled_at).toLocaleString('en-US', { timeZone: 'America/New_York' })
                : nowETStr();
              db.prepare(`
                UPDATE trades SET total_pnl=?, total_pct=?, exit_reason=?, exit_time_et=?,
                  t1_filled_at=COALESCE(t1_filled_at,?), t1_pnl=COALESCE(t1_pnl,?),
                  stop_loss_hit=?, status='closed'
                WHERE alpaca_order_id=?
              `).run(
                pnl, pct, exitReason, exitTimeET,
                isT1loc ? exitTimeET : null, isT1loc ? pnl : null,
                isSL ? 1 : 0,
                entryId
              );
            }
          }
        }
        if (!isExitOrder) {
          const direction  = (meta?.isBull !== undefined) ? (meta.isBull ? 'bull' : 'bear') : (order.side === 'buy' ? 'bull' : 'bear');
          const entryPrice = parseFloat(order.filled_avg_price || 0);
          const shares     = parseFloat(order.filled_qty || order.qty || 0);
          const entryTimeET = order.filled_at
            ? new Date(order.filled_at).toLocaleString('en-US', { timeZone: 'America/New_York' })
            : nowETStr();
          let t1Price = null, slPrice = null, orderMode = 'manual';
          if (order.order_class === 'bracket') {
            orderMode = 'bracket';
            const legs = order.legs || [];
            const tpLeg = legs.find(l => l.type === 'limit');
            const slLeg = legs.find(l => l.type === 'stop_limit' || l.type === 'stop');
            t1Price = tpLeg ? parseFloat(tpLeg.limit_price) : null;
            slPrice = slLeg ? parseFloat(slLeg.stop_price)  : null;
          } else if (meta?.mode === 'multi') {
            orderMode = 'multi';
            t1Price = meta.target1 ? parseFloat(meta.target1) : null;
            slPrice = meta.stopLossPrice ? parseFloat(meta.stopLossPrice) : null;
          }
          db.prepare(`
            INSERT INTO trades (alpaca_order_id,symbol,direction,account,entry_price,shares,dollar_amount,t1_price,stop_loss_price,entry_time_et,order_mode,status)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,'filled')
            ON CONFLICT(alpaca_order_id) DO UPDATE SET
              status='filled',
              entry_price=excluded.entry_price,
              shares=excluded.shares,
              dollar_amount=excluded.dollar_amount,
              entry_time_et=excluded.entry_time_et
          `).run(
            order.id, order.symbol, direction, label.toLowerCase(),
            entryPrice, shares, entryPrice * shares,
            t1Price, slPrice, entryTimeET, orderMode
          );
          // Register bracket exit legs so they're identified as exits when they fill
          if (order.order_class === 'bracket') {
            for (const leg of (order.legs || [])) {
              if (leg.id) exitToEntry[leg.id] = order.id;
            }
          }
        }
      } catch(e) { console.error(`[${label}] DB trade save error:`, e.message); }
    }
  } catch (e) { console.error(`[${label}] Poll error:`, e.message); }
}

async function syncBracketExits(key, secret, label, dateStr = null) {
  if (!key || !secret) return;
  try {
    let after, until = '';
    if (dateStr) {
      after = new Date(dateStr + 'T04:00:00Z').toISOString();
      const nextDay = new Date(new Date(dateStr + 'T04:00:00Z').getTime() + 86400000);
      until = `&until=${nextDay.toISOString()}`;
    } else {
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      after = todayStart.toISOString();
    }
    const r = await fetch(
      `${ALPACA_BASE}/orders?status=all&limit=200&after=${after}${until}&nested=true`,
      { headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret } }
    );
    if (!r.ok) return;
    const orders = await r.json();
    for (const order of orders) {
      if (order.order_class !== 'bracket' || order.status !== 'filled') continue;
      const legs = order.legs || [];
      const filledLeg = legs.find(l => l.status === 'filled');
      if (!filledLeg) continue;
      const trade = db.prepare('SELECT * FROM trades WHERE alpaca_order_id=?').get(order.id);
      if (!trade || trade.exit_reason) continue;
      const entryPrice = parseFloat(order.filled_avg_price || 0);
      const qty        = parseFloat(order.filled_qty || order.qty || 0);
      const exitPrice  = parseFloat(filledLeg.filled_avg_price || 0);
      if (!entryPrice || !exitPrice || !qty) continue;
      const isBull = order.side === 'buy';
      const pnl    = isBull ? (exitPrice - entryPrice) * qty : (entryPrice - exitPrice) * qty;
      const pct    = pnl / (entryPrice * qty) * 100;
      const isT1   = filledLeg.type === 'limit';
      const exitReason = isT1 ? 'target1' : 'stop_loss';
      const exitTimeET = filledLeg.filled_at
        ? new Date(filledLeg.filled_at).toLocaleString('en-US', { timeZone: 'America/New_York' })
        : nowETStr();
      const entryMs    = order.filled_at     ? new Date(order.filled_at).getTime()     : null;
      const exitMs     = filledLeg.filled_at ? new Date(filledLeg.filled_at).getTime() : null;
      const holdMinutes = entryMs && exitMs ? (exitMs - entryMs) / 60000 : null;
      db.prepare(`
        UPDATE trades SET
          total_pnl=?, total_pct=?, exit_reason=?, exit_time_et=?, hold_minutes=?,
          t1_filled_at=?, t1_pnl=?, stop_loss_hit=?, status='closed'
        WHERE alpaca_order_id=?
      `).run(
        pnl, pct, exitReason, exitTimeET, holdMinutes,
        isT1 ? exitTimeET : null,
        isT1 ? pnl : null,
        isT1 ? 0 : 1,
        order.id
      );
      console.log(`[${label}] bracket exit synced: ${order.symbol} ${exitReason} P&L=$${pnl.toFixed(2)}`);
    }
  } catch(e) { console.error(`[${label}] syncBracketExits error:`, e.message); }
}

async function pollFilledOrders() {
  await pollAccount(process.env.ALPACA_KEY, process.env.ALPACA_SECRET, 'BULL');
  await pollAccount(process.env.ALPACA_BEAR_KEY, process.env.ALPACA_BEAR_SECRET, 'BEAR');
  await syncBracketExits(process.env.ALPACA_KEY, process.env.ALPACA_SECRET, 'BULL');
  await syncBracketExits(process.env.ALPACA_BEAR_KEY, process.env.ALPACA_BEAR_SECRET, 'BEAR');
}

// ── Daily summary at 21:00 UTC (4pm ET) ───────────────────────────────────────

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
    const pnl = entry.side === 'buy' ? (exitPrice - entryPrice)*qty : (entryPrice - exitPrice)*qty;
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
  const date = new Date().toLocaleDateString('en-US', { timeZone:'America/New_York', weekday:'long', month:'short', day:'numeric' });
  try {
    const bull = await fetchAccountStats(bullKey, bullSecret);
    const bear = bearKey && bearSecret ? await fetchAccountStats(bearKey, bearSecret) : null;
    const fmt  = (stats, label) => {
      const closed = stats.winners + stats.losers;
      const sign   = stats.totalPnl >= 0 ? '+' : '';
      const openNote = stats.openTrades > 0 ? ` (${stats.openTrades} open)` : '';
      return `[${label}] ${closed} trades${openNote} · ✅${stats.winners} ❌${stats.losers} · ${sign}$${stats.totalPnl.toFixed(2)}`;
    };
    const netPnl  = bull.totalPnl + (bear ? bear.totalPnl : 0);
    const netSign = netPnl >= 0 ? '+' : '';
    await sendTelegram([
      `📊 Daily Summary — ${date}`, fmt(bull,'BULL'),
      bear ? fmt(bear,'BEAR') : '[BEAR] no account configured',
      `Net P&L: ${netSign}$${netPnl.toFixed(2)}`
    ].join('\n'));
    console.log('Daily summary sent');
  } catch (e) { console.error('Daily summary error:', e.message); }
}

async function syncPendingOrderStatuses() {
  const accounts = [
    { key: process.env.ALPACA_KEY, secret: process.env.ALPACA_SECRET, label: 'bull' },
    { key: process.env.ALPACA_BEAR_KEY, secret: process.env.ALPACA_BEAR_SECRET, label: 'bear' },
  ];
  const pending = db.prepare(`SELECT alpaca_order_id, account FROM trades WHERE status='pending' AND date(created_at)=?`).all(dateET());
  for (const trade of pending) {
    const acct = accounts.find(a => a.label === trade.account);
    if (!acct?.key) continue;
    try {
      const r = await fetch(`${ALPACA_BASE}/orders/${trade.alpaca_order_id}`, {
        headers: { 'APCA-API-KEY-ID': acct.key, 'APCA-API-SECRET-KEY': acct.secret }
      });
      if (!r.ok) continue;
      const order = await r.json();
      let newStatus = null;
      if (order.status === 'cancelled') newStatus = 'cancelled';
      else if (order.status === 'expired' || order.status === 'done_for_day') newStatus = 'expired';
      else if (order.status === 'filled') newStatus = 'filled';
      if (newStatus) {
        db.prepare(`UPDATE trades SET status=? WHERE alpaca_order_id=?`).run(newStatus, trade.alpaca_order_id);
        console.log(`Status sync: ${trade.alpaca_order_id} → ${newStatus}`);
      }
    } catch(e) { console.error('Status sync error:', e.message); }
  }
}

// ── Close all positions ────────────────────────────────────────────────────────

async function closeAllPositions(triggeredBy = 'manual') {
  const accounts = [
    { key: process.env.ALPACA_KEY,      secret: process.env.ALPACA_SECRET,      label: 'BULL' },
    { key: process.env.ALPACA_BEAR_KEY, secret: process.env.ALPACA_BEAR_SECRET, label: 'BEAR' },
  ].filter(a => a.key && a.secret);

  let submitted = 0, errors = [];
  const acctSymbols = {};
  const acctHeaders = {};

  for (const acct of accounts) {
    const headers = { 'APCA-API-KEY-ID': acct.key, 'APCA-API-SECRET-KEY': acct.secret, 'Content-Type': 'application/json' };
    acctHeaders[acct.label] = headers;
    try {
      // Fetch positions before closing so we can report symbols and P&L
      const posRes = await fetch(`${ALPACA_BASE}/positions`, { headers });
      const positions = posRes.ok ? await posRes.json() : [];
      if (!Array.isArray(positions) || positions.length === 0) continue;

      // Cancel all open orders first — then wait 3s for Alpaca to finish processing
      // the cancellations before closing positions. Without the delay, bracket order
      // legs (TP/SL) may still be locking shares, causing "insufficient qty" errors.
      await fetch(`${ALPACA_BASE}/orders`, { method: 'DELETE', headers });
      await new Promise(resolve => setTimeout(resolve, 30000));

      // Submit close orders — Alpaca returns 207 Multi-Status with per-position results
      const r = await fetch(`${ALPACA_BASE}/positions`, { method: 'DELETE', headers });
      const result = await r.json();
      console.log(`[${acct.label}] DELETE /positions status=${r.status} body=${JSON.stringify(result)}`);

      // Count only the individual close requests that Alpaca accepted (status 200 in each wrapper)
      const accepted = Array.isArray(result)
        ? result.filter(item => item.status === 200).length
        : (r.ok ? positions.length : 0);
      submitted += accepted;

      const failed = Array.isArray(result)
        ? result.filter(item => item.status !== 200).map(item => item.body?.message || 'unknown error')
        : [];
      if (failed.length) errors.push(`[${acct.label}] ${failed.join(', ')}`);

      acctSymbols[acct.label] = positions.map(p => {
        const pl = parseFloat(p.unrealized_pl);
        const sgn = pl >= 0 ? '+' : '-';
        return `${p.symbol} (${sgn}$${Math.abs(pl).toFixed(2)})`;
      });
    } catch(e) { errors.push(`[${acct.label}] ${e.message}`); }
  }

  const tag = triggeredBy === 'auto' ? '⏰ Auto-close EOD' : '🔴 Manual close-all';
  const lines = [`${tag} — ${submitted} close order(s) submitted`];
  for (const [label, syms] of Object.entries(acctSymbols)) {
    if (syms.length) lines.push(`${label}: ${syms.join(', ')}`);
  }
  if (errors.length) lines.push(`Errors: ${errors.join(', ')}`);
  const msg = lines.join('\n');
  await sendTelegram(msg).catch(e => console.error('Telegram error:', e.message));
  console.log(msg);

  // Verify fills after 15 seconds — alert if any positions remain open
  setTimeout(async () => {
    const stillOpen = [];
    for (const acct of accounts) {
      const headers = acctHeaders[acct.label];
      if (!headers) continue;
      try {
        const posRes = await fetch(`${ALPACA_BASE}/positions`, { headers });
        const remaining = posRes.ok ? await posRes.json() : [];
        if (Array.isArray(remaining) && remaining.length > 0) {
          stillOpen.push(`${acct.label}: ${remaining.map(p => p.symbol).join(', ')}`);
        }
      } catch(e) { /* ignore verification errors */ }
    }
    if (stillOpen.length > 0) {
      console.log(`[EOD] Positions still open after 15s — retrying close: ${stillOpen.join(', ')}`);
      await sendTelegram(`⚠️ EOD: positions still open after 15s — retrying close:\n${stillOpen.join('\n')}`).catch(() => {});
      // One automatic retry with fresh cancel + wait + close
      for (const acct of accounts) {
        const headers = acctHeaders[acct.label];
        if (!headers) continue;
        try {
          await fetch(`${ALPACA_BASE}/orders`, { method: 'DELETE', headers });
          await new Promise(resolve => setTimeout(resolve, 30000));
          const retryRes = await fetch(`${ALPACA_BASE}/positions`, { method: 'DELETE', headers });
          const retryBody = await retryRes.json();
          console.log(`[${acct.label}] Retry close status=${retryRes.status} body=${JSON.stringify(retryBody)}`);
        } catch(e) { console.error(`[${acct.label}] Retry close error:`, e.message); }
      }
      // Final check after retry
      await new Promise(resolve => setTimeout(resolve, 10000));
      const finalOpen = [];
      for (const acct of accounts) {
        const headers = acctHeaders[acct.label];
        if (!headers) continue;
        try {
          const posRes = await fetch(`${ALPACA_BASE}/positions`, { headers });
          const remaining = posRes.ok ? await posRes.json() : [];
          if (Array.isArray(remaining) && remaining.length > 0) {
            finalOpen.push(`${acct.label}: ${remaining.map(p => p.symbol).join(', ')}`);
          }
        } catch(e) { /* ignore */ }
      }
      if (finalOpen.length > 0) {
        await sendTelegram(`🚨 EOD retry failed — positions STILL open, manual close required:\n${finalOpen.join('\n')}`).catch(() => {});
      } else {
        await sendTelegram(`✅ EOD retry succeeded — all positions now closed`).catch(() => {});
      }
    } else if (submitted > 0) {
      const confirm = `✅ Confirmed — all positions closed`;
      await sendTelegram(confirm).catch(() => {});
      console.log(confirm);
    }
  }, 15_000);

  return { submitted, errors };
}

app.post('/close-all', async (req, res) => {
  try {
    const result = await closeAllPositions('manual');
    res.json({ ok: true, ...result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/market-open-filter', async (req, res) => {
  try {
    const cancelled = await cancelStaleOpeningOrders();
    res.json({ ok: true, cancelled });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/db/sync-exits', async (req, res) => {
  try {
    const date = req.query.date || null;
    await syncBracketExits(process.env.ALPACA_KEY, process.env.ALPACA_SECRET, 'BULL', date);
    await syncBracketExits(process.env.ALPACA_BEAR_KEY, process.env.ALPACA_BEAR_SECRET, 'BEAR', date);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/settings/auto-close', (req, res) => {
  res.json({ enabled: getSetting('autoCloseEnabled', false), time: getSetting('autoCloseTime', '15:45') });
});

app.post('/settings/auto-close', (req, res) => {
  const { enabled, time } = req.body;
  if (enabled !== undefined) setSetting('autoCloseEnabled', !!enabled);
  if (time) setSetting('autoCloseTime', time);
  res.json({ ok: true, enabled: getSetting('autoCloseEnabled', false), time: getSetting('autoCloseTime', '15:45') });
});

// ── Market open filter ─────────────────────────────────────────────────────────
// Runs at 9:30 AM ET and again at 9:35 ET. Cancels any pending stop-limit entry
// orders where the market has already gapped through the trigger price:
//   Bull entry: cancel if market price >= trigger (price already above, no clean breakout)
//   SS entry:   cancel if market price <= trigger (price already below, already broken)

async function cancelStaleOpeningOrders() {
  const accounts = [
    { key: process.env.ALPACA_KEY,      secret: process.env.ALPACA_SECRET,      label: 'BULL' },
    { key: process.env.ALPACA_BEAR_KEY, secret: process.env.ALPACA_BEAR_SECRET, label: 'BEAR' },
  ].filter(a => a.key && a.secret);

  let totalCancelled = 0;
  const cancelMessages = [];

  for (const acct of accounts) {
    const headers = { 'APCA-API-KEY-ID': acct.key, 'APCA-API-SECRET-KEY': acct.secret };

    const r = await fetch(`${ALPACA_BASE}/orders?status=open&limit=200`, { headers });
    if (!r.ok) { console.error(`[OpenFilter][${acct.label}] order fetch failed: ${r.status}`); continue; }
    const orders = await r.json();

    // Only stop-limit entry orders (bracket or multi) that have a trigger price
    const stopEntries = orders.filter(o =>
      o.stop_price && parseFloat(o.stop_price) > 0 &&
      (o.type === 'stop_limit' || o.type === 'stop')
    );
    if (!stopEntries.length) continue;

    // Batch-fetch latest trade prices for all symbols
    const symbols = [...new Set(stopEntries.map(o => o.symbol))];
    const dataRes = await fetch(
      `${ALPACA_DATA_BASE}/stocks/trades/latest?symbols=${symbols.join(',')}`,
      { headers: { 'APCA-API-KEY-ID': process.env.ALPACA_KEY, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET } }
    );
    if (!dataRes.ok) { console.error(`[OpenFilter] price fetch failed: ${dataRes.status}`); continue; }
    const priceData = await dataRes.json();

    for (const order of stopEntries) {
      const lastTrade = priceData.trades?.[order.symbol];
      const currentPrice = lastTrade ? parseFloat(lastTrade.p) : null;
      if (!currentPrice) { console.warn(`[OpenFilter] no price for ${order.symbol}`); continue; }

      const trigger  = parseFloat(order.stop_price);
      const isBull   = order.side === 'buy';
      const shouldCancel = isBull ? currentPrice >= trigger : currentPrice <= trigger;

      if (shouldCancel) {
        try {
          const del = await fetch(`${ALPACA_BASE}/orders/${order.id}`, { method: 'DELETE', headers });
          if (del.ok || del.status === 204) {
            totalCancelled++;
            const dir = isBull ? '📈 Bull' : '📉 SS';
            cancelMessages.push(`${dir} ${order.symbol}: trigger $${trigger} | open $${currentPrice.toFixed(2)}`);
            try { db.prepare(`UPDATE trades SET status='cancelled' WHERE alpaca_order_id=?`).run(order.id); } catch(e) {}
            console.log(`[OpenFilter][${acct.label}] cancelled ${order.symbol} — trigger $${trigger} vs $${currentPrice.toFixed(2)}`);
          }
        } catch(e) { console.error(`[OpenFilter][${acct.label}] cancel error ${order.symbol}: ${e.message}`); }
      } else {
        console.log(`[OpenFilter][${acct.label}] OK: ${order.symbol} trigger $${trigger} vs $${currentPrice.toFixed(2)}`);
      }
    }
  }

  if (cancelMessages.length) {
    await sendTelegram([`🚫 Market open filter — ${totalCancelled} order(s) cancelled`, ...cancelMessages].join('\n')).catch(() => {});
  } else {
    console.log('[OpenFilter] All open orders valid at market open');
  }
  return totalCancelled;
}

let lastAutoCloseDate  = null;
let lastOpenFilter930  = null;
let lastOpenFilter935  = null;

setInterval(() => {
  const now     = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const etNow   = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const isWeekday  = etNow.getDay() >= 1 && etNow.getDay() <= 5;
  const etMinutes  = etNow.getHours() * 60 + etNow.getMinutes();

  if (now.getUTCHours() === 21 && now.getUTCMinutes() === 0 && lastSummaryDate !== dateStr) {
    lastSummaryDate = dateStr;
    syncPendingOrderStatuses();
    sendDailySummary();
  }

  // Market open filter — 9:30 AM ET and re-check at 9:35 AM ET
  if (isWeekday) {
    if (etMinutes === 9 * 60 + 30 && lastOpenFilter930 !== dateStr) {
      lastOpenFilter930 = dateStr;
      cancelStaleOpeningOrders().catch(e => console.error('[OpenFilter 9:30]', e.message));
    }
    if (etMinutes === 9 * 60 + 35 && lastOpenFilter935 !== dateStr) {
      lastOpenFilter935 = dateStr;
      cancelStaleOpeningOrders().catch(e => console.error('[OpenFilter 9:35]', e.message));
    }
  }

  // Auto-close check — use >= window so a server restart near close time doesn't miss it
  if (getSetting('autoCloseEnabled', false) && lastAutoCloseDate !== dateStr) {
    const closeTime    = getSetting('autoCloseTime', '15:45');
    const [h, m]       = closeTime.split(':').map(Number);
    const targetMinutes = h * 60 + m;
    if (isWeekday && etMinutes >= targetMinutes && etMinutes < 16 * 60) {
      lastAutoCloseDate = dateStr;
      closeAllPositions('auto');
    }
  }
}, 60_000);

app.listen(process.env.PORT || 3001, async () => {
  console.log('Server running');
  rebuildExitToEntry();
  await recoverMultiTargetOrders();
  await seedSeenOrders();
  setInterval(pollFilledOrders, 30_000);
});
