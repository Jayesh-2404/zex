import { createClient } from "redis";
import { v4 as uuidv4 } from "uuid";
import { Fill, OrderBook, Order } from "./orderbook.js";
import { TradeStore } from "./persistence.js";
import { hashCreateOrderCommand, idempotencyConflictResponse } from "./commands.js";
import { getUserOpenOrders } from "./openOrders.js";
import { toScaled } from "./decimal.js";
import { MarketStats, buildMarketStats } from "./tickerStats.js";
import { VirtualLedger } from "./balances.js";
import type { Balance } from "./balances.js";
import type { StoredOpenOrder } from "./persistence.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const QUEUE_KEY = "message";
const EVENTS_CHANNEL = "zex:events";

const orderBooks = new Map<string, OrderBook>();
const marketStats = new Map<string, MarketStats>();

type OrderSide = "buy" | "sell";

// Local-dev fallback only: mirrors db/init seed data so the engine can run
// without Postgres when DEMO_SEED=true. Docker Compose never sets DEMO_SEED,
// so containerised behaviour is unchanged.
const DEMO_BALANCES: Balance[] = [
  { userId: "user-1", asset: "USD", available: "99900", locked: "100" },
  { userId: "user-1", asset: "ACME", available: "1000", locked: "0" },
  { userId: "user-2", asset: "USD", available: "100000", locked: "0" },
  { userId: "user-2", asset: "ACME", available: "990", locked: "10" },
];

const DEMO_ORDERS: StoredOpenOrder[] = [
  { market: "ACME_USD", id: "demo-buy-1", price: "10", quantity: "10", filled: "0", side: "buy", userId: "user-1" },
  { market: "ACME_USD", id: "demo-sell-1", price: "12", quantity: "10", filled: "0", side: "sell", userId: "user-2" },
];

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

