import { createClient } from "redis";
import { v4 as uuidv4 } from "uuid";
import { Client } from "pg";
import { Fill, OrderBook, Order } from "./orderbook.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const QUEUE_KEY = "message";

const orderBooks = new Map<string, OrderBook>();
const marketStats = new Map<string, MarketStats>();

type OrderSide = "buy" | "sell";

interface MarketStats {
  firstPrice?: number;
  lastPrice?: number;
  high?: number;
  low?: number;
  volume: number;
  quoteVolume: number;
  trades: number;
}

class TradeStore {
  private client = new Client({
    user: process.env.POSTGRES_USER ?? "cex",
    host: process.env.POSTGRES_HOST ?? "localhost",
    database: process.env.POSTGRES_DB ?? "cex",
    password: process.env.POSTGRES_PASSWORD ?? "cex",
    port: Number(process.env.POSTGRES_PORT ?? 5432),
  });
  private ready = false;

  async connect(): Promise<void> {
    try {
      await this.client.connect();
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
      this.ready = true;
      console.log("Engine connected to Postgres");
    } catch (error) {
      console.warn("Trade persistence disabled; Postgres connection failed", error);
    }
  }

  async saveFills(market: string, takerSide: OrderSide, fills: Fill[]): Promise<void> {
    if (!this.ready || fills.length === 0) {
      return;
    }

    for (const fill of fills) {
      try {
        await this.client.query(
          `
            INSERT INTO trades (
              market, price, quantity, maker_order_id, taker_order_id,
              maker_user_id, taker_user_id, taker_side
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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
          ],
        );
      } catch (error) {
        console.error("Failed to persist trade", error);
      }
    }
  }
}

function getOrderBook(market: string): OrderBook {
  if (!orderBooks.has(market)) {
    orderBooks.set(market, new OrderBook(market));
  }
  return orderBooks.get(market)!;
}

function getStats(market: string): MarketStats {
  if (!marketStats.has(market)) {
    marketStats.set(market, { volume: 0, quoteVolume: 0, trades: 0 });
  }
  return marketStats.get(market)!;
}

function recordFills(market: string, fills: Fill[]): void {
  const stats = getStats(market);

  for (const fill of fills) {
    const price = Number(fill.price);
    const quantity = Number(fill.quantity);

    if (!Number.isFinite(price) || !Number.isFinite(quantity)) {
      continue;
    }

    stats.firstPrice ??= price;
    stats.lastPrice = price;
    stats.high = stats.high === undefined ? price : Math.max(stats.high, price);
    stats.low = stats.low === undefined ? price : Math.min(stats.low, price);
    stats.volume += quantity;
    stats.quoteVolume += price * quantity;
    stats.trades += 1;
  }
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? "0" : value.toString();
}

function getTickers() {
  const markets = new Set([...orderBooks.keys(), ...marketStats.keys()]);

  return [...markets].map((market) => {
    const stats = getStats(market);
    const firstPrice = stats.firstPrice ?? 0;
    const lastPrice = stats.lastPrice ?? 0;
    const priceChange = lastPrice - firstPrice;
    const priceChangePercent = firstPrice === 0 ? 0 : (priceChange / firstPrice) * 100;

    return {
      symbol: market,
      firstPrice: formatNumber(stats.firstPrice),
      lastPrice: formatNumber(stats.lastPrice),
      high: formatNumber(stats.high),
      low: formatNumber(stats.low),
      priceChange: priceChange.toString(),
      priceChangePercent: priceChangePercent.toString(),
      volume: stats.volume.toString(),
      quoteVolume: stats.quoteVolume.toString(),
      trades: stats.trades.toString(),
    };
  });
}

async function startEngine() {
  const client = createClient({ url: REDIS_URL });
  const tradeStore = new TradeStore();

  await tradeStore.connect();
  await client.connect();
  console.log("Engine connected to Redis");

  for (;;) {
    try {
      const result = await client.brPop(QUEUE_KEY, 0);
      if (!result) continue;

      const { clientId, message } = JSON.parse(result.element);
      const { type, data } = message;

      let response: object;

      switch (type) {
        case "CREATE_ORDER": {
          const book = getOrderBook(data.market);
          const order: Order = {
            id: uuidv4(),
            price: data.price,
            quantity: data.quantity,
            filled: "0",
            side: data.side,
            userId: data.userId,
          };
          const result = book.addOrder(order);
          recordFills(data.market, result.fills);
          await tradeStore.saveFills(data.market, data.side, result.fills);

          const totalFilled = parseFloat(order.filled);
          const totalQty = parseFloat(order.quantity);
          const status = totalFilled >= totalQty - 1e-8 ? "filled" : totalFilled > 0 ? "partial" : "open";

          response = {
            type: "ORDER_CREATED",
            payload: {
              orderId: order.id,
              market: data.market,
              price: data.price,
              quantity: data.quantity,
              filled: order.filled,
              side: data.side,
              status,
              fills: result.fills,
            },
          };
          break;
        }
        case "GET_DEPTH": {
          const book = getOrderBook(data.market);
          const depth = book.getDepth();
          response = { type: "DEPTH", payload: { market: data.market, ...depth } };
          break;
        }
        case "CANCEL_ORDER": {
          const book = getOrderBook(data.market);
          const cancelResult = book.cancelOrder(data.orderId, data.userId);

          if (cancelResult.status === "cancelled") {
            response = {
              type: "ORDER_CANCELLED",
              payload: {
                orderId: cancelResult.order.id,
                market: data.market,
                price: cancelResult.order.price,
                quantity: cancelResult.order.quantity,
                filled: cancelResult.order.filled,
                side: cancelResult.order.side,
                status: "cancelled",
              },
            };
          } else if (cancelResult.status === "owner_mismatch") {
            response = {
              type: "ORDER_CANCEL_REJECTED",
              payload: {
                orderId: data.orderId,
                market: data.market,
                status: "rejected",
                reason: "ORDER_OWNER_MISMATCH",
                message: "Order belongs to a different user",
              },
            };
          } else {
            response = {
              type: "ORDER_CANCEL_REJECTED",
              payload: {
                orderId: data.orderId,
                market: data.market,
                status: "rejected",
                reason: "ORDER_NOT_FOUND",
                message: "Open order was not found",
              },
            };
          }
          break;
        }
        case "GET_TICKERS": {
          response = { type: "TICKERS", payload: getTickers() };
          break;
        }
        default:
          response = { type: "ERROR", payload: { message: `Unknown type: ${type}` } };
      }

      await client.publish(clientId, JSON.stringify(response));
    } catch (error) {
      console.error("Engine error:", error);
    }
  }
}

startEngine().catch(console.error);
