const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const INDICES = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'];

// ─── NSE Session Fetcher ───────────────────────────────────────────
async function fetchNSEWithSession(symbol) {
  const isIndex = INDICES.includes(symbol.toUpperCase());
  const apiUrl = isIndex
    ? `https://www.nseindia.com/api/option-chain-indices?symbol=${symbol.toUpperCase()}`
    : `https://www.nseindia.com/api/option-chain-equities?symbol=${symbol.toUpperCase()}`;

  const baseHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
  };

  // Step 1: Hit homepage to get cookies
  const homeRes = await axios.get('https://www.nseindia.com', {
    headers: { ...baseHeaders, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    timeout: 12000,
  });

  let cookieStr = '';
  const homeCookies = homeRes.headers['set-cookie'];
  if (homeCookies) {
    cookieStr = homeCookies.map(c => c.split(';')[0]).join('; ');
  }

  // Step 2: Hit the option-chain page to warm up session
  await axios.get('https://www.nseindia.com/option-chain', {
    headers: {
      ...baseHeaders,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': 'https://www.nseindia.com',
      'Cookie': cookieStr,
    },
    timeout: 12000,
  });

  // Wait a moment like a human would
  await new Promise(r => setTimeout(r, 1500));

  // Step 3: Fetch option chain data
  const dataRes = await axios.get(apiUrl, {
    headers: {
      ...baseHeaders,
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://www.nseindia.com/option-chain',
      'X-Requested-With': 'XMLHttpRequest',
      'Cookie': cookieStr,
    },
    timeout: 15000,
  });

  return dataRes.data;
}

// ─── OI Signal Logic ──────────────────────────────────────────────
function getSignal(priceChange, oiChange) {
  if (priceChange > 0 && oiChange > 0) return { signal: 'Long Buildup',   color: 'green'  };
  if (priceChange < 0 && oiChange > 0) return { signal: 'Short Buildup',  color: 'red'    };
  if (priceChange > 0 && oiChange < 0) return { signal: 'Short Covering', color: 'blue'   };
  if (priceChange < 0 && oiChange < 0) return { signal: 'Long Unwinding', color: 'orange' };
  return { signal: 'Neutral', color: 'gray' };
}

function analyzeOI(data) {
  const records = data?.records?.data || [];
  const expiryDates = data?.records?.expiryDates || [];
  const nearExpiry = expiryDates[0];
  const underlyingValue = data?.records?.underlyingValue || 0;

  const rows = [];

  for (const record of records) {
    if (record.expiryDate !== nearExpiry) continue;
    const strike = record.strikePrice;

    if (record.CE) {
      const { change = 0, changeinOpenInterest = 0 } = record.CE;
      rows.push({
        type: 'CE', strike,
        ltp: record.CE.lastPrice || 0,
        oi: record.CE.openInterest || 0,
        oiChange: changeinOpenInterest,
        volume: record.CE.totalTradedVolume || 0,
        priceChange: change,
        iv: record.CE.impliedVolatility || 0,
        ...getSignal(change, changeinOpenInterest),
      });
    }

    if (record.PE) {
      const { change = 0, changeinOpenInterest = 0 } = record.PE;
      rows.push({
        type: 'PE', strike,
        ltp: record.PE.lastPrice || 0,
        oi: record.PE.openInterest || 0,
        oiChange: changeinOpenInterest,
        volume: record.PE.totalTradedVolume || 0,
        priceChange: change,
        iv: record.PE.impliedVolatility || 0,
        ...getSignal(change, changeinOpenInterest),
      });
    }
  }

  return { underlyingValue, nearExpiry, expiryDates, rows };
}

// ─── Mock data for testing (market closed / NSE blocked) ──────────
function getMockData(symbol) {
  const strikes = [22000, 22100, 22200, 22300, 22400, 22500, 22600, 22700, 22800, 22900, 23000];
  const rows = [];
  const signals = [
    { signal: 'Long Buildup',   color: 'green',  pc: 1,  oc: 5000  },
    { signal: 'Short Buildup',  color: 'red',    pc: -1, oc: 8000  },
    { signal: 'Short Covering', color: 'blue',   pc: 2,  oc: -3000 },
    { signal: 'Long Unwinding', color: 'orange', pc: -2, oc: -4000 },
    { signal: 'Neutral',        color: 'gray',   pc: 0,  oc: 0     },
  ];

  strikes.forEach((strike, i) => {
    const s = signals[i % signals.length];
    rows.push({ type: 'CE', strike, ltp: 120 + i * 10, oi: 50000 + i * 1000, oiChange: s.oc, volume: 20000, priceChange: s.pc, iv: 14.5, signal: s.signal, color: s.color });
    rows.push({ type: 'PE', strike, ltp: 80 + i * 5,  oi: 40000 + i * 800,  oiChange: -s.oc, volume: 18000, priceChange: -s.pc, iv: 13.2, signal: getSignal(-s.pc, -s.oc).signal, color: getSignal(-s.pc, -s.oc).color });
  });

  return {
    symbol,
    isMock: true,
    mockNote: '⚠️ Mock data — market closed or NSE blocked. Real data available Mon-Fri 9:15AM-3:30PM IST.',
    underlyingValue: 22450,
    nearExpiry: '27-Mar-2026',
    expiryDates: ['27-Mar-2026', '03-Apr-2026', '10-Apr-2026'],
    rows,
    total: rows.length,
  };
}

// ─── Routes ───────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'TradeHub NSE OI Server running ✅', time: new Date().toISOString() });
});

app.get('/myip', async (req, res) => {
  try {
    const r = await axios.get('https://api.ipify.org?format=json');
    res.json({ railwayIP: r.data.ip });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Main OI endpoint — tries NSE, falls back to mock
app.get('/oi', async (req, res) => {
  const symbol = (req.query.symbol || 'NIFTY').toUpperCase();
  const forceMock = req.query.mock === 'true';

  if (forceMock) return res.json(getMockData(symbol));

  try {
    const raw = await fetchNSEWithSession(symbol);
    const analyzed = analyzeOI(raw);

    if (!analyzed.rows.length) {
      // NSE returned empty — market closed or blocked, use mock
      return res.json({ ...getMockData(symbol), nseEmpty: true });
    }

    res.json({ symbol, ...analyzed, total: analyzed.rows.length, isMock: false });
  } catch (err) {
    console.error('NSE fetch error:', err.message);
    // Fallback to mock data so frontend always works
    res.json({ ...getMockData(symbol), nseError: err.message });
  }
});

// ✅ Debug — raw NSE response
app.get('/debug', async (req, res) => {
  const symbol = (req.query.symbol || 'NIFTY').toUpperCase();
  try {
    const raw = await fetchNSEWithSession(symbol);
    res.json({
      success: true,
      expiryDates: raw?.records?.expiryDates,
      underlyingValue: raw?.records?.underlyingValue,
      totalRecords: raw?.records?.data?.length || 0,
      sampleCE: raw?.records?.data?.[0]?.CE,
      samplePE: raw?.records?.data?.[0]?.PE,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`TradeHub NSE OI Server running on port ${PORT}`);
});
