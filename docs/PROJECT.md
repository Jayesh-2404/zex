# Zex Project Notes

Design rationale and known tradeoffs live in [ARCHITECTURE.md](ARCHITECTURE.md).
This file tracks what is built and what comes next.

## What It Is

An exchange-style backend:

- API service for orders, depth, tickers, klines, open orders, and recent trades.
- Separate matching engine consuming serialized commands from a Redis list.
- Owner-checked order cancellation.
- Postgres storage for trades, OHLCV kline aggregation, open-order snapshots, and a command journal.
- Server-Sent Events stream for depth, fills, and per-user open orders.

## Services

- `api`: Express API on port `3000`.
- `engine`: Single-writer in-memory order book plus trade persistence.
- `redis`: Command transport between API and engine.
- `postgres`: Trades, klines, open orders, command journal.

All four run with `docker compose up -d`. See the README.

## Current Status

- Engine and API both typecheck; 50 tests pass (35 engine, 15 API).
- Price and quantity are handled as exact scaled `bigint`, validated on the API
  side against the engine's grammar and held in place by a parity test.
- Order results persist in a single Postgres transaction covering fills, klines,
  the open-order snapshot, and the idempotency journal row.
- Engine restores open orders and 24h ticker stats from Postgres before
  consuming commands.
- Engine replies `ENGINE_ERROR` on a failed command instead of leaving the
  caller to time out; the API surfaces it as a `503`.
- SSE streams are live and the frontend consumes them.

## Backend Resume Story

- Built an exchange-style backend with an Express API, Redis-backed
  request/response messaging, and a separate single-writer matching engine.
- Implemented price-time priority matching with partial fills, owner-checked
  cancellations, order book depth, and ticker statistics.
- Replaced float arithmetic with scaled `bigint` fixed-point math, and made the
  API reject any decimal the engine would silently truncate.
- Persisted trades to Postgres and aggregated fills into `1m`, `1h`, and
  UTC-week OHLCV candles using conflict-safe upserts.
- Committed order results atomically so the in-memory book, its snapshot, and
  the idempotency journal cannot disagree.
- Added durable open-order snapshots and startup recovery so the engine can
  rebuild active books and 24h stats after a restart.
- Added create-order idempotency using client-provided keys, request hashing,
  and response replay from a Postgres command journal.
- Added real-time depth, trade, and open-order streams over SSE.
- Covered matching, cancellation, snapshot/restore, kline bucketing, command
  journal behavior, and cross-process decimal parity with tests.

## Technical Round Discussion Points

- Why the matching engine is isolated from the API and consumes serialized
  commands through a Redis list.
- How the system handles partial fills, maker/taker metadata, and open-order
  cancellation authorization.
- Why the command journal commits in the same transaction as the book mutation,
  and what that does and does not make safe.
- Tradeoffs of an in-memory order book with Postgres snapshots versus a fully
  event-sourced command journal.
- How OHLCV candles are updated from fills and why UTC interval boundaries
  matter for market data.
- How idempotency keys prevent duplicate orders, and where a pending-command
  journal would still be needed.
- The two distinct failure modes in decimal handling: values that throw, and
  values that succeed while being wrong.

## Next Work

Ordered by value for a backend review.

1. **Balance and holdings ledger.** Double-entry in Postgres: reserve on place,
   release on cancel, settle on fill. The natural home is the existing
   `persistOrderResult` transaction, which would make reservation atomic with
   the book mutation for free. This is the largest remaining gap, since orders
   are currently unconstrained by funds.
2. **Seed script** so the stack demos a populated book without manual curl.
3. **API integration tests** with supertest. The API layer is the least-covered
   part of the codebase.
4. **Pending-command journal** to close the crash window between book mutation
   and its write.
5. **Authentication.** `userId` is currently caller-supplied.

## Deferred Frontend Plan

Superseded in part: the frontend now exists as a working single-page client
(`frontend/`) that consumes the SSE stream, and the API already exposes
`/orders/open` and `/trades/recent`, which this plan originally listed as
missing. The plan below is retained for the multi-page structure, which is
deliberately lower priority than the backend work above.

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
