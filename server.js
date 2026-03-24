const express = require("express");
const cors = require("cors");
const axios = require("axios");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

// Values read at RUNTIME only — not at build time
function getConfig() {
  return {
    appId: process.env.FYERS_APP_ID || "UWU4FAV9OW-100",
    secret: process.env.FYERS_SECRET || "CCHIBXXTR7",
    redirectUri: process.env.FYERS_REDIRECT_URI ||
      "https://tradehub-server-production.up.railway.app/callback",
  };
}

let accessToken = null;

// ─── AUTH ─────────────────────────────────────────────────────────────────────

app.get("/auth", (req, res) => {
  const { appId, redirectUri } = getConfig();
  const url = `https://api.fyers.in/api/v3/generate-authcode?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&state=tradehub`;
  res.redirect(url);
});

app.get("/callback", async (req, res) => {
  const authCode = req.query.code;
  if (!authCode) return res.status(400).send("No auth code received.");

  try {
    const { appId, secret } = getConfig();
    const appIdHash = crypto.createHash("sha256").update(`${appId}:${secret}`).digest("hex");

    const response = await axios.post("https://api.fyers.in/api/v3/validate-authcode", {
      grant_type: "authorization_code",
      appIdHash,
      code: authCode,
    });

    if (response.data.s === "ok") {
      accessToken = response.data.access_token;
      console.log("Fyers token obtained");
      res.send(`
        <html><body style="font-family:sans-serif;background:#0d1117;color:#fff;padding:40px;text-align:center">
          <h1 style="color:#00d4aa">Token Generated!</h1>
          <p>Save this as <b>FYERS_ACCESS_TOKEN</b> in Railway Variables:</p>
          <textarea style="width:90%;height:80px;background:#1a1a2e;color:#fff;border:1px solid #444;padding:10px;border-radius:8px">${accessToken}</textarea>
          <br/><br/>
          <a href="https://tradehub-934.pages.dev/oi-analysis" style="background:#8b5cf6;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none">Go to OI Analysis</a>
        </body></html>
      `);
    } else {
      res.status(400).send("Token failed: " + JSON.stringify(response.data));
    }
  } catch (err) {
    res.status(500).send("Error: " + (err.response?.data?.message || err.message));
  }
});

app.get("/token-status", (req, res) => {
  res.json({
    hasToken: !!accessToken,
    message: accessToken ? "Token ready" : "No token — visit /auth",
  });
});

// ─── OI DATA ─────────────────────────────────────────────────────────────────

app.get("/oi", async (req, res) => {
  const symbol = (req.query.symbol || "NIFTY").toUpperCase();
  if (!accessToken) return res.json(getMockData(symbol));

  try {
    const { appId } = getConfig();
    const response = await axios.get(
      `https://api.fyers.in/data-rest/v2/options-chain?symbol=NSE:${symbol}25MARFUT&strikecount=10`,
      { headers: { Authorization: `${appId}:${accessToken}` }, timeout: 10000 }
    );

    if (response.data.s !== "ok") return res.json(getMockData(symbol));

    const rows = [];
    for (const item of response.data.data?.optionsChain || []) {
      if (item.call) rows.push(formatRow(item.strike, "CE", item.call));
      if (item.put) rows.push(formatRow(item.strike, "PE", item.put));
    }

    return res.json({
      symbol,
      underlyingPrice: response.data.data?.ltp || 0,
      timestamp: new Date().toISOString(),
      source: "fyers_live",
      data: rows.sort((a, b) => a.strike - b.strike),
    });
  } catch (err) {
    if (err.response?.status === 401) accessToken = null;
    return res.json(getMockData(symbol));
  }
});

function formatRow(strike, type, opt) {
  const oiChange = (opt.oi || 0) - (opt.prev_oi || opt.oi || 0);
  const priceChange = (opt.ltp || 0) - (opt.prev_close || opt.ltp || 0);
  let signal = "Neutral";
  if (priceChange > 0 && oiChange > 0) signal = "Long Buildup";
  else if (priceChange < 0 && oiChange > 0) signal = "Short Buildup";
  else if (priceChange > 0 && oiChange < 0) signal = "Short Covering";
  else if (priceChange < 0 && oiChange < 0) signal = "Long Unwinding";
  return { strike, type, ltp: opt.ltp || 0, change: parseFloat(priceChange.toFixed(2)), oi: opt.oi || 0, oiChange, volume: opt.vol_traded_today || 0, iv: opt.implied_volatility || 0, signal };
}

function getMockData(symbol) {
  const basePrice = { NIFTY: 22450, BANKNIFTY: 48500, FINNIFTY: 21200, MIDCPNIFTY: 12800 }[symbol] || 22450;
  const strikes = Array.from({ length: 10 }, (_, i) => basePrice - 500 + i * 100);
  const rows = [];
  for (const strike of strikes) {
    for (const type of ["CE", "PE"]) {
      const oiChange = (Math.random() > 0.5 ? 1 : -1) * Math.floor(Math.random() * 8000 + 1000);
      const priceChange = (Math.random() > 0.5 ? 1 : -1) * parseFloat((Math.random() * 3).toFixed(2));
      let signal = "Neutral";
      if (priceChange > 0 && oiChange > 0) signal = "Long Buildup";
      else if (priceChange < 0 && oiChange > 0) signal = "Short Buildup";
      else if (priceChange > 0 && oiChange < 0) signal = "Short Covering";
      else if (priceChange < 0 && oiChange < 0) signal = "Long Unwinding";
      rows.push({ strike, type, ltp: Math.floor(Math.random() * 200 + 60), change: priceChange, oi: Math.floor(Math.random() * 30000 + 20000), oiChange, volume: Math.floor(Math.random() * 20000 + 5000), iv: parseFloat((Math.random() * 5 + 12).toFixed(1)), signal });
    }
  }
  return { symbol, underlyingPrice: basePrice, timestamp: new Date().toISOString(), source: "mock", isMock: true, data: rows.sort((a, b) => a.strike - b.strike) };
}

app.get("/", (req, res) => res.json({
  status: "TradeHub Server Running",
  fyers: accessToken ? "Connected" : "Not connected — visit /auth",
}));

app.get("/myip", async (req, res) => {
  try { const r = await axios.get("https://api.ipify.org?format=json"); res.json(r.data); }
  catch (e) { res.json({ error: "Could not fetch IP" }); }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`TradeHub Server on port ${PORT}`));
