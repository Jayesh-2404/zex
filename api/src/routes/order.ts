import {Request , Response , Router} from "express";
import {RedisManager} from "../redis/redis";

const orderRouter = Router();

type OrderSide = "buy" | "sell";

interface CreateOrderRequest {
  market: string;
  price: string;
  quantity: string;
  side: OrderSide;
  userId: string;
}

interface EngineResponse<T> {
  type: string;
  payload: T;
}

function isPositiveNumberString(value: unknown): value is string {
  if (typeof value !== "string" && typeof value !== "number") {
    return false;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function validateCreateOrder(body: Record<string, unknown>): { order?: CreateOrderRequest; errors?: string[] } {
  const errors: string[] = [];
  const { market, price, quantity, side, userId } = body;

  if (typeof market !== "string" || !/^[A-Z0-9]+_[A-Z0-9]+$/.test(market)) {
    errors.push("market must use SYMBOL_QUOTE format, for example SOL_USDC");
  }
  if (!isPositiveNumberString(price)) {
    errors.push("price must be a positive number");
  }
  if (!isPositiveNumberString(quantity)) {
    errors.push("quantity must be a positive number");
  }
  if (side !== "buy" && side !== "sell") {
    errors.push("side must be buy or sell");
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
      price: String(price),
      quantity: String(quantity),
      side: side as OrderSide,
      userId: (userId as string).trim(),
    },
  };
}

//this api is for creating the order 
orderRouter.post('/' , async(req:Request , res: Response) => {
  try{
    const validation = validateCreateOrder(req.body);
    if (!validation.order) {
      return res.status(400).json({ message: "Invalid order request", errors: validation.errors });
    }

    const {market , price, quantity , side , userId} = validation.order;
    const resp = await RedisManager.getInstance().sendAndWait<EngineResponse<unknown>>({
      type:"CREATE_ORDER",
      data:{
        market,
        price,
        quantity,
        side,
        userId
      }
    })
    //dont understand why we are taking the payload here 
    res.json(resp.payload);
  }catch(error){
    console.log("error in creating order", error);
    res.status(500).json({message:"Internal server error in creating the order"});
  }
})

export default orderRouter;