async function restoreTickerStats(tradeStore: TradeStore): Promise<void> {
  const rows = await tradeStore.loadTickerStats24h();
  const statsByMarket = buildMarketStats(rows);

  for (const [market, stats] of Object.entries(statsByMarket)) {
    marketStats.set(market, stats);
  }

  const restoredMarkets = Object.keys(statsByMarket).length;
  if (restoredMarkets > 0) {
    console.log(`Restored ticker stats for ${restoredMarkets} markets from Postgres`);
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

function isInsufficientFundsError(error: unknown): boolean {
  return error instanceof Error && /insufficient/i.test(error.message);
}

function insufficientFundsResponse(message: string): object {
  return {
    type: "ORDER_REJECTED",
    payload: {
      status: "rejected",
      reason: "INSUFFICIENT_FUNDS",
      message,
    },
  };
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
  const storedBalances = await tradeStore.loadBalances();
  const useDemoSeed =
    process.env.DEMO_SEED === "true" && !tradeStore.isReady() && storedBalances.length === 0;
  const ledger = new VirtualLedger(useDemoSeed ? DEMO_BALANCES : storedBalances);
  await restoreOpenOrders(tradeStore);
  await restoreTickerStats(tradeStore);
  if (useDemoSeed) {
    for (const { market, ...order } of DEMO_ORDERS) {
      getOrderBook(market).restoreOpenOrder(order);
    }
    console.log("DEMO_SEED enabled: seeded in-memory demo balances and orders (Postgres unreachable)");
  }
  await client.connect();
  console.log("Engine connected to Redis");

  async function shutdown(signal: string): Promise<void> {
    console.log(`${signal} received, shutting down engine`);
    await client.quit().catch(() => undefined);
    await tradeStore.close();
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

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
    let clientId: string | undefined;
    try {
      const result = await client.brPop(QUEUE_KEY, 0);
      if (!result) continue;

      const parsed = JSON.parse(result.element) as {
        clientId: string;
        message: { type: string; data: any };
      };
      clientId = parsed.clientId;
      const { type, data } = parsed.message;

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
          // Snapshot in-memory state before mutating so a ledger, matching,
          // or persistence failure can revert instead of diverging from Postgres.
          const bookSnapshot = book.getOpenOrders();
          const ledgerSnapshot = ledger.getBalances();
          const statsSnapshot = { ...getStats(data.market) };

          const revertCreate = (): void => {
            book.replaceAll(bookSnapshot);
            ledger.restore(ledgerSnapshot);
            marketStats.set(data.market, { ...statsSnapshot });
          };

          try {
            ledger.reserveOrder(data.market, order);
          } catch (error) {
            if (isInsufficientFundsError(error)) {
              response = insufficientFundsResponse(
                error instanceof Error ? error.message : "Insufficient balance",
              );
              break;
            }
            throw error;
          }

          let result: ReturnType<OrderBook["addOrder"]>;
          try {
            result = book.addOrder(order);
            recordFills(data.market, result.fills);

            for (const fill of result.fills) {
              ledger.settleFill(data.market, fill, data.side === "buy" ? "sell" : "buy");
            }
            const remainingOrder = result.remainingOrder ?? { ...order, quantity: "0", filled: "0" };
            ledger.reconcileOrderReservation(data.market, order, remainingOrder.quantity);
          } catch (error) {
            revertCreate();
            if (isInsufficientFundsError(error)) {
              response = insufficientFundsResponse(
                error instanceof Error ? error.message : "Insufficient balance",
              );
              break;
            }
            throw error;
          }

          const totalFilled = toScaled(order.filled);
          const totalQty = toScaled(order.quantity);
          const status = totalFilled >= totalQty ? "filled" : totalFilled > 0n ? "partial" : "open";

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

          const persisted = await tradeStore.persistOrderResult(
            data.market,
            data.side,
            result.fills,
            book.getOpenOrders(),
            data.idempotencyKey
              ? {
                  idempotencyKey: data.idempotencyKey,
                  userId: data.userId,
                  commandType: "CREATE_ORDER",
                  requestHash,
                  response,
                }
              : null,
            {
              balances: ledger.getBalances(),
              changes: ledger.drainChanges(),
            },
          );

          if (!persisted && !useDemoSeed) {
            // Fail closed: Postgres did not commit, so don't ack success or
            // emit market events. Revert and let the caller retry (the journal
            // row rolled back with the mutation, so a retry re-executes once).
            revertCreate();
            response = {
              type: "ENGINE_ERROR",
              payload: { message: "Order could not be persisted, please retry" },
            };
            break;
          }

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
          const bookSnapshot = book.getOpenOrders();
          const ledgerSnapshot = ledger.getBalances();
          const cancelResult = book.cancelOrder(data.orderId, data.userId);

          if (cancelResult.status === "cancelled") {
            try {
              ledger.reconcileOrderReservation(data.market, cancelResult.order, "0");
            } catch (error) {
              book.replaceAll(bookSnapshot);
              ledger.restore(ledgerSnapshot);
              throw error;
            }
            const persisted = await tradeStore.saveOpenOrdersSnapshot(data.market, book.getOpenOrders(), {
              balances: ledger.getBalances(),
              changes: ledger.drainChanges(),
            });
            if (!persisted && !useDemoSeed) {
              // Fail closed: cancel did not commit, restore the order and
              // balances instead of acking a cancel that will reappear.
              book.replaceAll(bookSnapshot);
              ledger.restore(ledgerSnapshot);
              response = {
                type: "ENGINE_ERROR",
                payload: { message: "Cancel could not be persisted, please retry" },
              };
              break;
            }
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
        case "GET_BALANCES": {
          response = { type: "BALANCES", payload: ledger.getBalances(data.userId) };
          break;
        }
        default:
          response = { type: "ERROR", payload: { message: `Unknown type: ${type}` } };
      }

      await client.publish(clientId, JSON.stringify(response));
    } catch (error) {
      console.error("Engine error:", error);

      // The caller is blocked on this reply until its timeout expires, so a
      // swallowed error is a 5s hang rather than a failure. Always answer.
      // Callers that need at-most-once semantics send an Idempotency-Key; the
      // journal row commits with the book mutation, so a retry after this
      // reply replays the original result instead of placing a second order.
      if (clientId) {
        await client
          .publish(
            clientId,
            JSON.stringify({
              type: "ENGINE_ERROR",
              payload: { message: "Command could not be processed" },
            }),
          )
          .catch(() => undefined);
      }
    }
  }
}

startEngine().catch(console.error);
