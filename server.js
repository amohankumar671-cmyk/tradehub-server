const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const FYERS_APP_ID = 'UWU4FAV9OW-100';
const FYERS_SECRET = 'CCHIBXXTR7';
const FYERS_REDIRECT_URI = 'https://tradehub-server-production.up.railway.app/callback';

// In-memory token store
let accessToken = null;
let tokenExpiry = null;

function isTokenValid() {
  return accessToken && tokenExpiry && Date.now() < tokenExpiry;
}

// ─── AUTH ─────────────────────────────────────────────────────────

// Step 1: Visit /auth → redirects to Fyers login
app.get('/auth', (req, res) => {
  const loginUrl = `https://api-t1.fyers.in/api/v3/generate-authcode?client_id=${FYERS_APP_ID}&redirect_uri=${encodeURIComponent(FYERS_REDIRECT_URI)}&response_type=code&state=tradehub`;
  console.log('Redirecting to Fyers login:', loginUrl);
  res.redirect(loginUrl);
});

// Step 2: Fyers redirects back here with ?auth_code=xxx or ?code=xxx
app.get('/callback', async (req, res) => {
  console.log('Callback received. Query params:', req.query);

  const authCode = req.query.auth_code || req.query.code || req.query.authcode;

  if (!authCode) {
    return res.status(400).send(`
      <html><body style="font-family:Arial;background:#1a0000;color:#ff6b6b;padding:40px;">
        <h2>❌ Auth Failed</h2>
        <p>No auth code received from Fyers.</p>
        <p>Params received: ${JSON.stringify(req.query)}</p>
        <a href="/auth" style="color:#6366f1">Try again →</a>
      </body></html>
    `);
  }

  try {
    // Generate SHA256 hash: appId:secret
    const hashInput = `${FYERS_APP_ID}:${FYERS_SECRET}`;
    const appIdHash = crypto.createHash('sha256').update(hashInput).digest('hex');
    console.log('Auth code:', authCode);
    console.log('App ID Hash generated');

    const response = await axios.post(
      'https://api-t1.fyers.in/api/v3/validate-authcode',
      { grant_type: 'authorization_code', appIdHash, code: authCode },
      { headers: { 'Content-Type': 'application/json' } }
    );

    console.log('Fyers token response:', response.data);

    if (response.data.s === 'ok' && response.data.access_token) {
      accessToken = response.data.access_token;
      tokenExpiry = Date.now() + (23 * 60 * 60 * 1000);
      console.log('✅ Access token saved! Valid for 23 hours.');

      return res.send(`
        <html><body style="font-family:Arial;background:#0a0a0f;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
          <div style="text-align:center;padding:40px;background:#111827;border-radius:16px;border:2px solid #22c55e;max-width:400px;">
            <div style="font-size:64px">🎉</div>
            <h2 style="color:#22c55e;margin:16px 0">Fyers Connected!</h2>
            <p style="color:#94a3b8">Access token saved successfully.</p>
            <p style="color:#64748b;font-size:13px">Token valid for 23 hours.</p>
            <div style="margin-top:24px;display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
              <a href="/oi?symbol=NIFTY" style="padding:10px 20px;background:#22c55e;color:#000;border-radius:8px;text-decoration:none;font-weight:700;">
                Test NIFTY Data →
              </a>
              <a href="https://tradehub-934.pages.dev/oi-analysis" style="padding:10px 20px;background:#6366f1;color:#fff;border-radius:8px;text-decoration:none;font-weight:700;">
                Go to Website →
              </a>
            </div>
          </div>
        </body></html>
      `);
    } else {
      return res.status(400).send(`
        <html><body style="font-family:Arial;background:#1a0000;color:#ff6b6b;padding:40px;">
          <h2>❌ Token Generation Failed</h2>
          <pre>${JSON.stringify(response.data, null, 2)}</pre>
          <a href="/auth" style="color:#6366f1">Try again →</a>
        </body></html>
      `);
    }
  } catch (err) {
    console.error('Token error:', err.response?.data || err.message);
    return res.status(500).send(`
      <html><body style="font-family:Arial;background:#1a0000;color:#ff6b6b;padding:40px;">
        <h2>❌ Error</h2>
        <p>${err.message}</p>
        <pre>${JSON.stringify(err.response?.data || {}, null, 2)}</pre>
        <a href="/auth" style="color:#6366f1">Try again →</a>
      </body></html>
    `);
  }
});

// ─── OI DATA ──────────────────────────────────────────────────────

