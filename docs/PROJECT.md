# Zex Project Notes

## What It Is

Zex is a small exchange-style backend. It has:

- API service for orders, depth, tickers, and klines.
- Matching engine using Redis queue/pubsub.
- Open order cancellation with owner checks.
- Postgres storage for trades and live OHLCV kline aggregation.
- Durable open-order snapshots and startup recovery.
- Create-order idempotency keys backed by a Postgres command journal.

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
- Orderbook and persistence tests pass.
- API builds.
- Persisted fills are rolled into `1m`, `1h`, and UTC-week candles for the kline API.
- Engine startup restores open orders from Postgres before consuming new Redis commands.
- Duplicate create-order retries with the same `Idempotency-Key` replay the original response; conflicting reuse returns `409`.

## Next Work

1. Run full API + engine smoke test.
2. Add WebSocket or Server-Sent Events streams for depth, trades, and user order updates.
3. Tighten the command journal into a full pending/completed lifecycle for crash recovery between in-memory book mutation and journal write.

## Backend Resume Story

- Built an exchange-style backend with an Express API, Redis-backed request/response messaging, and a separate matching engine.
- Implemented price-time priority matching with partial fills, owner-checked cancellations, order book depth, and ticker statistics.
- Persisted trades to Postgres and aggregated fills into `1m`, `1h`, and UTC-week OHLCV candles using conflict-safe upserts.
- Added durable open-order snapshots and startup recovery so the in-memory engine can rebuild active books after restart.
- Added create-order idempotency using client-provided keys, request hashing, and response replay from a Postgres command journal.
- Covered matching, cancellation, snapshot/restore, kline bucketing, and command journal behavior with Node test runner tests.

## Technical Round Discussion Points

- Why the matching engine is isolated from the API and consumes serialized commands through Redis.
- How the system handles partial fills, maker/taker metadata, and open-order cancellation authorization.
- Tradeoffs of an in-memory order book with Postgres snapshots versus a fully event-sourced command journal.
- How OHLCV candles are updated from fills and why UTC interval boundaries matter for market data.
- How idempotency keys prevent duplicate orders on client/API retries, and where pending-command recovery would be needed for crash windows.
- Failure modes still worth solving: Redis delivery guarantees, snapshot consistency, pending command recovery, and real-time market streams.

---

## Deferred Frontend Plan

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
