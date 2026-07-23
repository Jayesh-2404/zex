import test from "node:test";
import assert from "node:assert/strict";
import { OrderBook, Order } from "./orderbook.js";

function order(overrides: Partial<Order>): Order {
  return {
    id: "order-1",
    price: "10",
    quantity: "1",
    filled: "0",
    side: "buy",
    userId: "user-1",
    ...overrides,
  };
}

test("adds unmatched orders to depth", () => {
  const book = new OrderBook("SOL_USDC");

  book.addOrder(order({ id: "bid-1", price: "10", quantity: "2", side: "buy" }));
  book.addOrder(order({ id: "ask-1", price: "12", quantity: "3", side: "sell" }));

  assert.deepEqual(book.getDepth(), {
    bids: [{ price: "10", quantity: "2" }],
    asks: [{ price: "12", quantity: "3" }],
  });
});

test("matches buy orders against the lowest ask first", () => {
  const book = new OrderBook("SOL_USDC");

  book.addOrder(order({ id: "ask-high", price: "12", quantity: "1", side: "sell", userId: "maker-2" }));
  book.addOrder(order({ id: "ask-low", price: "11", quantity: "1", side: "sell", userId: "maker-1" }));
  const result = book.addOrder(order({ id: "buy-1", price: "12", quantity: "1", side: "buy", userId: "taker" }));

  assert.equal(result.fills.length, 1);
  assert.equal(result.fills[0].makerOrderId, "ask-low");
  assert.equal(result.fills[0].price, "11");
});

test("matches sell orders against the highest bid first", () => {
  const book = new OrderBook("SOL_USDC");

  book.addOrder(order({ id: "bid-low", price: "10", quantity: "1", side: "buy", userId: "maker-1" }));
  book.addOrder(order({ id: "bid-high", price: "12", quantity: "1", side: "buy", userId: "maker-2" }));
  const result = book.addOrder(order({ id: "sell-1", price: "10", quantity: "1", side: "sell", userId: "taker" }));

  assert.equal(result.fills.length, 1);
  assert.equal(result.fills[0].makerOrderId, "bid-high");
  assert.equal(result.fills[0].price, "12");
});

test("leaves remaining quantity on the book after partial fill", () => {
  const book = new OrderBook("SOL_USDC");

  book.addOrder(order({ id: "ask-1", price: "10", quantity: "1", side: "sell", userId: "maker" }));
  const result = book.addOrder(order({ id: "buy-1", price: "10", quantity: "3", side: "buy", userId: "taker" }));

  assert.equal(result.fills.length, 1);
  assert.equal(result.fills[0].quantity, "1");
  assert.deepEqual(book.getDepth(), {
    bids: [{ price: "10", quantity: "2" }],
    asks: [],
  });
});

test("cancels an open order and removes empty price levels", () => {
  const book = new OrderBook("SOL_USDC");

  book.addOrder(order({ id: "bid-1", price: "10", quantity: "2", side: "buy", userId: "maker" }));
  book.addOrder(order({ id: "ask-1", price: "12", quantity: "3", side: "sell", userId: "maker" }));

  const result = book.cancelOrder("bid-1", "maker");

  assert.equal(result.status, "cancelled");
  assert.deepEqual(book.getDepth(), {
    bids: [],
    asks: [{ price: "12", quantity: "3" }],
  });
});

test("rejects cancellation from a different user", () => {
  const book = new OrderBook("SOL_USDC");

  book.addOrder(order({ id: "ask-1", price: "12", quantity: "3", side: "sell", userId: "maker" }));

  const result = book.cancelOrder("ask-1", "other-user");

  assert.equal(result.status, "owner_mismatch");
  assert.deepEqual(book.getDepth(), {
    bids: [],
    asks: [{ price: "12", quantity: "3" }],
  });
});

test("cancels only the remaining quantity after a partial fill", () => {
  const book = new OrderBook("SOL_USDC");

  book.addOrder(order({ id: "ask-1", price: "10", quantity: "1", side: "sell", userId: "maker" }));
  book.addOrder(order({ id: "buy-1", price: "10", quantity: "3", side: "buy", userId: "taker" }));

  const result = book.cancelOrder("buy-1", "taker");

  assert.equal(result.status, "cancelled");
  if (result.status === "cancelled") {
    assert.equal(result.order.quantity, "2");
  }
  assert.deepEqual(book.getDepth(), {
    bids: [],
    asks: [],
  });
});

test("snapshots open orders for durable recovery", () => {
  const book = new OrderBook("SOL_USDC");

  book.addOrder(order({ id: "bid-1", price: "10", quantity: "2", side: "buy", userId: "buyer" }));
  book.addOrder(order({ id: "ask-1", price: "12", quantity: "3", side: "sell", userId: "seller" }));

  assert.deepEqual(book.getOpenOrders(), [
    order({ id: "bid-1", price: "10", quantity: "2", side: "buy", userId: "buyer" }),
    order({ id: "ask-1", price: "12", quantity: "3", side: "sell", userId: "seller" }),
  ]);
});

test("restores open orders without matching them again", () => {
  const book = new OrderBook("SOL_USDC");

  book.restoreOpenOrder(order({ id: "bid-1", price: "10", quantity: "2", side: "buy", userId: "buyer" }));
  book.restoreOpenOrder(order({ id: "ask-1", price: "10", quantity: "3", side: "sell", userId: "seller" }));

  assert.deepEqual(book.getDepth(), {
    bids: [{ price: "10", quantity: "2" }],
    asks: [{ price: "10", quantity: "3" }],
  });
});

test("restores partially filled maker orders with only remaining quantity in depth", () => {
  const book = new OrderBook("SOL_USDC");

  book.restoreOpenOrder(
    order({ id: "ask-1", price: "12", quantity: "3", filled: "1", side: "sell", userId: "seller" }),
  );

  assert.deepEqual(book.getDepth(), {
    bids: [],
    asks: [{ price: "12", quantity: "2" }],
  });
});
