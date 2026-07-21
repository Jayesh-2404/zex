# Zex Project Notes

## What It Is

Zex is a small exchange-style backend. It has:

- API service for orders, depth, tickers, and klines.
- Matching engine using Redis queue/pubsub.
- Open order cancellation with owner checks.
- Postgres storage for trades and kline tables.

## Services

- `api`: Express API on port `3000`.
- `engine`: In-memory orderbook and trade persistence.
- `redis`: Messaging between API and engine.
- `postgres`: Trade and kline storage.

## Run

```bash
docker compose up -d
cd engine && npm run dev
cd api && npm run dev
```

## Current Status

- Engine builds.
- Orderbook tests pass.
- API builds.

## Next Work

1. Run full API + engine smoke test.
2. Add kline aggregation from persisted trades.
3. Add durable order storage and recovery.

---

## Frontend Plan

### Purpose

A single-page trading interface that consumes the Zex API to display market data and let users place/cancel orders.

### Tech Stack

| Layer        | Choice               |
| ------------ | -------------------- |
| Framework    | React 18 + TypeScript |
| Build        | Vite                 |
| Styling      | Tailwind CSS 4       |
| Charts       | Lightweight Charts (TradingView) |
| HTTP         | fetch (no extra lib) |
| State        | React context + useReducer |

### Routes (React Router)

| Path          | View               |
| ------------- | ------------------ |
| `/`           | Market overview / dashboard |
| `/trade/:symbol` | Trading page (orderbook, chart, order form) |
| `/orders`     | Open orders list with cancel |

### Pages & Components

#### 1. Market Overview (`/`)
- Top bar with available symbols (SOL_USDC, etc.)
- Ticker summary for each market (last price, 24h change)
- Link to trade page per symbol

#### 2. Trading Page (`/trade/:symbol`)
- **Orderbook** (bids / asks side-by-side) — fetched from `GET /depth`
- **Price chart** — klines via `GET /klines`, rendered in Lightweight Charts
- **Order form** — side toggle (buy/sell), price, quantity, submit → `POST /order`
- **Recent trades feed** (filled orders) — SSE or poll fallback
- **Open orders widget** — user scoped, with cancel button → `DELETE /order/:id`

#### 3. Orders Page (`/orders`)
- Table of all open orders for the current user
- Cancel action per row

### Data Flow

```
User action → component → fetch → /api/v1/... → render response
Depth/klines polled every 1–2 s for near-real-time feel (SSE later)
```

### Directory Structure

```
frontend/
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── tailwind.config.ts          # if v3; v4 uses CSS‑first config
└── src/
    ├── main.tsx
    ├── App.tsx
    ├── api/
    │   ├── client.ts            # base fetch wrapper + error handling
    │   ├── orders.ts            # createOrder, cancelOrder
    │   ├── market.ts            # getDepth, getTickers, getKlines
    │   └── types.ts             # shared TypeScript types
    ├── context/
    │   └── UserContext.tsx       # current userId (hardcoded or login stub)
    ├── hooks/
    │   ├── useDepth.ts          # poll GET /depth
    │   ├── useTickers.ts        # poll GET /tickers
    │   └── useKlines.ts         # poll GET /klines
    ├── pages/
    │   ├── Dashboard.tsx
    │   ├── Trade.tsx
    │   └── Orders.tsx
    └── components/
        ├── Orderbook.tsx
        ├── PriceChart.tsx
        ├── OrderForm.tsx
        ├── TickerBar.tsx
        └── OpenOrders.tsx
```

### Future Improvements

- WebSocket / SSE for real-time depth and fills
- Login flow (JWT) instead of hardcoded userId
- Dark theme toggle
- Mobile layout
