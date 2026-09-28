import {Request , Response , Router} from "express";
import {RedisManager} from "../redis/redis";
import { MAX_DECIMAL_PLACES, parsePositiveDecimal } from "../validation/decimal.js";

const orderRouter = Router();

type OrderSide = "buy" | "sell";

interface CreateOrderRequest {
  market: string;
  price: string;
  quantity: string;
  side: OrderSide;
  userId: string;
  idempotencyKey?: string;
}

interface CancelOrderRequest {
  market: string;
  orderId: string;
  userId: string;
}

interface EngineResponse<T> {
  type: string;
  payload: T;
}

interface CancelOrderPayload {
  reason?: "ORDER_OWNER_MISMATCH" | "ORDER_NOT_FOUND";
  [key: string]: unknown;
}

interface ErrorPayload {
  reason?: string;
  [key: string]: unknown;
}

function asBodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" ? body as Record<string, unknown> : {};
}

function readIdempotencyKey(value: unknown): string | undefined {
  const headerValue = Array.isArray(value) ? value[0] : value;

  if (typeof headerValue !== "string" || headerValue.trim().length === 0) {
    return undefined;
  }

  return headerValue.trim();
}

function validateCreateOrder(
  body: Record<string, unknown>,
  idempotencyKey?: string,
): { order?: CreateOrderRequest; errors?: string[] } {
  const errors: string[] = [];
  const { market, price, quantity, side, userId } = body;

  if (typeof market !== "string" || !/^[A-Z0-9]+_[A-Z0-9]+$/.test(market)) {
    errors.push("market must use SYMBOL_QUOTE format, for example SOL_USDC");
  }
  if (parsePositiveDecimal(price) === null) {
    errors.push(`price must be a positive decimal with at most ${MAX_DECIMAL_PLACES} decimal places`);
  }
  if (parsePositiveDecimal(quantity) === null) {
    errors.push(`quantity must be a positive decimal with at most ${MAX_DECIMAL_PLACES} decimal places`);
  }
  if (side !== "buy" && side !== "sell") {
    errors.push("side must be buy or sell");
  }
  if (typeof userId !== "string" || userId.trim().length === 0) {
    errors.push("userId is required");
  }
  if (idempotencyKey !== undefined && !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    errors.push("Idempotency-Key must be 8-128 characters using letters, numbers, dot, underscore, colon, or dash");
  }

  if (errors.length > 0) {
    return { errors };
  }

  return {
    order: {
      market: market as string,
      price: parsePositiveDecimal(price)!,
      quantity: parsePositiveDecimal(quantity)!,
      side: side as OrderSide,
      userId: (userId as string).trim(),
      idempotencyKey,
    },
  };
}

function validateCancelOrder(orderId: unknown, body: Record<string, unknown>): { order?: CancelOrderRequest; errors?: string[] } {
  const errors: string[] = [];
  const { market, userId } = body;

  if (typeof orderId !== "string" || orderId.trim().length === 0) {
    errors.push("orderId is required");
  }
  if (typeof market !== "string" || !/^[A-Z0-9]+_[A-Z0-9]+$/.test(market)) {
    errors.push("market must use SYMBOL_QUOTE format, for example SOL_USDC");
  }
  if (typeof userId !== "string" || userId.trim().length === 0) {
    errors.push("userId is required");
  }

  if (errors.length > 0) {
    return { errors };
  }

  return {
    order: {
      market: market as string,
      orderId: (orderId as string).trim(),
      userId: (userId as string).trim(),
    },
  };
}

//this api is for creating the order 
orderRouter.post('/' , async(req:Request , res: Response) => {
  try{
    const idempotencyKey = readIdempotencyKey(req.header("Idempotency-Key"));
    const validation = validateCreateOrder(asBodyRecord(req.body), idempotencyKey);
    if (!validation.order) {
      return res.status(400).json({ message: "Invalid order request", errors: validation.errors });
    }

    const {market , price, quantity , side , userId} = validation.order;
    const resp = await (await RedisManager.getInstance()).sendAndWait<EngineResponse<ErrorPayload>>({
      type:"CREATE_ORDER",
      data:{
        market,
        price,
        quantity,
        side,
        userId,
        idempotencyKey
      }
    })

    if (resp.type === "IDEMPOTENCY_KEY_CONFLICT") {
      return res.status(409).json(resp.payload);
    }

    if (resp.type === "ENGINE_ERROR") {
      return res.status(503).json(resp.payload);
    }

    res.json(resp.payload);
  }catch(error){
    console.log("error in creating order", error);
    res.status(500).json({message:"Internal server error in creating the order"});
  }
})

orderRouter.delete('/:orderId' , async(req:Request , res: Response) => {
  try{
    const validation = validateCancelOrder(req.params.orderId, asBodyRecord(req.body));
    if (!validation.order) {
      return res.status(400).json({ message: "Invalid cancel order request", errors: validation.errors });
    }

    const { market, orderId, userId } = validation.order;
    const resp = await (await RedisManager.getInstance()).sendAndWait<EngineResponse<CancelOrderPayload>>({
      type:"CANCEL_ORDER",
      data:{
        market,
        orderId,
        userId
      }
    })

    if (resp.type === "ORDER_CANCEL_REJECTED") {
      const status = resp.payload.reason === "ORDER_OWNER_MISMATCH" ? 403 : 404;
      return res.status(status).json(resp.payload);
    }

    if (resp.type === "ENGINE_ERROR") {
      return res.status(503).json(resp.payload);
    }

    res.json(resp.payload);
  }catch(error){
    console.log("error in cancelling order", error);
    res.status(500).json({message:"Internal server error in cancelling the order"});
  }
})

export default orderRouter;
