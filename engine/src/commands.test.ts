import test from "node:test";
import assert from "node:assert/strict";
import { hashCreateOrderCommand, idempotencyConflictResponse } from "./commands.js";

test("hashes create-order commands from business fields only", () => {
  const first = hashCreateOrderCommand({
    market: "SOL_USDC",
    price: "10",
    quantity: "2",
    side: "buy",
    userId: "user-1",
  });
  const second = hashCreateOrderCommand({
    market: "SOL_USDC",
    price: "10",
    quantity: "2",
    side: "buy",
    userId: "user-1",
  });
  const differentPrice = hashCreateOrderCommand({
    market: "SOL_USDC",
    price: "11",
    quantity: "2",
    side: "buy",
    userId: "user-1",
  });

  assert.equal(first, second);
  assert.notEqual(first, differentPrice);
});

test("builds a conflict response for reused idempotency keys", () => {
  assert.deepEqual(idempotencyConflictResponse("order-key-1"), {
    type: "IDEMPOTENCY_KEY_CONFLICT",
    payload: {
      status: "rejected",
      reason: "IDEMPOTENCY_KEY_CONFLICT",
      message: "Idempotency-Key was already used for a different create-order request",
      idempotencyKey: "order-key-1",
    },
  });
});