function getSignal(priceChange, oiChange) {
  if (priceChange > 0 && oiChange > 0) return { signal: 'Long Buildup',   color: 'green'  };
  if (priceChange < 0 && oiChange > 0) return { signal: 'Short Buildup',  color: 'red'    };
  if (priceChange > 0 && oiChange < 0) return { signal: 'Short Covering', color: 'blue'   };
  if (priceChange < 0 && oiChange < 0) return { signal: 'Long Unwinding', color: 'orange' };
  return { signal: 'Neutral', color: 'gray' };
}

function getMockData(symbol) {
  const strikes = [22000,22100,22200,22300,22400,22500,22600,22700,22800,22900,23000];
  const signals = [
    { pc: 1,  oc: 5000  },
    { pc: -1, oc: 8000  },
    { pc: 2,  oc: -3000 },
    { pc: -2, oc: -4000 },
    { pc: 0,  oc: 0     },
  ];
  const rows = [];
  strikes.forEach((strike, i) => {
    const s = signals[i % signals.length];
    rows.push({ type: 'CE', strike, ltp: 120+i*10, oi: 50000+i*1000, oiChange: s.oc,  volume: 20000, priceChange: s.pc,  iv: 14.5, ...getSignal(s.pc, s.oc)   });
    rows.push({ type: 'PE', strike, ltp: 80+i*5,   oi: 40000+i*800,  oiChange: -s.oc, volume: 18000, priceChange: -s.pc, iv: 13.2, ...getSignal(-s.pc, -s.oc) });
  });
  return { symbol, isMock: true, mockNote: '⚠️ Mock data — visit /auth to connect Fyers', underlyingValue: 22450, nearExpiry: '27-Mar-2026', expiryDates: ['27-Mar-2026','03-Apr-2026'], rows, total: rows.length };
}

const SYMBOL_MAP = {
  NIFTY:      'NSE:NIFTY50-INDEX',
  BANKNIFTY:  'NSE:NIFTYBANK-INDEX',
  FINNIFTY:   'NSE:FINNIFTY-INDEX',
  MIDCPNIFTY: 'NSE:MIDCPNIFTY-INDEX',
};

async function fetchFyersOI(symbol) {
  const fyersSymbol = SYMBOL_MAP[symbol] || 'NSE:NIFTY50-INDEX';

  const response = await axios.get('https://api-t1.fyers.in/api/v3/options/chain', {
    params: { symbol: fyersSymbol, strikecount: 10, timestamp: '' },
    headers: {
      'Authorization': `${FYERS_APP_ID}:${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (response.data.s !== 'ok') throw new Error('Fyers API error: ' + JSON.stringify(response.data));

  const optionsData = response.data.data?.optionsChain || [];
  const underlyingValue = response.data.data?.ltp || 0;
  const expiryDates = [...new Set(optionsData.map(o => o.expiry))].sort();
  const nearExpiry = expiryDates[0];

  const rows = optionsData
    .filter(o => o.expiry === nearExpiry)
    .map(o => ({
      type: o.option_type,
      strike: o.strike_price,
      ltp: o.ltp || 0,
      oi: o.oi || 0,
      oiChange: o.oi_change || 0,
      volume: o.volume || 0,
      priceChange: o.change || 0,
      iv: o.iv || 0,
      ...getSignal(o.change || 0, o.oi_change || 0),
    }));

  return { underlyingValue, nearExpiry, expiryDates, rows };
}

// ─── ROUTES ───────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    status: 'TradeHub Server Running ✅',
    fyers: isTokenValid() ? '✅ Connected' : '❌ Not connected — visit /auth to login',
    tokenExpiresIn: isTokenValid() ? Math.round((tokenExpiry - Date.now()) / 60000) + ' mins' : null,
  });
});

app.get('/myip', async (req, res) => {
  try {
    const r = await axios.get('https://api.ipify.org?format=json');
    res.json({ railwayIP: r.data.ip });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/oi', async (req, res) => {
  const symbol = (req.query.symbol || 'NIFTY').toUpperCase();

  if (req.query.mock === 'true') return res.json(getMockData(symbol));

  if (!isTokenValid()) {
    return res.json({
      ...getMockData(symbol),
      authRequired: true,
      message: 'Fyers not connected. Visit /auth to login.',
    });
  }

  try {
    const data = await fetchFyersOI(symbol);
    res.json({ symbol, ...data, total: data.rows.length, isMock: false, source: 'fyers' });
  } catch (err) {
    console.error('Fyers OI error:', err.message);
    res.json({ ...getMockData(symbol), fyersError: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`TradeHub Server running on port ${PORT}`);
  console.log(`Visit /auth to connect Fyers`);
});
