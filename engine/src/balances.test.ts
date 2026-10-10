import test from "node:test";
import assert from "node:assert/strict";
import { VirtualLedger } from "./balances.js";

test("reserves virtual cash for a buy order and releases it on cancellation", () => {
  const ledger = new VirtualLedger([{ userId: "buyer", asset: "USD", available: "1000", locked: "0" }]);
  const order = { id: "buy-1", price: "10", quantity: "5", filled: "0", side: "buy" as const, userId: "buyer" };

  ledger.reserveOrder("ACME_USD", order);
  ledger.reconcileOrderReservation("ACME_USD", order, "0");

  assert.deepEqual(ledger.getBalances("buyer"), [{ userId: "buyer", asset: "USD", available: "1000", locked: "0" }]);
});

test("settles a stock fill between virtual buyer and seller", () => {
  const ledger = new VirtualLedger([
    { userId: "buyer", asset: "USD", available: "0", locked: "50" },
    { userId: "seller", asset: "ACME", available: "0", locked: "5" },
  ]);
  ledger.settleFill("ACME_USD", {
    price: "10",
    quantity: "5",
    makerOrderId: "ask-1",
    takerOrderId: "buy-1",
    makerUserId: "seller",
    takerUserId: "buyer",
  }, "sell");

  assert.deepEqual(ledger.getBalances("buyer"), [
    { userId: "buyer", asset: "ACME", available: "5", locked: "0" },
    { userId: "buyer", asset: "USD", available: "0", locked: "0" },
  ]);
  assert.deepEqual(ledger.getBalances("seller"), [
    { userId: "seller", asset: "ACME", available: "0", locked: "0" },
    { userId: "seller", asset: "USD", available: "50", locked: "0" },
  ]);
});

test("rejects an order that exceeds virtual funds", () => {
  const ledger = new VirtualLedger([{ userId: "buyer", asset: "USD", available: "9", locked: "0" }]);
  assert.throws(
    () => ledger.reserveOrder("ACME_USD", { id: "buy-1", price: "10", quantity: "1", filled: "0", side: "buy", userId: "buyer" }),
    /Insufficient USD balance/,
  );
});

test("restores a snapshot so a failed persist can revert without divergence", () => {
  const ledger = new VirtualLedger([{ userId: "buyer", asset: "USD", available: "1000", locked: "0" }]);
  const snapshot = ledger.getBalances();
  const order = { id: "buy-1", price: "10", quantity: "5", filled: "0", side: "buy" as const, userId: "buyer" };

  ledger.reserveOrder("ACME_USD", order);
  assert.deepEqual(ledger.getBalances("buyer"), [{ userId: "buyer", asset: "USD", available: "950", locked: "50" }]);

  ledger.restore(snapshot);
  assert.deepEqual(ledger.getBalances("buyer"), [{ userId: "buyer", asset: "USD", available: "1000", locked: "0" }]);
  assert.deepEqual(ledger.drainChanges(), []);
});
