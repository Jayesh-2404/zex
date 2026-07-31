import test from "node:test";
import assert from "node:assert/strict";
import { getUserOpenOrders } from "./openOrders.js";

test("filters open orders by market book and user", () => {
  assert.deepEqual(
    getUserOpenOrders(
      "SOL_USDC",
      [
        {
          id: "bid-1",
          price: "10",
          quantity: "2",
          filled: "0",
          side: "buy",
          userId: "user-1",
        },
        {
          id: "ask-1",
          price: "12",
          quantity: "3",
          filled: "1",
          side: "sell",
          userId: "user-2",
        },
      ],
      "user-1",
    ),
    [
      {
        market: "SOL_USDC",
        id: "bid-1",
        price: "10",
        quantity: "2",
        filled: "0",
        side: "buy",
        userId: "user-1",
      },
    ],
  );
});
