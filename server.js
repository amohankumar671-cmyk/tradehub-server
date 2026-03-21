const express = require('express');
const cors = require('cors');
const { SmartAPI } = require('smartapi-javascript');
const speakeasy = require('speakeasy');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// OI Interpretation
function interpretOI(ltpChange, oiChange) {
  if (ltpChange > 0 && oiChange > 0) return { label: 'Long Build Up', arrow: '↑' };
  if (ltpChange < 0 && oiChange > 0) return { label: 'Short Build Up', arrow: '↓' };
  if (ltpChange > 0 && oiChange < 0) return { label: 'Short Covering', arrow: '↑' };
  if (ltpChange < 0 && oiChange < 0) return { label: 'Long Unwinding', arrow: '↓' };
  return { label: 'Neutral', arrow: '-' };
}

// Login to Angel One
async function getAngelSession() {
  const smart = new SmartAPI({
    api_key: process.env.ANGEL_API_KEY,
  });

  const totp = speakeasy.totp({
    secret: process.env.ANGEL_TOTP_SECRET,
    encoding: 'base32',
  });

  const session = await smart.generateSession(
    process.env.ANGEL_CLIENT_ID,
    process.env.ANGEL_PIN,
    totp
  );

  if (!session.status) {
    throw new Error(`Login failed: ${session.message}`);
  }

  return smart;
}

// Symbol to token mapping
const SYMBOL_TOKENS = {
  'NIFTY':      '26000',
  'BANKNIFTY':  '26009',
  'FINNIFTY':   '26037',
  'MIDCPNIFTY': '26074',
  'RELIANCE':   '2885',
  'TCS':        '11536',
  'INFY':       '1594',
  'HDFCBANK':   '1333',
  'ICICIBANK':  '4963',
  'SBIN':       '3045',
  'TATAMOTORS': '3456',
  'WIPRO':      '3787',
  'AXISBANK':   '5900',
  'BAJFINANCE': '317',
  'MARUTI':     '10999',
  'LT':         '11483',
};

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'TradeHub OI Server running', time: new Date().toISOString() });
});

// OI Analysis endpoint
app.get('/oi', async (req, res) => {
  const symbol = (req.query.symbol || 'NIFTY').toUpperCase();

  if (!SYMBOL_TOKENS[symbol]) {
    return res.status(400).json({
      error: 'Symbol not supported',
      allowed: Object.keys(SYMBOL_TOKENS)
    });
  }

  try {
    const smart = await getAngelSession();

    // Search for futures contracts
    const searchResult = await smart.searchScrip('NFO', symbol);

    if (!searchResult.status) {
      throw new Error(`Search failed: ${searchResult.message}`);
    }

    // Filter futures only
    const futures = (searchResult.data || [])
      .filter(item => item.instrumenttype === 'FUTSTK' || item.instrumenttype === 'FUTIDX')
      .slice(0, 4);

    if (futures.length === 0) {
      return res.json({
        symbol,
        spotPrice: 0,
        timestamp: new Date().toISOString(),
        rows: [],
        message: 'No futures data found. Market may be closed.'
      });
    }

    // Get quotes for futures + spot
    const quoteResult = await smart.getMarketData({
      mode: 'FULL',
      exchangeTokens: {
        NFO: futures.map(f => f.symboltoken),
        NSE: [SYMBOL_TOKENS[symbol]],
      }
    });

    if (!quoteResult.status) {
      throw new Error(`Quote failed: ${quoteResult.message}`);
    }

    // Spot price
    const spotData = (quoteResult.data?.fetched || []).find(q => q.exchange === 'NSE');
    const spotPrice = parseFloat(spotData?.ltp) || 0;

    // Process futures
    const rows = [];
    const nfoQuotes = (quoteResult.data?.fetched || []).filter(q => q.exchange === 'NFO');

    for (const quote of nfoQuotes) {
      const futInfo = futures.find(f => f.symboltoken === quote.symboltoken);
      if (!futInfo) continue;

      const ltp = parseFloat(quote.ltp) || 0;
      const close = parseFloat(quote.close) || ltp;
      const ltpChange = parseFloat(quote.netChange) || (ltp - close);
      const ltpChangePct = close ? ((ltpChange / close) * 100) : 0;
      const oi = parseInt(quote.opnInterest) || 0;
      const oiChange = parseInt(quote.oiChange) || 0;
      const volume = parseInt(quote.tradedVolume) || 0;

      rows.push({
        expiry: futInfo.expiry || '-',
        symbol: futInfo.tradingsymbol || symbol,
        ltp,
        ltpChange: ltpChange.toFixed(2),
        ltpChangePct: ltpChangePct.toFixed(2),
        openInterest: oi.toLocaleString('en-IN'),
        oiChange: (oiChange >= 0 ? '+' : '') + oiChange.toLocaleString('en-IN'),
        volume: volume.toLocaleString('en-IN'),
        interpretation: interpretOI(ltpChange, oiChange),
      });
    }

    res.json({
      symbol,
      spotPrice,
      timestamp: new Date().toISOString(),
      rows,
      source: 'Angel One SmartAPI'
    });

  } catch (error) {
    console.error('OI Error:', error.message);
    res.status(500).json({
      error: error.message,
      symbol,
      timestamp: new Date().toISOString()
    });
  }
});

app.listen(PORT, () => {
  console.log(`TradeHub OI Server running on port ${PORT}`);
});
