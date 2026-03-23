const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const FYERS_APP_ID = process.env.FYERS_APP_ID || "UWU4FAV9OW-100";
const FYERS_SECRET = process.env.FYERS_SECRET || "CCHIBXXTR7";
const FYERS_REDIRECT_URI =
  process.env.FYERS_REDIRECT_URI ||
  "https://tradehub-server-production.up.railway.app/callback";

// Token stored in memory (refreshed daily)
let accessToken = process.env.FYERS_ACCESS_TOKEN || null;

// ─── SYMBOL MAP ───────────────────────────────────────────────────────────────
const EXPIRY = {
  NIFTY: "27MAR25",
  BANKNIFTY: "26MAR25",
  FINNIFTY: "25MAR25",
  MIDCPNIFTY: "24MAR25",
};

function getFyersSymbol(underlying, strike, type) {
  const expiry = EXPIRY[underlying] || "27MAR25";
  return `NSE:${underlying}${expiry}${strike}${type}`;
}

// ─── AUTH ROUTES ──────────────────────────────────────────────────────────────

// Step 1: Redirect user to Fyers login
app.get("/auth", (req, res) => {
  const url = `https://api.fyers.in/api/v3/generate-authcode?client_id=${FYERS_APP_ID}&redirect_uri=${encodeURIComponent(
    FYERS_REDIRECT_URI
  )}&response_type=code&state=tradehub`;
  res.redirect(url);
});

// Step 2: Fyers redirects here with ?code=
app.get("/callback", async (req, res) => {
  const authCode = req.query.code;
  if (!authCode) {
    return res.status(400).send("No auth code received from Fyers.");
  }

  try {
    // Exchange auth code for access token
    const crypto = require("crypto");
    const appIdHash = crypto
      .createHash("sha256")
      .update(`${FYERS_APP_ID}:${FYERS_SECRET}`)
      .digest("hex");

    const response = await axios.post(
      "https://api.fyers.in/api/v3/validate-authcode",
      {
        grant_type: "authorization_code",
        appIdHash,
        code: authCode,
      }
    );

    if (response.data.s === "ok") {
      accessToken = response.data.access_token;
      console.log("✅ Fyers Access Token obtained:", accessToken.slice(0, 20) + "...");
      res.send(`
        <html><body style="font-family:sans-serif;background:#0d1117;color:#fff;padding:40px;text-align:center">
          <h1 style="color:#00d4aa">✅ Fyers Token Generated!</h1>
          <p>Access token saved. Your TradeHub server will now fetch real OI data.</p>
          <p style="color:#888;font-size:12px">Token (first 30 chars): ${accessToken.slice(0, 30)}...</p>
          <p>⚠️ Copy the full token below and set it as <b>FYERS_ACCESS_TOKEN</b> env variable in Railway so it persists after restart:</p>
          <textarea style="width:90%;height:100px;background:#1a1a2e;color:#fff;border:1px solid #333;padding:10px;border-radius:8px">${accessToken}</textarea>
          <br/><br/>
          <a href="https://tradehub-934.pages.dev/oi-analysis" style="color:#8b5cf6">→ Go to OI Analysis</a>
        </body></html>
      `);
    } else {
      res.status(400).send("Token generation failed: " + JSON.stringify(response.data));
    }
  } catch (err) {
    console.error("Fyers token error:", err.response?.data || err.message);
    res.status(500).send("Error: " + (err.response?.data?.message || err.message));
  }
});

// Show current token status
app.get("/token-status", (req, res) => {
  res.json({
    hasToken: !!accessToken,
    tokenPreview: accessToken ? accessToken.slice(0, 20) + "..." : null,
    message: accessToken ? "Token ready — fetching real data" : "No token — visit /auth to login with Fyers",
  });
});

// ─── OI DATA ROUTE ────────────────────────────────────────────────────────────

