# Zex

Backend API for a small exchange-style service. It exposes order, depth, ticker, and kline endpoints and uses Redis for engine messaging plus Postgres for kline storage.

See [docs/PROJECT.md](docs/PROJECT.md) for short project notes and next work.

## Setup

Start Redis and Postgres:

```bash
docker compose up -d
```

Run the API:

```bash
cd api
npm install
npm run dev
```

The API runs on `http://localhost:3000`.

## Endpoints

- `GET /api/v1/test`
- `POST /api/v1/order`
- `GET /api/v1/depth?symbol=SOL_USDC`
- `GET /api/v1/tickers`
- `GET /api/v1/klines?market=SOL_USDC&interval=1m&startTime=0&endTime=9999999999`

Postgres tables are initialized from `db/init` when the database volume is first created.
