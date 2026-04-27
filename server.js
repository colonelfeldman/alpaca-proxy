const express = require('express');
const cors = require('cors');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// Serve trading agent UI
app.use(express.static(path.join(__dirname, 'public')));

// Alpaca proxy
app.all('/alpaca/*', async (req, res) => {
  const url = 'https://paper-api.alpaca.markets/v2/' + req.params[0];
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

app.listen(process.env.PORT || 3001, () => console.log('Server running'));
