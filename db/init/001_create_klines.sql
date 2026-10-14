CREATE TABLE IF NOT EXISTS klines_1m (
  market TEXT NOT NULL,
  bucket TIMESTAMPTZ NOT NULL,
  start TIMESTAMPTZ NOT NULL,
  open NUMERIC NOT NULL,
  high NUMERIC NOT NULL,
  low NUMERIC NOT NULL,
  close NUMERIC NOT NULL,
  volume NUMERIC NOT NULL DEFAULT 0,
  quote_volume NUMERIC NOT NULL DEFAULT 0,
  trades INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (market, bucket)
);

CREATE TABLE IF NOT EXISTS klines_1h (
  market TEXT NOT NULL,
  bucket TIMESTAMPTZ NOT NULL,
  start TIMESTAMPTZ NOT NULL,
  open NUMERIC NOT NULL,
  high NUMERIC NOT NULL,
  low NUMERIC NOT NULL,
  close NUMERIC NOT NULL,
  volume NUMERIC NOT NULL DEFAULT 0,
  quote_volume NUMERIC NOT NULL DEFAULT 0,
  trades INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (market, bucket)
);

CREATE TABLE IF NOT EXISTS klines_1w (
  market TEXT NOT NULL,
  bucket TIMESTAMPTZ NOT NULL,
  start TIMESTAMPTZ NOT NULL,
  open NUMERIC NOT NULL,
  high NUMERIC NOT NULL,
  low NUMERIC NOT NULL,
  close NUMERIC NOT NULL,
  volume NUMERIC NOT NULL DEFAULT 0,
  quote_volume NUMERIC NOT NULL DEFAULT 0,
  trades INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (market, bucket)
);

CREATE TABLE IF NOT EXISTS trades (
  id BIGSERIAL PRIMARY KEY,
  market TEXT NOT NULL,
  price NUMERIC NOT NULL,
  quantity NUMERIC NOT NULL,
  maker_order_id TEXT NOT NULL,
  taker_order_id TEXT NOT NULL,
  maker_user_id TEXT NOT NULL,
  taker_user_id TEXT NOT NULL,
  taker_side TEXT NOT NULL CHECK (taker_side IN ('buy', 'sell')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS trades_market_created_at_idx
  ON trades (market, created_at DESC);

CREATE TABLE IF NOT EXISTS open_orders (
  market TEXT NOT NULL,
  id TEXT NOT NULL,
  price NUMERIC NOT NULL,
  quantity NUMERIC NOT NULL,
  filled NUMERIC NOT NULL DEFAULT 0,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  user_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (market, id)
);

CREATE INDEX IF NOT EXISTS open_orders_market_side_price_idx
  ON open_orders (market, side, price);

CREATE TABLE IF NOT EXISTS command_journal (
  idempotency_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  command_type TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (idempotency_key, user_id, command_type)
);

CREATE INDEX IF NOT EXISTS command_journal_user_created_at_idx
  ON command_journal (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS balances (
  user_id TEXT NOT NULL,
  asset TEXT NOT NULL,
  available NUMERIC NOT NULL DEFAULT 0,
  locked NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, asset),
  CHECK (available >= 0),
  CHECK (locked >= 0)
);

CREATE TABLE IF NOT EXISTS balance_ledger (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  asset TEXT NOT NULL,
  available_delta NUMERIC NOT NULL,
  locked_delta NUMERIC NOT NULL,
  reason TEXT NOT NULL,
  order_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO balances (user_id, asset, available)
VALUES
  ('user-1', 'USD', 100000),
  ('user-1', 'ACME', 1000),
  ('user-2', 'USD', 100000),
  ('user-2', 'ACME', 1000)
ON CONFLICT (user_id, asset) DO NOTHING;

INSERT INTO balances (user_id, asset, available, locked)
VALUES
  ('user-1', 'USD', 99900, 100),
  ('user-2', 'ACME', 990, 10)
ON CONFLICT (user_id, asset) DO UPDATE
SET available = EXCLUDED.available, locked = EXCLUDED.locked;

INSERT INTO open_orders (market, id, price, quantity, filled, side, user_id, position)
VALUES
  ('ACME_USD', 'demo-buy-1', 10, 10, 0, 'buy', 'user-1', 0),
  ('ACME_USD', 'demo-sell-1', 12, 10, 0, 'sell', 'user-2', 0)
ON CONFLICT (market, id) DO NOTHING;

-- Demo market history so first paint shows recent trades, a 1m candle, and
-- 24h ticker stats (the engine restores tickers from trades < 24h old).
-- Both fills land in the same minute bucket as the candle below.
-- Runs once on fresh-volume init; no conflict handling needed.
INSERT INTO trades (market, price, quantity, maker_order_id, taker_order_id, maker_user_id, taker_user_id, taker_side, created_at)
VALUES
  ('ACME_USD', 11, 2, 'demo-trade-sell-1', 'demo-trade-buy-1', 'user-2', 'user-1', 'buy', date_trunc('minute', NOW() - INTERVAL '5 minutes') + INTERVAL '10 seconds'),
  ('ACME_USD', 11, 1, 'demo-trade-sell-2', 'demo-trade-buy-2', 'user-2', 'user-1', 'buy', date_trunc('minute', NOW() - INTERVAL '5 minutes') + INTERVAL '40 seconds');

INSERT INTO klines_1m (market, bucket, start, open, high, low, close, volume, quote_volume, trades)
VALUES
  ('ACME_USD', date_trunc('minute', NOW() - INTERVAL '5 minutes'), date_trunc('minute', NOW() - INTERVAL '5 minutes'), 11, 11, 11, 11, 3, 33, 2);
