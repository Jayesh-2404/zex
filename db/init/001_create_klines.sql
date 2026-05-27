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
