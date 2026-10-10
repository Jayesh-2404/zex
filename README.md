# Zex

A simulated stock-exchange backend: an Express API, a separate TypeScript price-time matching engine, Redis for command transport, and Postgres for virtual balances, trades, klines, open orders, and idempotency persistence.

- Architecture and design decisions: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Project status and next work: [docs/PROJECT.md](docs/PROJECT.md)

## Quick start

Everything, including the API and engine, with one command:

```bash
docker compose up -d
curl http://localhost:3000/api/v1/health
```

The initial Postgres volume is seeded with virtual USD, ACME shares, and a
small ACME_USD order book. To replay the demo seed from scratch, run
`docker compose down -v` and start the stack again.

`/health` reports Redis and Postgres reachability. The engine restores open
orders and 24h ticker stats from Postgres before it starts consuming commands,
so it is safe to restart at any time.

To run the services outside Docker:

```bash
docker compose up -d redis postgres
npm --prefix engine install && npm --prefix engine run dev
npm --prefix api install && npm --prefix api run dev
```

The API listens on `http://localhost:3000`. Postgres is initialised from
`db/init` when the volume is first created; `docker compose down -v` resets it.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/test` | Liveness probe |
| GET | `/api/v1/health` | Redis and Postgres connectivity |
| POST | `/api/v1/order` | Create a limit order |
| DELETE | `/api/v1/order/:orderId` | Cancel an open order |
| GET | `/api/v1/depth?symbol=ACME_USD` | Aggregated book depth |
| GET | `/api/v1/tickers` | 24h stats per market |
| GET | `/api/v1/klines?market=ACME_USD&interval=1m&startTime=0&endTime=9999999999` | OHLCV candles |
| GET | `/api/v1/orders/open?market=ACME_USD&userId=user-1` | A user's open orders |
| GET | `/api/v1/balances?userId=user-1` | Virtual cash and share balances |
| GET | `/api/v1/trades/recent?market=ACME_USD&limit=25` | Recent fills |
| GET | `/api/v1/stream` | Server-Sent Events: `depth`, `trade`, `openOrders` |

## Money handling

Price and quantity are decimal strings, never floats. The API validates them
against the engine's grammar and rejects anything the engine would truncate
past 8 decimal places; the engine scales them to `bigint` and compares
exactly. `api/src/validation/decimal.engine-parity.test.ts` holds both sides of
that contract in place.

## Idempotency

Send an `Idempotency-Key` header on order creation. Retrying with the same key
replays the original response; reusing it for a different request returns `409`.
The journal row commits in the same transaction as the book mutation, so a retry
after a crash cannot place a second order.

```bash
curl -X POST http://localhost:3000/api/v1/order \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-user-1-0001" \
  -d '{"market":"ACME_USD","price":"10","quantity":"1","side":"buy","userId":"user-1"}'
```

## Tests

```bash
npm --prefix engine test
npm --prefix api test
```

## Known limitations

There is no authentication, so `userId` is caller-supplied. Balances are
fictional paper-trading cash and shares, not real money or brokerage assets.
The project does not implement market orders, auctions, corporate actions, or
live market data; these are deliberate scope choices for a matching-engine
demonstration. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the reasoning and the
tradeoffs they leave open.