app.get("/oi", async (req, res) => {
  const symbol = (req.query.symbol || "NIFTY").toUpperCase();

  if (!accessToken) {
    // Return mock data with helpful message
    console.log("No access token — returning mock data");
    return res.json(getMockData(symbol));
  }

  try {
    // Fetch option chain from Fyers
    const response = await axios.get(
      `https://api.fyers.in/data-rest/v2/options-chain?symbol=NSE:${symbol}25MARFUT&strikecount=10`,
      {
        headers: {
          Authorization: `${FYERS_APP_ID}:${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (response.data.s !== "ok") {
      console.error("Fyers API error:", response.data);
      return res.json(getMockData(symbol));
    }

    // Parse Fyers option chain response
    const optionsData = response.data.data?.optionsChain || [];
    const underlyingPrice = response.data.data?.ltp || 0;

    const rows = [];
    for (const item of optionsData) {
      if (item.call) {
        rows.push(formatRow(item.strike, "CE", item.call));
      }
      if (item.put) {
        rows.push(formatRow(item.strike, "PE", item.put));
      }
    }

    rows.sort((a, b) => a.strike - b.strike);

    return res.json({
      symbol,
      underlyingPrice,
      timestamp: new Date().toISOString(),
      source: "fyers_live",
      data: rows,
    });
  } catch (err) {
    console.error("Fyers fetch error:", err.response?.data || err.message);

    // If token expired (401), clear it
    if (err.response?.status === 401) {
      console.log("Token expired — clearing. Visit /auth to re-login.");
      accessToken = null;
    }

    return res.json(getMockData(symbol));
  }
});

function formatRow(strike, type, opt) {
  const oiChange = opt.oi - (opt.prev_oi || opt.oi);
  const priceChange = opt.ltp - (opt.prev_close || opt.ltp);

  // OI Signal logic
  let signal = "Neutral";
  if (priceChange > 0 && oiChange > 0) signal = "Long Buildup";
  else if (priceChange < 0 && oiChange > 0) signal = "Short Buildup";
  else if (priceChange > 0 && oiChange < 0) signal = "Short Covering";
  else if (priceChange < 0 && oiChange < 0) signal = "Long Unwinding";

  return {
    strike,
    type,
    ltp: opt.ltp || 0,
    change: parseFloat(priceChange.toFixed(2)),
    oi: opt.oi || 0,
    oiChange,
    volume: opt.vol_traded_today || 0,
    iv: opt.implied_volatility || 0,
    signal,
  };
}

// ─── MOCK DATA ────────────────────────────────────────────────────────────────
function getMockData(symbol) {
  const basePrice = { NIFTY: 22450, BANKNIFTY: 48500, FINNIFTY: 21200, MIDCPNIFTY: 12800 }[symbol] || 22450;
  const strikes = Array.from({ length: 10 }, (_, i) => basePrice - 250 + i * 100);
  const signals = ["Long Buildup", "Short Buildup", "Short Covering", "Long Unwinding", "Neutral"];
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

      rows.push({
        strike,
        type,
        ltp: type === "CE" ? Math.floor(Math.random() * 200 + 80) : Math.floor(Math.random() * 120 + 60),
        change: priceChange,
        oi: Math.floor(Math.random() * 30000 + 20000),
        oiChange,
        volume: Math.floor(Math.random() * 20000 + 5000),
        iv: parseFloat((Math.random() * 5 + 12).toFixed(1)),
        signal,
      });
    }
  }

  return {
    symbol,
    underlyingPrice: basePrice,
    timestamp: new Date().toISOString(),
    source: "mock",
    isMock: true,
    message: "No Fyers token. Visit /auth to connect Fyers and get real data.",
    data: rows.sort((a, b) => a.strike - b.strike),
  };
}

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "TradeHub Server Running",
    fyers: accessToken ? "✅ Connected" : "❌ Not connected — visit /auth",
    endpoints: ["/auth", "/callback", "/token-status", "/oi?symbol=NIFTY"],
  });
});

app.get("/myip", async (req, res) => {
  const r = await axios.get("https://api.ipify.org?format=json");
  res.json(r.data);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🚀 TradeHub Server running on port ${PORT}`);
  console.log(`📊 Fyers App ID: ${FYERS_APP_ID}`);
  console.log(accessToken ? `✅ Token loaded from env` : `⚠️  No token — visit /auth to login with Fyers`);
  console.log(`\nEndpoints:`);
  console.log(`  GET /auth          → Login with Fyers`);
  console.log(`  GET /callback      → Fyers redirects here`);
  console.log(`  GET /token-status  → Check token`);
  console.log(`  GET /oi?symbol=NIFTY → Get OI data\n`);
});
