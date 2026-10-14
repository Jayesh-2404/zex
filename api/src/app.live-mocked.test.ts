// Mocked live-path tests: stub RedisManager.getInstance so no Redis/Postgres/engine needed.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { app, isValidMarket, parseLimit } from "./app.js";
import { RedisManager } from "./redis/redis.js";

let baseUrl = "";
let server: ReturnType<typeof app.listen> | undefined;

const originalGetInstance = RedisManager.getInstance.bind(RedisManager);
let canned: { type: string; payload: unknown } = { type: "OK", payload: [] };

function stubEngine(response: { type: string; payload: unknown }): void {
  canned = response;
  (RedisManager as unknown as { getInstance: () => Promise<unknown> }).getInstance = async () => ({
    sendAndWait: async () => canned,
  });
}

function restoreEngine(): void {
  (RedisManager as unknown as { getInstance: unknown }).getInstance = originalGetInstance;
}

async function get(path: string) {
  const res = await fetch(`${baseUrl}${path}`);
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  return { status: res.status, body };
}

async function send(path: string, init: RequestInit) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  return { status: res.status, body };
}

const validOrder = {
  market: "ACME_USD",
  price: "10",
  quantity: "1",
  side: "buy",
  userId: "user-1",
};

before(async () => {
  server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => {
  restoreEngine();
  server?.close();
});

describe("mocked tickers/depth/open/balances", () => {
  it("passes tickers payload through with 200", async () => {
    stubEngine({ type: "TICKERS", payload: [{ market: "ACME_USD", price: "10" }] });
    const res = await get("/api/v1/tickers");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [{ market: "ACME_USD", price: "10" }]);
  });

  it("maps ENGINE_ERROR to 503 for tickers", async () => {
    stubEngine({ type: "ENGINE_ERROR", payload: { message: "down" } });
    const res = await get("/api/v1/tickers");
    assert.equal(res.status, 503);
  });

  it("maps ENGINE_ERROR to 503 for depth", async () => {
    stubEngine({ type: "ENGINE_ERROR", payload: { message: "down" } });
    const res = await get("/api/v1/depth?symbol=ACME_USD");
    assert.equal(res.status, 503);
  });

  it("passes depth payload through with 200", async () => {
    stubEngine({ type: "DEPTH", payload: { bids: [], asks: [] } });
    const res = await get("/api/v1/depth?symbol=ACME_USD");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { bids: [], asks: [] });
  });

  it("maps ENGINE_ERROR to 503 for open orders", async () => {
    stubEngine({ type: "ENGINE_ERROR", payload: { message: "down" } });
    const res = await get("/api/v1/orders/open?market=ACME_USD&userId=user-1");
    assert.equal(res.status, 503);
  });

  it("passes open orders payload through with 200", async () => {
    stubEngine({ type: "OPEN_ORDERS", payload: [{ orderId: "o1" }] });
    const res = await get("/api/v1/orders/open?market=ACME_USD&userId=user-1");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [{ orderId: "o1" }]);
  });

  it("maps ENGINE_ERROR to 503 for balances", async () => {
    stubEngine({ type: "ENGINE_ERROR", payload: { message: "down" } });
    const res = await get("/api/v1/balances?userId=user-1");
    assert.equal(res.status, 503);
  });

  it("passes balances payload through with 200", async () => {
    stubEngine({ type: "BALANCES", payload: [{ asset: "USD", available: "5" }] });
    const res = await get("/api/v1/balances?userId=user-1");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [{ asset: "USD", available: "5" }]);
  });
});

describe("mocked POST /order", () => {
  it("maps ORDER_CREATED to 200", async () => {
    stubEngine({ type: "ORDER_CREATED", payload: { orderId: "o1" } });
    const res = await send("/api/v1/order", { method: "POST", body: JSON.stringify(validOrder) });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { orderId: "o1" });
  });

  it("maps IDEMPOTENCY_KEY_CONFLICT to 409", async () => {
    stubEngine({ type: "IDEMPOTENCY_KEY_CONFLICT", payload: { message: "conflict" } });
    const res = await send("/api/v1/order", { method: "POST", body: JSON.stringify(validOrder) });
    assert.equal(res.status, 409);
  });

  it("maps ORDER_REJECTED to 400", async () => {
    stubEngine({ type: "ORDER_REJECTED", payload: { message: "rejected" } });
    const res = await send("/api/v1/order", { method: "POST", body: JSON.stringify(validOrder) });
    assert.equal(res.status, 400);
  });

  it("maps ENGINE_ERROR to 503", async () => {
    stubEngine({ type: "ENGINE_ERROR", payload: { message: "down" } });
    const res = await send("/api/v1/order", { method: "POST", body: JSON.stringify(validOrder) });
    assert.equal(res.status, 503);
  });
});

describe("mocked DELETE /order/:orderId", () => {
  const cancelBody = JSON.stringify({ market: "ACME_USD", userId: "user-1" });

  it("passes cancel success through with 200", async () => {
    stubEngine({ type: "ORDER_CANCELLED", payload: { orderId: "o1" } });
    const res = await send("/api/v1/order/o1", { method: "DELETE", body: cancelBody });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { orderId: "o1" });
  });

  it("maps ORDER_OWNER_MISMATCH to 403", async () => {
    stubEngine({ type: "ORDER_CANCEL_REJECTED", payload: { reason: "ORDER_OWNER_MISMATCH" } });
    const res = await send("/api/v1/order/o1", { method: "DELETE", body: cancelBody });
    assert.equal(res.status, 403);
  });

  it("maps ORDER_NOT_FOUND to 404", async () => {
    stubEngine({ type: "ORDER_CANCEL_REJECTED", payload: { reason: "ORDER_NOT_FOUND" } });
    const res = await send("/api/v1/order/o1", { method: "DELETE", body: cancelBody });
    assert.equal(res.status, 404);
  });

  it("maps ENGINE_ERROR to 503", async () => {
    stubEngine({ type: "ENGINE_ERROR", payload: { message: "down" } });
    const res = await send("/api/v1/order/o1", { method: "DELETE", body: cancelBody });
    assert.equal(res.status, 503);
  });
});

describe("isValidMarket and parseLimit units", () => {
  it("accepts SYMBOL_QUOTE and rejects malformed markets", () => {
    assert.equal(isValidMarket("ACME_USD"), true);
    assert.equal(isValidMarket("BTC_USDT"), true);
    assert.equal(isValidMarket("acme_usd"), false);
    assert.equal(isValidMarket("acme"), false);
    assert.equal(isValidMarket("ACME-USD"), false);
    assert.equal(isValidMarket("A_B_C"), false);
    assert.equal(isValidMarket(""), false);
    assert.equal(isValidMarket(null), false);
    assert.equal(isValidMarket(undefined), false);
    assert.equal(isValidMarket(42), false);
  });

  it("parseLimit honors fallback, integers, and max cap", () => {
    assert.equal(parseLimit(undefined, 25, 100), 25);
    assert.equal(parseLimit("10", 25, 100), 10);
    assert.equal(parseLimit(50, 25, 100), 50);
    assert.equal(parseLimit("1000", 25, 100), 100);
    assert.equal(parseLimit("0", 25, 100), 25);
    assert.equal(parseLimit("-5", 25, 100), 25);
    assert.equal(parseLimit("1.5", 25, 100), 25);
    assert.equal(parseLimit("abc", 25, 100), 25);
  });
});
