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
const db = new Database(path.join(__dirname, 'trading.db'));
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

  // Save setup to DB
  try {
    db.prepare(`INSERT INTO parsed_setups (date,symbol,direction,trigger_price,target1,target2,target3,account) VALUES (?,?,?,?,?,?,?,?)`)
      .run(dateET(), symbol.toUpperCase(), direction, trigger, targets[0]||null, targets[1]||null, targets[2]||null, isBull?'bull':'bear');
  } catch(e) { console.error('DB setup save error:', e.message); }

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
        await sendTelegram(`🟥✖️ ${acctEmoji} [${label}] Order rejected: ${symbol} ${side.toUpperCase()} @ $${trigger}\nReason: ${reason}`);
        return res.status(r.status).json({ error: reason });
      }
      const t2 = targets.length > 1 ? targets[1] : null;
      const trail = parseFloat(trailPct) || 1.5;
      orderMetadata[d.id] = {
        mode: 'multi', symbol: symbol.toUpperCase(), isBull, label,
        target1: tp, target2: t2, trailPct: trail, stopLossPrice: sl,
        acct: isBull ? 'bull' : 'bear', status: 'pending_fill', exitOrderIds: null, qty
      };
      saveOrderMetadata();
      console.log(`[${label}] Multi-target trade placed: ${side} ${qty} ${symbol} @ ${trigger}`);
      await sendTelegram(`${acctEmoji} [${label}] Multi-target placed: ${symbol} ${side.toUpperCase()} ${qty} sh @ $${trigger}\nT1 $${tp}${t2 ? ` · T2 $${t2}` : ''} · Trail ${trail}% · SL $${sl} ${acctEmoji}`);
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
      await sendTelegram(`🟥✖️ ${acctEmoji} [${label}] Order rejected: ${symbol} ${side.toUpperCase()} @ $${trigger}\nReason: ${reason}`);
      return res.status(r.status).json({ error: reason });
    }
    console.log(`[${label}] Trade placed: ${side} ${qty} ${symbol} @ ${trigger}`);
    await sendTelegram(`${acctEmoji} [${label}] Order placed: ${symbol} ${side.toUpperCase()} ${qty} sh @ $${trigger}\nTP $${tp} · SL $${sl} ${acctEmoji}`);
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

