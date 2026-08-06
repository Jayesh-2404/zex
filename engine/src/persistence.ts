import { Client } from "pg";
import { Fill, Order } from "./orderbook.js";

type OrderSide = "buy" | "sell";

export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows?: unknown[] }>;
}

export interface PersistenceClient extends Queryable {
  connect(): Promise<unknown>;
}

export interface KlineEntry {
  tableName: "klines_1m" | "klines_1h" | "klines_1w";
  market: string;
  bucket: Date;
  price: string;
  quantity: string;
  quoteVolume: string;
}

export interface StoredOpenOrder extends Order {
  market: string;
}

export type CommandJournalResult =
  | { status: "miss" }
  | { status: "hit"; response: object }
  | { status: "conflict" };

interface CommandJournalRow {
  request_hash: string;
  response: object;
}

interface OpenOrderRow {
  market: string;
  id: string;
  price: string;
  quantity: string;
  filled: string;
  side: "buy" | "sell";
  user_id: string;
}

const KLINE_INTERVALS: { tableName: KlineEntry["tableName"]; getBucket: (date: Date) => Date }[] = [
  { tableName: "klines_1m", getBucket: (date) => getBucketStart(date, 60 * 1000) },
  { tableName: "klines_1h", getBucket: (date) => getBucketStart(date, 60 * 60 * 1000) },
  { tableName: "klines_1w", getBucket: getUtcWeekStart },
];

export function getBucketStart(date: Date, bucketMs: number): Date {
  return new Date(Math.floor(date.getTime() / bucketMs) * bucketMs);
}

export function getUtcWeekStart(date: Date): Date {
  const bucket = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const daysSinceMonday = (bucket.getUTCDay() + 6) % 7;
  bucket.setUTCDate(bucket.getUTCDate() - daysSinceMonday);
  return bucket;
}

export function buildKlineEntries(market: string, fill: Fill, createdAt: Date): KlineEntry[] {
  const price = Number(fill.price);
  const quantity = Number(fill.quantity);

  if (!Number.isFinite(price) || !Number.isFinite(quantity) || quantity <= 0) {
    return [];
  }

  return KLINE_INTERVALS.map(({ tableName, getBucket }) => ({
    tableName,
    market,
    bucket: getBucket(createdAt),
    price: fill.price,
    quantity: fill.quantity,
    quoteVolume: (price * quantity).toString(),
  }));
}

export class TradeStore {
  private client: PersistenceClient;
  private ready = false;

  constructor(client?: PersistenceClient) {
    this.client =
      client ??
      new Client({
        user: process.env.POSTGRES_USER ?? "cex",
        host: process.env.POSTGRES_HOST ?? "localhost",
        database: process.env.POSTGRES_DB ?? "cex",
        password: process.env.POSTGRES_PASSWORD ?? "cex",
        port: Number(process.env.POSTGRES_PORT ?? 5432),
      });
  }

  async connect(): Promise<void> {
    try {
      await this.client.connect();
      await this.createSchema();
      this.ready = true;
      console.log("Engine connected to Postgres");
    } catch (error) {
      console.warn("Trade persistence disabled; Postgres connection failed", error);
    }
  }

  async close(): Promise<void> {
    const end = (this.client as { end?: () => Promise<unknown> }).end;
    if (!end) {
      return;
    }
    try {
      await end.call(this.client);
    } catch (error) {
      console.error("Failed to close Postgres connection", error);
    }
  }

  async saveFills(market: string, takerSide: OrderSide, fills: Fill[]): Promise<void> {
    if (!this.ready || fills.length === 0) {
      return;
    }

    for (const fill of fills) {
      try {
        const createdAt = new Date();
        await this.insertTrade(market, takerSide, fill, createdAt);
        await this.upsertKlines(market, fill, createdAt);
      } catch (error) {
        console.error("Failed to persist trade", error);
      }
    }
  }

  async loadOpenOrders(): Promise<StoredOpenOrder[]> {
    if (!this.ready) {
      return [];
    }

    try {
      const result = await this.client.query(`
        SELECT market, id, price::text, quantity::text, filled::text, side, user_id
        FROM open_orders
        ORDER BY market ASC, position ASC
      `);
      return (result.rows ?? []).map((row) => {
        const order = row as OpenOrderRow;
        return {
          market: order.market,
          id: order.id,
          price: order.price,
          quantity: order.quantity,
          filled: order.filled,
          side: order.side,
          userId: order.user_id,
        };
      });
    } catch (error) {
      console.error("Failed to load open orders", error);
      return [];
    }
  }

