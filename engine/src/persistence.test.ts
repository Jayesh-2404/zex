import test from "node:test";
import assert from "node:assert/strict";
import {
  buildKlineEntries,
  getBucketStart,
  getUtcWeekStart,
  PersistenceClient,
  TradeStore,
} from "./persistence.js";
import { Fill } from "./orderbook.js";

function fill(overrides: Partial<Fill> = {}): Fill {
  return {
    price: "12.5",
    quantity: "2",
    makerOrderId: "maker-order",
    takerOrderId: "taker-order",
    makerUserId: "maker",
    takerUserId: "taker",
    ...overrides,
  };
}

class FakeClient implements PersistenceClient {
  queries: { text: string; values?: unknown[] }[] = [];
  rows: unknown[] = [];

  async connect(): Promise<void> {
    return undefined;
  }

  async query(text: string, values?: unknown[]): Promise<{ rows?: unknown[] }> {
    this.queries.push({ text, values });
    return { rows: this.rows };
  }
}

test("rounds timestamps down to the interval bucket start", () => {
  const date = new Date("2026-07-23T10:17:45.123Z");

  assert.equal(getBucketStart(date, 60 * 1000).toISOString(), "2026-07-23T10:17:00.000Z");
  assert.equal(getBucketStart(date, 60 * 60 * 1000).toISOString(), "2026-07-23T10:00:00.000Z");
  assert.equal(getUtcWeekStart(date).toISOString(), "2026-07-20T00:00:00.000Z");
});

test("builds 1m, 1h, and 1w kline entries from a fill", () => {
  const entries = buildKlineEntries("SOL_USDC", fill(), new Date("2026-07-23T10:17:45.123Z"));

  assert.deepEqual(
    entries.map((entry) => ({
      tableName: entry.tableName,
      market: entry.market,
      bucket: entry.bucket.toISOString(),
      price: entry.price,
      quantity: entry.quantity,
      quoteVolume: entry.quoteVolume,
    })),
    [
      {
        tableName: "klines_1m",
        market: "SOL_USDC",
        bucket: "2026-07-23T10:17:00.000Z",
        price: "12.5",
        quantity: "2",
        quoteVolume: "25",
      },
      {
        tableName: "klines_1h",
        market: "SOL_USDC",
        bucket: "2026-07-23T10:00:00.000Z",
        price: "12.5",
        quantity: "2",
        quoteVolume: "25",
      },
      {
        tableName: "klines_1w",
        market: "SOL_USDC",
        bucket: "2026-07-20T00:00:00.000Z",
        price: "12.5",
        quantity: "2",
        quoteVolume: "25",
      },
    ],
  );
});

test("skips invalid fill values instead of writing broken candles", () => {
  assert.deepEqual(
    buildKlineEntries("SOL_USDC", fill({ price: "not-a-number" }), new Date("2026-07-23T10:17:45.123Z")),
    [],
  );
  assert.deepEqual(
    buildKlineEntries("SOL_USDC", fill({ quantity: "0" }), new Date("2026-07-23T10:17:45.123Z")),
    [],
  );
});

test("saves open order snapshots transactionally with deterministic positions", async () => {
  const client = new FakeClient();
  const store = new TradeStore(client);

  await store.connect();
  client.queries = [];

  await store.saveOpenOrdersSnapshot("SOL_USDC", [
    {
      id: "bid-1",
      price: "10",
      quantity: "2",
      filled: "0",
      side: "buy",
      userId: "buyer",
    },
    {
      id: "ask-1",
      price: "12",
      quantity: "3",
      filled: "1",
      side: "sell",
      userId: "seller",
    },
  ]);

  assert.equal(client.queries[0].text, "BEGIN");
  assert.equal(client.queries[1].text, "DELETE FROM open_orders WHERE market = $1");
  assert.deepEqual(client.queries[2].values, ["SOL_USDC", "bid-1", "10", "2", "0", "buy", "buyer", 0]);
  assert.deepEqual(client.queries[3].values, ["SOL_USDC", "ask-1", "12", "3", "1", "sell", "seller", 1]);
  assert.equal(client.queries.at(-1)?.text, "COMMIT");
});

test("loads stored open orders into engine order shape", async () => {
  const client = new FakeClient();
  client.rows = [
    {
      market: "SOL_USDC",
      id: "ask-1",
      price: "12",
      quantity: "3",
      filled: "1",
      side: "sell",
      user_id: "seller",
    },
  ];
  const store = new TradeStore(client);

  await store.connect();

  assert.deepEqual(await store.loadOpenOrders(), [
    {
      market: "SOL_USDC",
      id: "ask-1",
      price: "12",
      quantity: "3",
      filled: "1",
      side: "sell",
      userId: "seller",
    },
  ]);
});

test("returns command journal misses when a key has not been seen", async () => {
  const client = new FakeClient();
  const store = new TradeStore(client);

  await store.connect();

  assert.deepEqual(
    await store.getCommandJournalResult("order-key-1", "user-1", "CREATE_ORDER", "request-hash"),
    { status: "miss" },
  );
});

test("replays command journal hits for matching request hashes", async () => {
  const client = new FakeClient();
  client.rows = [
    {
      request_hash: "request-hash",
      response: {
        type: "ORDER_CREATED",
        payload: {
          orderId: "order-1",
          status: "open",
        },
      },
    },
  ];
  const store = new TradeStore(client);

  await store.connect();

  assert.deepEqual(
    await store.getCommandJournalResult("order-key-1", "user-1", "CREATE_ORDER", "request-hash"),
    {
      status: "hit",
      response: {
        type: "ORDER_CREATED",
        payload: {
          orderId: "order-1",
          status: "open",
        },
      },
    },
  );
});

test("rejects command journal conflicts for reused keys with different request hashes", async () => {
  const client = new FakeClient();
  client.rows = [
    {
      request_hash: "first-request-hash",
      response: {
        type: "ORDER_CREATED",
        payload: {
          orderId: "order-1",
          status: "open",
        },
      },
    },
  ];
  const store = new TradeStore(client);

  await store.connect();

  assert.deepEqual(
    await store.getCommandJournalResult("order-key-1", "user-1", "CREATE_ORDER", "second-request-hash"),
    { status: "conflict" },
  );
});

test("saves command journal responses by idempotency key, user, and command type", async () => {
  const client = new FakeClient();
  const store = new TradeStore(client);
  const response = {
    type: "ORDER_CREATED",
    payload: {
      orderId: "order-1",
      status: "open",
    },
  };

  await store.connect();
  client.queries = [];
  await store.saveCommandJournalResult("order-key-1", "user-1", "CREATE_ORDER", "request-hash", response);

  assert.deepEqual(client.queries[0].values, [
    "order-key-1",
    "user-1",
    "CREATE_ORDER",
    "request-hash",
    response,
  ]);
});
