// Route-level integration tests for the API surface.
// These cover validation and error paths only, so they run without live
// Redis, Postgres, or engine processes. Valid requests that need the engine
// are deliberately excluded.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { app } from "./app.js";

let baseUrl = "";
let server: ReturnType<typeof app.listen> | undefined;

async function get(path: string): Promise<{ status: number; body: unknown; text: string }> {
  const res = await fetch(`${baseUrl}${path}`);
  const text = await res.text();
  let body: unknown = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  return { status: res.status, body, text };
}

async function send(path: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  return { status: res.status, body };
}

before(async () => {
  server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => {
  server?.close();
});

describe("liveness and health", () => {
  it("answers the liveness probe", async () => {
    const res = await get("/api/v1/test");
    assert.equal(res.status, 200);
    assert.match(res.text, /Test route working/);
  });

  it("reports dependency status without crashing when services are down", async () => {
    const res = await get("/api/v1/health");
    assert.equal(res.status, 200);
    const body = res.body as { api: { status: string }; redis: { status: string }; postgres: { status: string } };
    assert.equal(body.api.status, "ok");
    assert.ok(["ok", "error"].includes(body.redis.status));
    assert.ok(["ok", "error"].includes(body.postgres.status));
  });
});

describe("market data validation", () => {
  it("rejects depth requests without a market symbol", async () => {
    const res = await get("/api/v1/depth");
    assert.equal(res.status, 400);
  });

  it("rejects depth requests with a malformed symbol", async () => {
    const res = await get("/api/v1/depth?symbol=acme");
    assert.equal(res.status, 400);
  });

  it("requires market and userId for open orders", async () => {
    assert.equal((await get("/api/v1/orders/open")).status, 400);
    assert.equal((await get("/api/v1/orders/open?market=bad&userId=user-1")).status, 400);
    assert.equal((await get("/api/v1/orders/open?market=ACME_USD")).status, 400);
    assert.equal((await get("/api/v1/orders/open?market=ACME_USD&userId=%20")).status, 400);
  });

  it("requires userId for balances", async () => {
    assert.equal((await get("/api/v1/balances")).status, 400);
    assert.equal((await get("/api/v1/balances?userId=%20")).status, 400);
  });

  it("rejects recent-trades requests with a malformed market", async () => {
    const res = await get("/api/v1/trades/recent?market=acme");
    assert.equal(res.status, 400);
  });

  it("answers recent-trades for a valid market even when Postgres is down", async () => {
    const res = await get("/api/v1/trades/recent?market=ACME_USD&limit=5");
    assert.ok([200, 503].includes(res.status));
  });
});

describe("klines validation", () => {
  it("rejects unknown intervals", async () => {
    const res = await get("/api/v1/klines?market=ACME_USD&interval=5m&startTime=0&endTime=99");
    assert.equal(res.status, 400);
  });

  it("rejects non-numeric time ranges", async () => {
    const res = await get("/api/v1/klines?market=ACME_USD&interval=1m&startTime=nope&endTime=99");
    assert.equal(res.status, 400);
  });

  it("rejects inverted time ranges", async () => {
    const res = await get("/api/v1/klines?market=ACME_USD&interval=1m&startTime=99&endTime=0");
    assert.equal(res.status, 400);
  });
});

describe("order validation", () => {
  it("rejects an empty order body", async () => {
    const res = await send("/api/v1/order", { method: "POST", body: JSON.stringify({}) });
    assert.equal(res.status, 400);
    const body = res.body as { errors?: string[] };
    assert.ok(Array.isArray(body.errors) && body.errors.length > 0);
  });

  it("rejects malformed markets and sides", async () => {
    const res = await send("/api/v1/order", {
      method: "POST",
      body: JSON.stringify({ market: "acme", price: "10", quantity: "1", side: "hold", userId: "user-1" }),
    });
    assert.equal(res.status, 400);
  });

  it("rejects exponent notation the engine cannot parse", async () => {
    const res = await send("/api/v1/order", {
      method: "POST",
      body: JSON.stringify({ market: "ACME_USD", price: "1e-8", quantity: "1", side: "buy", userId: "user-1" }),
    });
    assert.equal(res.status, 400);
  });

  it("rejects quantities the engine would silently truncate", async () => {
    const res = await send("/api/v1/order", {
      method: "POST",
      body: JSON.stringify({ market: "ACME_USD", price: "10", quantity: "0.123456789", side: "buy", userId: "user-1" }),
    });
    assert.equal(res.status, 400);
  });

  it("rejects malformed idempotency keys before touching the engine", async () => {
    const res = await send("/api/v1/order", {
      method: "POST",
      headers: { "Idempotency-Key": "short" },
      body: JSON.stringify({ market: "ACME_USD", price: "10", quantity: "1", side: "buy", userId: "user-1" }),
    });
    assert.equal(res.status, 400);
  });

  it("rejects cancel requests missing market or user", async () => {
    const missingUser = await send("/api/v1/order/abc", {
      method: "DELETE",
      body: JSON.stringify({ market: "ACME_USD" }),
    });
    assert.equal(missingUser.status, 400);

    const badMarket = await send("/api/v1/order/abc", {
      method: "DELETE",
      body: JSON.stringify({ market: "acme", userId: "user-1" }),
    });
    assert.equal(badMarket.status, 400);
  });
});