  async saveOpenOrdersSnapshot(market: string, orders: Order[]): Promise<void> {
    if (!this.ready) {
      return;
    }

    try {
      await this.client.query("BEGIN");
      await this.client.query("DELETE FROM open_orders WHERE market = $1", [market]);

      for (const [position, order] of orders.entries()) {
        await this.client.query(
          `
            INSERT INTO open_orders (
              market, id, price, quantity, filled, side, user_id, position, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
          `,
          [market, order.id, order.price, order.quantity, order.filled, order.side, order.userId, position],
        );
      }

      await this.client.query("COMMIT");
    } catch (error) {
      await this.client.query("ROLLBACK").catch(() => undefined);
      console.error("Failed to persist open order snapshot", error);
    }
  }

  async getCommandJournalResult(
    idempotencyKey: string | undefined,
    userId: string,
    commandType: string,
    requestHash: string,
  ): Promise<CommandJournalResult> {
    if (!this.ready || !idempotencyKey) {
      return { status: "miss" };
    }

    try {
      const result = await this.client.query(
        `
          SELECT request_hash, response
          FROM command_journal
          WHERE idempotency_key = $1 AND user_id = $2 AND command_type = $3
        `,
        [idempotencyKey, userId, commandType],
      );
      const row = result.rows?.[0] as CommandJournalRow | undefined;

      if (!row) {
        return { status: "miss" };
      }
      if (row.request_hash !== requestHash) {
        return { status: "conflict" };
      }

      return { status: "hit", response: row.response };
    } catch (error) {
      console.error("Failed to read command journal", error);
      return { status: "miss" };
    }
  }

  async saveCommandJournalResult(
    idempotencyKey: string | undefined,
    userId: string,
    commandType: string,
    requestHash: string,
    response: object,
  ): Promise<void> {
    if (!this.ready || !idempotencyKey) {
      return;
    }

    try {
      await this.client.query(
        `
          INSERT INTO command_journal (
            idempotency_key, user_id, command_type, request_hash, response, created_at
          )
          VALUES ($1, $2, $3, $4, $5, NOW())
          ON CONFLICT (idempotency_key, user_id, command_type)
          DO NOTHING
        `,
        [idempotencyKey, userId, commandType, requestHash, response],
      );
    } catch (error) {
      console.error("Failed to write command journal", error);
    }
  }

  private async createSchema(): Promise<void> {
    await this.client.query(`
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
      )
    `);
    await this.client.query(`
      CREATE INDEX IF NOT EXISTS trades_market_created_at_idx
        ON trades (market, created_at DESC)
    `);
    await this.client.query(`
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
      )
    `);
    await this.client.query(`
      ALTER TABLE open_orders
        ADD COLUMN IF NOT EXISTS position INTEGER NOT NULL DEFAULT 0
    `);
    await this.client.query(`
      CREATE INDEX IF NOT EXISTS open_orders_market_side_price_idx
        ON open_orders (market, side, price)
    `);
    await this.client.query(`
      CREATE TABLE IF NOT EXISTS command_journal (
        idempotency_key TEXT NOT NULL,
        user_id TEXT NOT NULL,
        command_type TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (idempotency_key, user_id, command_type)
      )
    `);
    await this.client.query(`
      CREATE INDEX IF NOT EXISTS command_journal_user_created_at_idx
        ON command_journal (user_id, created_at DESC)
    `);

    for (const { tableName } of KLINE_INTERVALS) {
      await this.client.query(`
        CREATE TABLE IF NOT EXISTS ${tableName} (
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
        )
      `);
    }
  }

  private async insertTrade(
    market: string,
    takerSide: OrderSide,
    fill: Fill,
    createdAt: Date,
  ): Promise<void> {
    await this.client.query(
      `
        INSERT INTO trades (
          market, price, quantity, maker_order_id, taker_order_id,
          maker_user_id, taker_user_id, taker_side, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        market,
        fill.price,
        fill.quantity,
        fill.makerOrderId,
        fill.takerOrderId,
        fill.makerUserId,
        fill.takerUserId,
        takerSide,
        createdAt,
      ],
    );
  }

  private async upsertKlines(market: string, fill: Fill, createdAt: Date): Promise<void> {
    const entries = buildKlineEntries(market, fill, createdAt);

    for (const entry of entries) {
      await this.client.query(
        `
          INSERT INTO ${entry.tableName} (
            market, bucket, start, open, high, low, close, volume, quote_volume, trades
          )
          VALUES ($1, $2, $2, $3, $3, $3, $3, $4, $5, 1)
          ON CONFLICT (market, bucket)
          DO UPDATE SET
            high = GREATEST(${entry.tableName}.high, EXCLUDED.high),
            low = LEAST(${entry.tableName}.low, EXCLUDED.low),
            close = EXCLUDED.close,
            volume = ${entry.tableName}.volume + EXCLUDED.volume,
            quote_volume = ${entry.tableName}.quote_volume + EXCLUDED.quote_volume,
            trades = ${entry.tableName}.trades + 1
        `,
        [entry.market, entry.bucket, entry.price, entry.quantity, entry.quoteVolume],
      );
    }
  }
}
