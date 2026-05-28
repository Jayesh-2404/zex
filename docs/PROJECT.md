# Zex Project Notes

## What It Is

Zex is a small exchange-style backend. It has:

- API service for orders, depth, tickers, and klines.
- Matching engine using Redis queue/pubsub.
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
- API needs `@types/express` before TypeScript build passes.

## Next Work

1. Add missing API type dependency.
2. Run full API + engine smoke test.
3. Add kline aggregation from persisted trades.
