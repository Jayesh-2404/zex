import { createClient } from "redis";
import { v4 as uuidv4 } from "uuid";
import { Fill, OrderBook, Order } from "./orderbook.js";
import { TradeStore } from "./persistence.js";
import { hashCreateOrderCommand, idempotencyConflictResponse } from "./commands.js";
import { getUserOpenOrders } from "./openOrders.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const QUEUE_KEY = "message";
const EVENTS_CHANNEL = "zex:events";

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

function getOrderBook(market: string): OrderBook {
  if (!orderBooks.has(market)) {
    orderBooks.set(market, new OrderBook(market));
  }
  return orderBooks.get(market)!;
}

async function restoreOpenOrders(tradeStore: TradeStore): Promise<void> {
  const openOrders = await tradeStore.loadOpenOrders();

  for (const { market, ...order } of openOrders) {
    getOrderBook(market).restoreOpenOrder(order);
  }

  if (openOrders.length > 0) {
    console.log(`Restored ${openOrders.length} open orders from Postgres`);
  }
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
  await restoreOpenOrders(tradeStore);
  await client.connect();
  console.log("Engine connected to Redis");

  async function publishEvent(event: object): Promise<void> {
    try {
      await client.publish(EVENTS_CHANNEL, JSON.stringify(event));
    } catch (error) {
      console.error("Failed to publish event", error);
    }
  }

  async function publishMarketEvents(market: string, affectedUsers: string[]): Promise<void> {
    const depth = getOrderBook(market).getDepth();
    await publishEvent({ type: "depth", market, data: depth });

    for (const user of affectedUsers) {
      await publishEvent({
        type: "openOrders",
        market,
        userId: user,
        data: getUserOpenOrders(market, getOrderBook(market).getOpenOrders(), user),
      });
    }
  }

  for (;;) {
    try {
      const result = await client.brPop(QUEUE_KEY, 0);
      if (!result) continue;

      const { clientId, message } = JSON.parse(result.element);
      const { type, data } = message;

      let response: object;

      switch (type) {
        case "CREATE_ORDER": {
          const requestHash = hashCreateOrderCommand(data);
          const journalResult = await tradeStore.getCommandJournalResult(
            data.idempotencyKey,
            data.userId,
            "CREATE_ORDER",
            requestHash,
          );

          if (journalResult.status === "hit") {
            response = journalResult.response;
            break;
          }
          if (journalResult.status === "conflict") {
            response = idempotencyConflictResponse(data.idempotencyKey);
            break;
          }

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
          await tradeStore.saveOpenOrdersSnapshot(data.market, book.getOpenOrders());

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
          await tradeStore.saveCommandJournalResult(
            data.idempotencyKey,
            data.userId,
            "CREATE_ORDER",
            requestHash,
            response,
          );

          const affectedUsers = Array.from(
            new Set([data.userId, ...result.fills.map((fill) => fill.makerUserId)]),
          );
          await publishMarketEvents(data.market, affectedUsers);
          for (const fill of result.fills) {
            await publishEvent({
              type: "trade",
              market: data.market,
              data: {
                price: fill.price,
                quantity: fill.quantity,
                makerOrderId: fill.makerOrderId,
                takerOrderId: fill.takerOrderId,
                makerUserId: fill.makerUserId,
                takerUserId: fill.takerUserId,
                takerSide: data.side,
                createdAt: new Date().toISOString(),
              },
            });
          }
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
            await tradeStore.saveOpenOrdersSnapshot(data.market, book.getOpenOrders());
            await publishMarketEvents(data.market, [data.userId]);
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
        case "GET_OPEN_ORDERS": {
          const book = getOrderBook(data.market);
          response = {
            type: "OPEN_ORDERS",
            payload: getUserOpenOrders(data.market, book.getOpenOrders(), data.userId),
          };
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
