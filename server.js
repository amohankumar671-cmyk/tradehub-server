const express = require("express");
const cors = require("cors");
const axios = require("axios");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

function cfg() {
  return {
    appId: "UWU4FAV9OW-100",
    secret: "CCHIBXXTR7",
    redirectUri: "https://tradehub-server-production.up.railway.app/callback",
  };
}

let accessToken = null;

// ─── AUTH ─────────────────────────────────────────────────────────────────────

app.get("/auth", (req, res) => {
  const { appId, redirectUri } = cfg();
  const url =
    `https://api-t1.fyers.in/api/v3/generate-authcode` +
    `?client_id=${appId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&state=tradehub`;
  console.log("Redirecting to Fyers:", url);
  res.redirect(url);
});

app.get("/callback", async (req, res) => {
  console.log("Callback params:", JSON.stringify(req.query));

  const authCode = req.query.auth_code || req.query.code;
  const status = req.query.s;

  if (!authCode || status === "error") {
    return res.status(400).send(`
      <html><body style="background:#0d1117;color:#ff4444;font-family:sans-serif;padding:40px">
        <h2>Auth Failed</h2><p>Params: ${JSON.stringify(req.query)}</p>
        <a href="/auth" style="color:#8b5cf6">Try again</a>
      </body></html>`);
  }

  try {
    const { appId, secret } = cfg();
    const appIdHash = crypto.createHash("sha256").update(`${appId}:${secret}`).digest("hex");

    console.log("Exchanging code for token...");

    const response = await axios.post(
      "https://api-t1.fyers.in/api/v3/validate-authcode",
      { grant_type: "authorization_code", appIdHash, code: authCode },
      { headers: { "Content-Type": "application/json" }, timeout: 15000 }
    );

    console.log("Fyers response:", JSON.stringify(response.data));

    if (response.data.s === "ok" && response.data.access_token) {
      accessToken = response.data.access_token;
      console.log("Token obtained!");

      return res.send(`
        <html><body style="font-family:sans-serif;background:#0d1117;color:#fff;padding:40px;text-align:center">
          <h1 style="color:#00d4aa">Fyers Connected!</h1>
          <p>Real OI data is now active.</p>
          <p style="color:#aaa;margin-top:20px">Save as <b>FYERS_ACCESS_TOKEN</b> in Railway Variables to persist across restarts:</p>
          <textarea style="width:90%;height:80px;background:#1a1a2e;color:#fff;border:1px solid #444;padding:10px;border-radius:8px;margin-top:8px;font-size:11px">${accessToken}</textarea>
          <br/><br/>
          <a href="https://tradehub-934.pages.dev/oi-analysis"
             style="background:#8b5cf6;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold">
            Open OI Analysis
          </a>
        </body></html>`);
    } else {
      return res.status(400).send(`
        <html><body style="background:#0d1117;color:#ff4444;font-family:sans-serif;padding:40px">
          <h2>Token Exchange Failed</h2>
          <pre>${JSON.stringify(response.data, null, 2)}</pre>
          <a href="/auth" style="color:#8b5cf6">Try again</a>
        </body></html>`);
    }
  } catch (err) {
    const errData = err.response?.data || err.message;
    console.error("Error:", errData);
    return res.status(500).send(`
      <html><body style="background:#0d1117;color:#ff4444;font-family:sans-serif;padding:40px">
        <h2>Error</h2>
        <pre>${JSON.stringify(errData, null, 2)}</pre>
        <p>Auth code may have expired (they last only seconds).</p>
        <a href="/auth" style="color:#8b5cf6">Try again immediately after Fyers login</a>
      </body></html>`);
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
    const { appId } = cfg();
    const response = await axios.get(
      `https://api-t1.fyers.in/data-rest/v2/options-chain?symbol=NSE:${symbol}25MARFUT&strikecount=10`,
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
  const rows = [];
  for (let i = 0; i < 10; i++) {
    const strike = basePrice - 500 + i * 100;
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
