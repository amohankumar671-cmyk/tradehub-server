const express = require('express');
const axios = require('axios');
const totp = require('totp-generator');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ✅ Health check
app.get('/', (req, res) => {
  res.json({
    status: 'TradeHub OI Server running',
    env: {
      hasApiKey: !!process.env.ANGEL_API_KEY,
      hasClientId: !!process.env.ANGEL_CLIENT_ID,
      hasPin: !!process.env.ANGEL_PIN,
      hasTotp: !!process.env.ANGEL_TOTP_SECRET,
    }
  });
});

// ✅ NEW: Find Railway's outbound IP
app.get('/myip', async (req, res) => {
  try {
    const response = await axios.get('https://api.ipify.org?format=json');
    res.json({ railwayIP: response.data.ip });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch IP', detail: err.message });
  }
});

// ✅ Angel One Login Helper
async function angelLogin() {
  const apiKey = process.env.ANGEL_API_KEY;
  const clientId = process.env.ANGEL_CLIENT_ID;
  const pin = process.env.ANGEL_PIN;
  const totpSecret = process.env.ANGEL_TOTP_SECRET;

  console.log('Logging in with:', { apiKey: !!apiKey, clientId, pin: !!pin, totpSecret: !!totpSecret });

  const totpToken = totp(totpSecret);

  const loginRes = await axios.post(
    'https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword',
    {
      clientcode: clientId,
      password: pin,
      totp: totpToken,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-UserType': 'USER',
        'X-SourceID': 'WEB',
        'X-ClientLocalIP': '127.0.0.1',
        'X-ClientPublicIP': '127.0.0.1',
        'X-MACAddress': '00:00:00:00:00:00',
        'X-PrivateKey': apiKey,
      }
    }
  );

  if (!loginRes.data.data || !loginRes.data.data.jwtToken) {
    console.error('Login response:', JSON.stringify(loginRes.data));
    throw new Error('Login failed: ' + JSON.stringify(loginRes.data));
  }

  return loginRes.data.data.jwtToken;
}

// ✅ OI Analysis endpoint
app.get('/oi', async (req, res) => {
  const symbol = req.query.symbol || 'NIFTY';

  try {
    const jwtToken = await angelLogin();

    const oiRes = await axios.get(
      `https://apiconnect.angelone.in/rest/secure/angelbroking/marketData/v1/oi-data?name=${symbol}&expiryType=NEAR`,
      {
        headers: {
          'Authorization': `Bearer ${jwtToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-UserType': 'USER',
          'X-SourceID': 'WEB',
          'X-ClientLocalIP': '127.0.0.1',
          'X-ClientPublicIP': '127.0.0.1',
          'X-MACAddress': '00:00:00:00:00:00',
          'X-PrivateKey': process.env.ANGEL_API_KEY,
        }
      }
    );

    const rows = oiRes.data?.data || [];

    // Calculate OI analysis signals
    const analyzed = rows.map(row => {
      const priceChange = row.netChange || 0;
      const oiChange = row.oiChange || 0;

      let signal = '';
      let color = '';

      if (priceChange > 0 && oiChange > 0) {
        signal = 'Long Buildup';
        color = 'green';
      } else if (priceChange < 0 && oiChange > 0) {
        signal = 'Short Buildup';
        color = 'red';
      } else if (priceChange > 0 && oiChange < 0) {
        signal = 'Short Covering';
        color = 'blue';
      } else if (priceChange < 0 && oiChange < 0) {
        signal = 'Long Unwinding';
        color = 'orange';
      } else {
        signal = 'Neutral';
        color = 'gray';
      }

      return { ...row, signal, color };
    });

    res.json({ symbol, rows: analyzed, total: analyzed.length });

  } catch (err) {
    console.error('OI Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`TradeHub OI Server running on port ${PORT}`);
});
