import { createClient } from "redis";
import { v4 as uuidv4 } from "uuid";
import { OrderBook, Order } from "./orderbook.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const QUEUE_KEY = "message";

const orderBooks = new Map<string, OrderBook>();

function getOrderBook(market: string): OrderBook {
  if (!orderBooks.has(market)) {
    orderBooks.set(market, new OrderBook(market));
  }
  return orderBooks.get(market)!;
}

async function startEngine() {
  const client = createClient({ url: REDIS_URL });
  await client.connect();
  console.log("Engine connected to Redis");

  for (;;) {
    try {
      const result = await client.brPop(QUEUE_KEY, 0);
      if (!result) continue;

      const { clientId, message } = JSON.parse(result.element);
      const { type, data } = message;

      let response: object;

      switch (type) {
        case "CREATE_ORDER": {
          const book = getOrderBook(data.market);
          const order: Order = {
            id: uuidv4(),
            price: data.price,
            quantity: data.quantity,
            filled: "0",
            side: data.side,
            userId: data.userId,
          };
          const result = book.addOrder(order);

          const totalFilled = parseFloat(order.filled);
          const totalQty = parseFloat(order.quantity);
          const status = totalFilled >= totalQty - 1e-8 ? "filled" : totalFilled > 0 ? "partial" : "open";

          response = {
            type: "ORDER_CREATED",
            payload: {
              orderId: order.id,
              market: data.market,
              price: data.price,
              quantity: data.quantity,
              filled: order.filled,
              side: data.side,
              status,
              fills: result.fills,
            },
          };
          break;
        }
        case "GET_DEPTH": {
          const book = getOrderBook(data.market);
          const depth = book.getDepth();
          response = { type: "DEPTH", payload: { market: data.market, ...depth } };
          break;
        }
        default:
          response = { type: "ERROR", payload: { message: `Unknown type: ${type}` } };
      }

      await client.publish(clientId, JSON.stringify(response));
    } catch (error) {
      console.error("Engine error:", error);
    }
  }
}

startEngine().catch(console.error);
