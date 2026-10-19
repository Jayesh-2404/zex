import express from "express";
import cors from "cors";
import { Client } from "pg";
import { createClient } from "redis";
import orderRouter from "./routes/order.js";
import viewRouter, { closeKlineClient } from "./routes/viewRouter.js";
import { RedisManager, REDIS_CLIENT_OPTIONS } from "./redis/redis.js";

export const app = express();
app.use(express.json());
app.use(cors());

app.get("/api/v1/test", (_req, res) => {
  try {
    res.send("Test route working !!");
  } catch {
    console.log("Test routes failed");
    res.status(500).json({ message: "Internal server error in Test Routes" });
  }
});

app.use("/api/v1/order", orderRouter);
app.use("/api/v1/klines", viewRouter);

interface EngineResponse<T> {
  type: string;
  payload: T;
}

export function isValidMarket(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z0-9]+_[A-Z0-9]+$/.test(value);
}

export function createPostgresClient(): Client {
  const client = new Client({
    user: process.env.POSTGRES_USER ?? "cex",
    host: process.env.POSTGRES_HOST ?? "localhost",
    database: process.env.POSTGRES_DB ?? "cex",
    password: process.env.POSTGRES_PASSWORD ?? "cex",
    port: Number(process.env.POSTGRES_PORT ?? 5432),
  });
  // These are one-shot clients, so a dropped socket cannot be retried. Without
  // a listener it would surface as an unhandled 'error' event and kill the API.
  client.on("error", () => undefined);
  return client;
}

async function checkRedis(): Promise<{ status: "ok" | "error"; message?: string }> {
  const client = createClient({ url: process.env.REDIS_URL ?? "redis://localhost:6379", ...REDIS_CLIENT_OPTIONS });
  try {
    await client.connect();
    await client.ping();
    return { status: "ok" };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Redis ping failed",
    };
  } finally {
    await client.quit().catch(() => undefined);
  }
}

async function checkPostgres(): Promise<{ status: "ok" | "error"; message?: string }> {
  const client = createPostgresClient();
  try {
    await client.connect();
    await client.query("SELECT 1");
    return { status: "ok" };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Postgres check failed",
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function parseLimit(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

app.get("/api/v1/health", async (_req, res) => {
  const [redis, postgres] = await Promise.all([checkRedis(), checkPostgres()]);
  res.json({
    api: { status: "ok" },
    redis,
    postgres,
  });
});

app.get("/api/v1/tickers", async (_req, res) => {
  try {
    const response = await (await RedisManager.getInstance()).sendAndWait<EngineResponse<unknown[]>>({
      type: "GET_TICKERS",
      data: {},
    });
    if (response.type === "ENGINE_ERROR") {
      return res.status(503).json(response.payload);
    }
    res.json(response.payload);
  } catch (error) {
    console.log("Error in getting tickers ", error);
    res.status(500).json({ message: "internal server error in getting tickers" });
  }
});

app.get("/api/v1/depth", async (req, res) => {
  try {
    const { symbol } = req.query;

    if (!isValidMarket(symbol)) {
      return res.status(400).json({ message: "symbol must use SYMBOL_QUOTE format, for example ACME_USD" });
    }

    const response = await (await RedisManager.getInstance()).sendAndWait<EngineResponse<unknown>>({
      type: "GET_DEPTH",
      data: {
        market: symbol,
      },
    });
    if (response.type === "ENGINE_ERROR") {
      return res.status(503).json(response.payload);
    }
    res.status(200).json(response.payload);
  } catch (error) {
    console.log("Error in getting depth", error);
    res.status(500).json({ message: "Error in getting depth", error });
  }
});

app.get("/api/v1/orders/open", async (req, res) => {
  try {
    const { market, userId } = req.query;

    if (!isValidMarket(market)) {
      return res.status(400).json({ message: "market must use SYMBOL_QUOTE format, for example ACME_USD" });
    }
    if (typeof userId !== "string" || userId.trim().length === 0) {
      return res.status(400).json({ message: "userId is required" });
    }

    const response = await (await RedisManager.getInstance()).sendAndWait<EngineResponse<unknown[]>>({
      type: "GET_OPEN_ORDERS",
      data: {
        market,
        userId: userId.trim(),
      },
    });
    if (response.type === "ENGINE_ERROR") {
      return res.status(503).json(response.payload);
    }
    res.status(200).json(response.payload);
  } catch (error) {
    console.log("Error in getting open orders", error);
    res.status(500).json({ message: "Error in getting open orders" });
  }
});

app.get("/api/v1/balances", async (req, res) => {
  const { userId } = req.query;

  if (typeof userId !== "string" || userId.trim().length === 0) {
    return res.status(400).json({ message: "userId is required" });
  }

  try {
    const response = await (await RedisManager.getInstance()).sendAndWait<EngineResponse<unknown[]>>({
      type: "GET_BALANCES",
      data: { userId: userId.trim() },
    });
    if (response.type === "ENGINE_ERROR") {
      return res.status(503).json(response.payload);
    }
    res.status(200).json(response.payload);
  } catch (error) {
    console.log("Error in getting balances", error);
    res.status(500).json({ message: "Error in getting balances" });
  }
});

app.get("/api/v1/trades/recent", async (req, res) => {
  const { market } = req.query;

  if (!isValidMarket(market)) {
    return res.status(400).json({ message: "market must use SYMBOL_QUOTE format, for example ACME_USD" });
  }

  const limit = parseLimit(req.query.limit, 25, 100);
  const client = createPostgresClient();

  try {
    await client.connect();
    const result = await client.query(
      `
        SELECT
          id,
          market,
          price::text,
          quantity::text,
          maker_order_id,
          taker_order_id,
          maker_user_id,
          taker_user_id,
          taker_side,
          created_at
        FROM trades
        WHERE market = $1
        ORDER BY created_at DESC
        LIMIT $2
      `,
      [market, limit],
    );
    res.json(
      result.rows.map((row) => ({
        id: row.id,
        market: row.market,
        price: row.price,
        quantity: row.quantity,
        makerOrderId: row.maker_order_id,
        takerOrderId: row.taker_order_id,
        makerUserId: row.maker_user_id,
        takerUserId: row.taker_user_id,
        takerSide: row.taker_side,
        createdAt: row.created_at,
      })),
    );
  } catch (error) {
    console.log("Error in getting recent trades", error);
    res.status(503).json({ message: "Recent trades are unavailable because Postgres is not reachable" });
  } finally {
    await client.end().catch(() => undefined);
  }
});

const STREAM_CHANNEL = "zex:events";

app.get("/api/v1/stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const subscriber = createClient({
    url: process.env.REDIS_URL ?? "redis://localhost:6379",
    ...REDIS_CLIENT_OPTIONS,
  });
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);

  try {
    await subscriber.connect();
    await subscriber.subscribe(STREAM_CHANNEL, (message: string) => {
      res.write(`data: ${message}\n\n`);
    });
  } catch (error) {
    console.error("Failed to subscribe for market stream", error);
    res.write(`data: ${JSON.stringify({ type: "error", message: "Stream unavailable" })}\n\n`);
  }

  req.on("close", () => {
    clearInterval(heartbeat);
    subscriber.unsubscribe(STREAM_CHANNEL).catch(() => undefined);
    subscriber.quit().catch(() => undefined);
  });
});

export { closeKlineClient };
