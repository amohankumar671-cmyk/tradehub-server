const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Config — read at runtime only
function getConfig() {
  return {
    appId: process.env.FYERS_APP_ID || 'UWU4FAV9OW-100',
    secret: process.env.FYERS_SECRET || 'CCHIBXXTR7',
    redirectUri: process.env.FYERS_REDIRECT_URI || 'https://tradehub-server-production.up.railway.app/callback',
  };
}

// In-memory token store
let accessToken = null;
let tokenExpiry = null;

function isTokenValid() {
  return accessToken && tokenExpiry && Date.now() < tokenExpiry;
}

// ─── Auth Routes ──────────────────────────────────────────────────

// Step 1: Redirect to Fyers login
app.get('/auth', (req, res) => {
  const { appId, redirectUri } = getConfig();
  const loginUrl = `https://api-t1.fyers.in/api/v3/generate-authcode?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&state=tradehub`;
  res.redirect(loginUrl);
});

// Step 2: Fyers redirects back here with auth code
app.get('/callback', async (req, res) => {
  const { code, auth_code } = req.query;
  const authCode = code || auth_code;

  if (!authCode) {
    return res.status(400).json({ error: 'No auth code received', query: req.query });
  }

  try {
    const { appId, secret } = getConfig();

    // Generate SHA256 hash of appId:secret
    const hash = crypto.createHash('sha256').update(`${appId}:${secret}`).digest('hex');

    const response = await axios.post('https://api-t1.fyers.in/api/v3/validate-authcode', {
      grant_type: 'authorization_code',
      appIdHash: hash,
      code: authCode,
    });

    if (response.data.s === 'ok' && response.data.access_token) {
      accessToken = response.data.access_token;
      tokenExpiry = Date.now() + (23 * 60 * 60 * 1000); // 23 hours

      console.log('✅ Fyers access token saved successfully!');

      return res.send(`
        <html>
          <body style="font-family:Arial;background:#0a0a0f;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
            <div style="text-align:center;padding:40px;background:#111827;border-radius:16px;border:1px solid #22c55e;">
              <div style="font-size:48px">🎉</div>
              <h2 style="color:#22c55e;margin:16px 0">Fyers Connected!</h2>
              <p>Access token saved successfully.</p>
              <p style="color:#64748b;font-size:13px">Token valid for 23 hours. Visit <a href="/oi?symbol=NIFTY" style="color:#6366f1">/oi?symbol=NIFTY</a> to test.</p>
              <a href="https://tradehub-934.pages.dev/oi-analysis" style="display:inline-block;margin-top:20px;padding:12px 24px;background:#6366f1;color:white;border-radius:8px;text-decoration:none;font-weight:600;">
                Go to OI Analysis →
              </a>
            </div>
          </body>
        </html>
      `);
    } else {
      return res.status(400).json({ error: 'Token generation failed', response: response.data });
    }
  } catch (err) {
    console.error('Callback error:', err.response?.data || err.message);
    return res.status(500).json({ error: err.message, detail: err.response?.data });
  }
});

// ─── OI Data ──────────────────────────────────────────────────────

const SYMBOL_MAP = {
  NIFTY:      'NSE:NIFTY50-INDEX',
  BANKNIFTY:  'NSE:NIFTYBANK-INDEX',
  FINNIFTY:   'NSE:FINNIFTY-INDEX',
  MIDCPNIFTY: 'NSE:MIDCPNIFTY-INDEX',
};

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
    rows.push({ type: 'CE', strike, ltp: 120+i*10, oi: 50000+i*1000, oiChange: s.oc,  volume: 20000, priceChange: s.pc,  iv: 14.5, ...getSignal(s.pc,  s.oc)  });
    rows.push({ type: 'PE', strike, ltp: 80+i*5,   oi: 40000+i*800,  oiChange: -s.oc, volume: 18000, priceChange: -s.pc, iv: 13.2, ...getSignal(-s.pc, -s.oc) });
  });
  return { symbol, isMock: true, mockNote: '⚠️ Mock data — connect Fyers via /auth or market closed', underlyingValue: 22450, nearExpiry: '27-Mar-2026', expiryDates: ['27-Mar-2026','03-Apr-2026'], rows, total: rows.length };
}

async function fetchFyersOptionChain(symbol) {
  const { appId } = getConfig();
  const fyersSymbol = SYMBOL_MAP[symbol] || 'NSE:NIFTY50-INDEX';

  const response = await axios.get(`https://api-t1.fyers.in/api/v3/options/chain`, {
    params: { symbol: fyersSymbol, strikecount: 10, timestamp: '' },
    headers: {
      'Authorization': `${appId}:${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (response.data.s !== 'ok') throw new Error('Fyers error: ' + JSON.stringify(response.data));

  const optionsData = response.data.data?.optionsChain || [];
  const underlyingValue = response.data.data?.ltp || 0;
  const expiryDates = [...new Set(optionsData.map(o => o.expiry))].sort();
  const nearExpiry = expiryDates[0];

  const rows = optionsData
    .filter(o => o.expiry === nearExpiry)
    .map(o => {
      const priceChange = o.change || 0;
      const oiChange = o.oi_change || 0;
      return {
        type: o.option_type,
        strike: o.strike_price,
        ltp: o.ltp || 0,
        oi: o.oi || 0,
        oiChange,
        volume: o.volume || 0,
        priceChange,
        iv: o.iv || 0,
        ...getSignal(priceChange, oiChange),
      };
    });

  return { underlyingValue, nearExpiry, expiryDates, rows };
}

// ─── Main Endpoints ───────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    status: 'TradeHub Server Running',
    fyers: isTokenValid() ? '✅ Connected' : '❌ Not connected — visit /auth',
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
  const forceMock = req.query.mock === 'true';

  if (forceMock) return res.json(getMockData(symbol));

  if (!isTokenValid()) {
    return res.json({
      ...getMockData(symbol),
      authRequired: true,
      message: 'Visit /auth to connect Fyers and get real data',
    });
  }

  try {
    const data = await fetchFyersOptionChain(symbol);
    res.json({ symbol, ...data, total: data.rows.length, isMock: false, source: 'fyers' });
  } catch (err) {
    console.error('OI fetch error:', err.message);
    res.json({ ...getMockData(symbol), fyersError: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`TradeHub Server on port ${PORT}`);
  console.log(`Visit /auth to connect Fyers`);
});
