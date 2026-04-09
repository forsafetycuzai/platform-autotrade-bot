# Crypto AutoTrade Bot

Paper trading and live trading bot with Binance integration.

---

## Quick Start (Paper Trading — no setup needed)

Just open `index.html` directly in your browser.
The chart and strategy builder work without the server.

---

## Live Trading Setup

### 1. Install Node.js
Download from https://nodejs.org (version 18 or higher)

### 2. Install dependencies
```bash
cd cryptobot
npm install
```

### 3. Configure your API keys
```bash
cp .env.example .env
```
Open `.env` and fill in:
```
BINANCE_API_KEY=your_key_here
BINANCE_API_SECRET=your_secret_here
MODE=paper   # change to 'live' when ready
```

### 4. Create API keys on Binance (safely)
1. Go to Binance → Account → API Management
2. Create a new API key
3. **Enable:** Spot Trading only
4. **Restrict to your IP address** (very important)
5. **Do NOT enable:** Withdrawals, Futures, Margin

### 5. Start the server
```bash
npm start
```
You'll see:
```
  Crypto AutoTrade Bot Server
  Running at http://127.0.0.1:3001
  Mode: PAPER
```

### 6. Open the bot
Open `index.html` in your browser (or visit http://127.0.0.1:3001).
The "Server: connected" indicator will turn green.

### 7. Switch to Live Trading
1. Change `MODE=live` in your `.env` file
2. Restart the server (`npm start`)
3. In the bot UI, click **⚡ Live** in the mode bar
4. A red warning banner will appear — this is intentional

---

## Security Notes

- Your API key and secret **never leave your computer**
- All signing happens in `server.js` on your machine
- The server only accepts connections from `localhost`
- The `.env` file is never sent anywhere
- Rate limiting prevents runaway orders (max 30/min)
- If something goes wrong, just stop the server (`Ctrl+C`)

---

## File Structure

```
cryptobot/
├── index.html      ← Main bot UI (open this in browser)
├── server.js       ← Local proxy server (signs Binance requests)
├── package.json    ← Node.js dependencies
├── .env.example    ← Copy to .env and fill in your keys
└── README.md       ← This file
```

---

## Strategy Builder

Click **⚡ Strategy Builder** in the left panel to open the full-page builder.

- Add **Entry (BUY)** conditions using any combination of indicators
- Add **Exit (SELL)** conditions 
- All conditions use AND logic — all must be true simultaneously
- The **Strategy Preview** shows an IF/THEN visual of your strategy
- Hit **Apply Strategy** to activate

Available indicators: Price, Open, High, Low, BB Upper/Mid/Lower,
RSI(14), EMA(9/20/50/200), MACD Line, MACD Signal, Candle Direction,
Previous Close/Open/High/Low.

---

## ⚠️ Disclaimer

This is a personal tool for educational and experimental use.
Crypto trading carries significant financial risk.
Never trade more than you can afford to lose.
