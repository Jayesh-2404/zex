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
