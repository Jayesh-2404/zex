import { Order } from "./orderbook.js";

export interface UserOpenOrder extends Order {
  market: string;
}

export function getUserOpenOrders(market: string, orders: Order[], userId: string): UserOpenOrder[] {
  return orders
    .filter((order) => order.userId === userId)
    .map((order) => ({
      market,
      ...order,
    }));
}