function buildTradeMessage(order, label) {
  const symbol = order.symbol || '?';
  const side   = (order.side || '').toUpperCase();
  const qty    = order.filled_qty || order.qty || '?';
  const price  = parseFloat(order.filled_avg_price || 0).toFixed(2);
  const time   = order.filled_at ? new Date(order.filled_at).toLocaleString() : new Date().toLocaleString();
  const type   = classifyOrder(order);
  const emoji  = label === 'BULL' ? '✅' : '🟦';
  return `${emoji} [${label}] ${symbol} filled - ${side} ${qty} shares @ $${price}\nType: ${type}\nTime: ${time} ${emoji}`;
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

// ── Multi-target exit management ───────────────────────────────────────────────

async function placeMultiTargetExits(entryOrder, meta, key, secret) {
  const { symbol, target1, target2, trailPct, stopLossPrice, isBull, label } = meta;
  const qty    = parseInt(entryOrder.filled_qty || entryOrder.qty || meta.qty);
  const share1 = Math.floor(qty / 3);
  const share2 = Math.floor(qty / 3);
  const share3 = qty - share1 - share2;
  const side   = isBull ? 'sell' : 'buy';
  const headers = { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret, 'Content-Type': 'application/json' };
  const placed = { t1OrderId: null, t2OrderId: null, trailOrderId: null, slOrderId: null };

  try {
    if (target2) {
      const [t1Res, t2Res, trailRes, slRes] = await Promise.all([
        fetch(`${ALPACA_BASE}/orders`, { method:'POST', headers, body: JSON.stringify({ symbol, qty:String(share1), side, type:'limit', limit_price:String(target1), time_in_force:'day' }) }),
        fetch(`${ALPACA_BASE}/orders`, { method:'POST', headers, body: JSON.stringify({ symbol, qty:String(share2), side, type:'limit', limit_price:String(target2), time_in_force:'day' }) }),
        fetch(`${ALPACA_BASE}/orders`, { method:'POST', headers, body: JSON.stringify({ symbol, qty:String(share3), side, type:'trailing_stop', trail_percent:String(trailPct), time_in_force:'day' }) }),
        fetch(`${ALPACA_BASE}/orders`, { method:'POST', headers, body: JSON.stringify({ symbol, qty:String(qty), side, type:'stop', stop_price:String(stopLossPrice), time_in_force:'day' }) })
      ]);
      const [t1d, t2d, trld, sld] = await Promise.all([t1Res.json(), t2Res.json(), trailRes.json(), slRes.json()]);
      placed.t1OrderId = t1d.id; placed.t2OrderId = t2d.id;
      placed.trailOrderId = trld.id; placed.slOrderId = sld.id;
      await sendTelegram(`📐 [${label}] Multi exits for ${symbol}:\n1/3 (${share1}sh) limit @ $${target1}\n1/3 (${share2}sh) limit @ $${target2}\n1/3 (${share3}sh) trail ${trailPct}%\nSL ${qty}sh @ $${stopLossPrice}`);
    } else {
      const twoThirds = share1 + share2;
      const [t1Res, trailRes, slRes] = await Promise.all([
        fetch(`${ALPACA_BASE}/orders`, { method:'POST', headers, body: JSON.stringify({ symbol, qty:String(twoThirds), side, type:'limit', limit_price:String(target1), time_in_force:'day' }) }),
        fetch(`${ALPACA_BASE}/orders`, { method:'POST', headers, body: JSON.stringify({ symbol, qty:String(share3), side, type:'trailing_stop', trail_percent:String(trailPct), time_in_force:'day' }) }),
        fetch(`${ALPACA_BASE}/orders`, { method:'POST', headers, body: JSON.stringify({ symbol, qty:String(qty), side, type:'stop', stop_price:String(stopLossPrice), time_in_force:'day' }) })
      ]);
      const [t1d, trld, sld] = await Promise.all([t1Res.json(), trailRes.json(), slRes.json()]);
      placed.t1OrderId = t1d.id; placed.trailOrderId = trld.id; placed.slOrderId = sld.id;
      await sendTelegram(`📐 [${label}] Multi exits for ${symbol}:\n2/3 (${twoThirds}sh) limit @ $${target1}\n1/3 (${share3}sh) trail ${trailPct}%\nSL ${qty}sh @ $${stopLossPrice}`);
    }
    meta.exitOrderIds = placed;
    meta.status = 'exits_placed';
    meta.filledQty = qty;
    if (placed.t1OrderId)    exitToEntry[placed.t1OrderId]    = entryOrder.id;
    if (placed.t2OrderId)    exitToEntry[placed.t2OrderId]    = entryOrder.id;
    if (placed.trailOrderId) exitToEntry[placed.trailOrderId] = entryOrder.id;
    if (placed.slOrderId)    exitToEntry[placed.slOrderId]    = entryOrder.id;
    saveOrderMetadata();
  } catch(e) {
    console.error(`[${label}] Multi-target exits error: ${e.message}`);
    await sendTelegram(`⚠️ [${label}] Failed to place multi exits for ${symbol}: ${e.message}`).catch(() => {});
  }
}

async function handleTarget2Fill(entryId, meta, key, secret) {
  const { symbol, target1, label, exitOrderIds } = meta;
  const qty    = meta.filledQty || meta.qty;
  const share3 = qty - 2 * Math.floor(qty / 3);
  const side   = meta.isBull ? 'sell' : 'buy';
  const headers = { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret, 'Content-Type': 'application/json' };
  if (exitOrderIds?.slOrderId) {
    try { await fetch(`${ALPACA_BASE}/orders/${exitOrderIds.slOrderId}`, { method:'DELETE', headers }); }
    catch(e) { console.error(`Cancel SL error: ${e.message}`); }
  }
  try {
    const r = await fetch(`${ALPACA_BASE}/orders`, {
      method: 'POST', headers,
      body: JSON.stringify({ symbol, qty: String(share3), side, type:'stop', stop_price:String(target1), time_in_force:'day' })
    });
    const d = await r.json();
    if (d.id) { meta.exitOrderIds.slOrderId = d.id; exitToEntry[d.id] = entryId; }
    meta.status = 'target2_filled';
    saveOrderMetadata();
    await sendTelegram(`🎯 [${label}] T2 filled for ${symbol} — stop moved to T1 $${target1} for ${share3} shares`);
  } catch(e) { console.error(`[${label}] handleTarget2Fill error: ${e.message}`); }
}

// ── Order metadata persistence ─────────────────────────────────────────────────

const ORDER_META_FILE = path.join(__dirname, '.order-metadata.json');

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

      const entryId = exitToEntry[order.id];
      if (entryId) {
        const entryMeta = orderMetadata[entryId];
        if (entryMeta && order.id === entryMeta.exitOrderIds?.t2OrderId && entryMeta.status === 'exits_placed') {
          await handleTarget2Fill(entryId, entryMeta, key, secret);
        }
      }

      await sendTradeNotification(order, label);

      // Save filled entry orders to trades DB
      try {
        if (order.order_class === 'bracket') {
          const direction = order.side === 'buy' ? 'bull' : 'bear';
          const entryPrice = parseFloat(order.filled_avg_price || 0);
          const shares     = parseFloat(order.filled_qty || order.qty || 0);
          const entryTimeET = order.filled_at
            ? new Date(order.filled_at).toLocaleString('en-US', { timeZone: 'America/New_York' })
            : nowETStr();
          const legs = order.legs || [];
          const tpLeg = legs.find(l => l.type === 'limit');
          const slLeg = legs.find(l => l.type === 'stop_limit' || l.type === 'stop');
          db.prepare(`
            INSERT INTO trades (alpaca_order_id,symbol,direction,account,entry_price,shares,dollar_amount,t1_price,stop_loss_price,entry_time_et,order_mode)
            VALUES (?,?,?,?,?,?,?,?,?,?,'bracket')
            ON CONFLICT(alpaca_order_id) DO NOTHING
          `).run(
            order.id, order.symbol, direction, label.toLowerCase(),
            entryPrice, shares, entryPrice * shares,
            tpLeg ? parseFloat(tpLeg.limit_price) : null,
            slLeg ? parseFloat(slLeg.stop_price)  : null,
            entryTimeET
          );
        }
      } catch(e) { console.error(`[${label}] DB trade save error:`, e.message); }
    }
  } catch (e) { console.error(`[${label}] Poll error:`, e.message); }
}

async function pollFilledOrders() {
  await pollAccount(process.env.ALPACA_KEY, process.env.ALPACA_SECRET, 'BULL');
  await pollAccount(process.env.ALPACA_BEAR_KEY, process.env.ALPACA_BEAR_SECRET, 'BEAR');
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
  rebuildExitToEntry();
  await recoverMultiTargetOrders();
  await seedSeenOrders();
  setInterval(pollFilledOrders, 30_000);
});
