const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// NSE URLs
const NSE_HOME = 'https://www.nseindia.com';
const NSE_INDICES_OC = 'https://www.nseindia.com/api/option-chain-indices?symbol=';
const NSE_EQUITIES_OC = 'https://www.nseindia.com/api/option-chain-equities?symbol=';

// Browser-like headers NSE requires
const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Cache-Control': 'max-age=0',
};

const INDICES = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'];

// Step 1: Get NSE session cookies
async function getNSESession() {
  const session = axios.create({ withCredentials: true });

  // Hit homepage first to get cookies
  const homeRes = await session.get(NSE_HOME, {
    headers: NSE_HEADERS,
    timeout: 10000,
  });

  const cookies = homeRes.headers['set-cookie'];
  if (!cookies) throw new Error('No cookies from NSE homepage');

  const cookieStr = cookies.map(c => c.split(';')[0]).join('; ');

  // Small delay to mimic human browsing
  await new Promise(r => setTimeout(r, 1000));

  return cookieStr;
}

// Step 2: Fetch option chain data
async function fetchOptionChain(symbol) {
  const cookieStr = await getNSESession();
  const isIndex = INDICES.includes(symbol.toUpperCase());
  const url = isIndex
    ? NSE_INDICES_OC + symbol.toUpperCase()
    : NSE_EQUITIES_OC + symbol.toUpperCase();

  const res = await axios.get(url, {
    headers: {
      ...NSE_HEADERS,
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://www.nseindia.com/option-chain',
      'X-Requested-With': 'XMLHttpRequest',
      'Cookie': cookieStr,
    },
    timeout: 15000,
  });

  return res.data;
}

// Step 3: Analyze OI data — calculate signals
function analyzeOI(data) {
  const records = data?.records?.data || [];
  const expiryDates = data?.records?.expiryDates || [];
  const nearExpiry = expiryDates[0];
  const underlyingValue = data?.records?.underlyingValue || 0;

  const result = [];

  for (const record of records) {
    if (record.expiryDate !== nearExpiry) continue;

    const strike = record.strikePrice;
    const ce = record.CE;
    const pe = record.PE;

    if (ce) {
      const priceChange = ce.change || 0;
      const oiChange = ce.changeinOpenInterest || 0;
      result.push({
        type: 'CE',
        strike,
        ltp: ce.lastPrice || 0,
        oi: ce.openInterest || 0,
        oiChange,
        volume: ce.totalTradedVolume || 0,
        priceChange,
        signal: getSignal(priceChange, oiChange),
        color: getColor(priceChange, oiChange),
        iv: ce.impliedVolatility || 0,
      });
    }

    if (pe) {
      const priceChange = pe.change || 0;
      const oiChange = pe.changeinOpenInterest || 0;
      result.push({
        type: 'PE',
        strike,
        ltp: pe.lastPrice || 0,
        oi: pe.openInterest || 0,
        oiChange,
        volume: pe.totalTradedVolume || 0,
        priceChange,
        signal: getSignal(priceChange, oiChange),
        color: getColor(priceChange, oiChange),
        iv: pe.impliedVolatility || 0,
      });
    }
  }

  return { underlyingValue, nearExpiry, expiryDates, rows: result };
}

function getSignal(priceChange, oiChange) {
  if (priceChange > 0 && oiChange > 0) return 'Long Buildup';
  if (priceChange < 0 && oiChange > 0) return 'Short Buildup';
  if (priceChange > 0 && oiChange < 0) return 'Short Covering';
  if (priceChange < 0 && oiChange < 0) return 'Long Unwinding';
  return 'Neutral';
}

function getColor(priceChange, oiChange) {
  if (priceChange > 0 && oiChange > 0) return 'green';
  if (priceChange < 0 && oiChange > 0) return 'red';
  if (priceChange > 0 && oiChange < 0) return 'blue';
  if (priceChange < 0 && oiChange < 0) return 'orange';
  return 'gray';
}

// ✅ Health check
app.get('/', (req, res) => {
  res.json({ status: 'TradeHub NSE OI Server running ✅' });
});

// ✅ Railway IP check
app.get('/myip', async (req, res) => {
  try {
    const r = await axios.get('https://api.ipify.org?format=json');
    res.json({ railwayIP: r.data.ip });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ OI Analysis — main endpoint
app.get('/oi', async (req, res) => {
  const symbol = req.query.symbol || 'NIFTY';
  try {
    const raw = await fetchOptionChain(symbol);
    const analyzed = analyzeOI(raw);
    res.json({ symbol, ...analyzed, total: analyzed.rows.length });
  } catch (err) {
    console.error('OI fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Debug — raw NSE response
app.get('/debug', async (req, res) => {
  const symbol = req.query.symbol || 'NIFTY';
  try {
    const raw = await fetchOptionChain(symbol);
    res.json({
      expiryDates: raw?.records?.expiryDates,
      underlyingValue: raw?.records?.underlyingValue,
      sampleRecord: raw?.records?.data?.[0],
      totalRecords: raw?.records?.data?.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`TradeHub NSE OI Server running on port ${PORT}`);
});
