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
