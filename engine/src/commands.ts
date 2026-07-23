import { createHash } from "node:crypto";

export interface CreateOrderCommand {
  market: string;
  price: string;
  quantity: string;
  side: "buy" | "sell";
  userId: string;
}

export function hashCreateOrderCommand(command: CreateOrderCommand): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        market: command.market,
        price: command.price,
        quantity: command.quantity,
        side: command.side,
        userId: command.userId,
      }),
    )
    .digest("hex");
}

export function idempotencyConflictResponse(idempotencyKey: string): object {
  return {
    type: "IDEMPOTENCY_KEY_CONFLICT",
    payload: {
      status: "rejected",
      reason: "IDEMPOTENCY_KEY_CONFLICT",
      message: "Idempotency-Key was already used for a different create-order request",
      idempotencyKey,
    },
  };
}
