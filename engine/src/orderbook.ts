import { fromScaled, minScaled, toScaled } from "./decimal.js";

export interface Order {
  id: string;
  price: string;
  quantity: string;
  filled: string;
  side: "buy" | "sell";
  userId: string;
}

export interface Fill {
  price: string;
  quantity: string;
  makerOrderId: string;
  takerOrderId: string;
  makerUserId: string;
  takerUserId: string;
}

export interface DepthSnapshot {
  bids: { price: string; quantity: string }[];
  asks: { price: string; quantity: string }[];
}

export type CancelOrderResult =
  | { status: "cancelled"; order: Order }
  | { status: "not_found" }
  | { status: "owner_mismatch"; order: Order };

const compareDesc = (a: bigint, b: bigint): number => (a > b ? -1 : a < b ? 1 : 0);
const compareAsc = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);

type PriceSort = typeof compareDesc;

export class OrderBook {
  private bids: Map<string, Order[]> = new Map();
  private asks: Map<string, Order[]> = new Map();
  private bidPrices: bigint[] = [];
  private askPrices: bigint[] = [];

  constructor(private market: string) {}

  addOrder(order: Order): { fills: Fill[]; remainingOrder?: Order } {
    return order.side === "buy" ? this.matchBuy(order) : this.matchSell(order);
  }

  restoreOpenOrder(order: Order): void {
    const side = order.side === "buy" ? "bids" : "asks";
    const sortFn = order.side === "buy" ? compareDesc : compareAsc;
    this.addToBook({ ...order }, side, sortFn);
  }

  getOpenOrders(): Order[] {
    return [
      ...this.bidPrices.flatMap((price) => this.bids.get(fromScaled(price)) ?? []),
      ...this.askPrices.flatMap((price) => this.asks.get(fromScaled(price)) ?? []),
    ].map((order) => ({ ...order }));
  }

  cancelOrder(orderId: string, userId: string): CancelOrderResult {
    return (
      this.cancelFromSide(orderId, userId, "bids") ??
      this.cancelFromSide(orderId, userId, "asks") ??
      { status: "not_found" }
    );
  }

  private matchBuy(order: Order): { fills: Fill[]; remainingOrder?: Order } {
    const fills: Fill[] = [];
    let remainingQty = toScaled(order.quantity) - toScaled(order.filled);
    const limitPrice = toScaled(order.price);

    const askPrices = [...this.askPrices];
    for (const askPrice of askPrices) {
      if (remainingQty <= 0n || askPrice > limitPrice) break;

      const key = fromScaled(askPrice);
      const ordersAtPrice = this.asks.get(key)!;
      const remaining: Order[] = [];

      for (const askOrder of ordersAtPrice) {
        if (remainingQty <= 0n) { remaining.push(askOrder); continue; }

        const askRemaining = toScaled(askOrder.quantity) - toScaled(askOrder.filled);
        if (askRemaining <= 0n) continue;

        const fillQty = minScaled(remainingQty, askRemaining);
        fills.push({
          price: askOrder.price,
          quantity: fromScaled(fillQty),
          makerOrderId: askOrder.id,
          takerOrderId: order.id,
          makerUserId: askOrder.userId,
          takerUserId: order.userId,
        });

        remainingQty -= fillQty;
        order.filled = fromScaled(toScaled(order.filled) + fillQty);
        askOrder.filled = fromScaled(toScaled(askOrder.filled) + fillQty);

        if (askRemaining - fillQty > 0n) {
          remaining.push(askOrder);
        }
      }

      if (remaining.length > 0) {
        this.asks.set(key, remaining);
      } else {
        this.asks.delete(key);
        this.askPrices = this.askPrices.filter((p) => p !== askPrice);
      }
    }

    if (remainingQty > 0n) {
      const remainingOrder: Order = { ...order, quantity: fromScaled(remainingQty), filled: "0" };
      this.addToBook(remainingOrder, "bids", compareDesc);
      return { fills, remainingOrder };
    }

    return { fills };
  }

  private matchSell(order: Order): { fills: Fill[]; remainingOrder?: Order } {
    const fills: Fill[] = [];
    let remainingQty = toScaled(order.quantity) - toScaled(order.filled);
    const limitPrice = toScaled(order.price);

    const bidPrices = [...this.bidPrices];
    for (const bidPrice of bidPrices) {
      if (remainingQty <= 0n || bidPrice < limitPrice) break;

      const key = fromScaled(bidPrice);
      const ordersAtPrice = this.bids.get(key)!;
      const remaining: Order[] = [];

      for (const bidOrder of ordersAtPrice) {
        if (remainingQty <= 0n) { remaining.push(bidOrder); continue; }

        const bidRemaining = toScaled(bidOrder.quantity) - toScaled(bidOrder.filled);
        if (bidRemaining <= 0n) continue;

        const fillQty = minScaled(remainingQty, bidRemaining);
        fills.push({
          price: bidOrder.price,
          quantity: fromScaled(fillQty),
          makerOrderId: bidOrder.id,
          takerOrderId: order.id,
          makerUserId: bidOrder.userId,
          takerUserId: order.userId,
        });

        remainingQty -= fillQty;
        order.filled = fromScaled(toScaled(order.filled) + fillQty);
        bidOrder.filled = fromScaled(toScaled(bidOrder.filled) + fillQty);

        if (bidRemaining - fillQty > 0n) {
          remaining.push(bidOrder);
        }
      }

      if (remaining.length > 0) {
        this.bids.set(key, remaining);
      } else {
        this.bids.delete(key);
        this.bidPrices = this.bidPrices.filter((p) => p !== bidPrice);
      }
    }

    if (remainingQty > 0n) {
      const remainingOrder: Order = { ...order, quantity: fromScaled(remainingQty), filled: "0" };
      this.addToBook(remainingOrder, "asks", compareAsc);
      return { fills, remainingOrder };
    }

    return { fills };
  }

  private addToBook(order: Order, side: "bids" | "asks", sortFn: PriceSort): void {
    const price = toScaled(order.price);
    const key = fromScaled(price);
    const book = side === "bids" ? this.bids : this.asks;
    const priceArr = side === "bids" ? this.bidPrices : this.askPrices;

    if (!book.has(key)) {
      book.set(key, []);
      priceArr.push(price);
      priceArr.sort(sortFn);
    }
    book.get(key)!.push(order);
  }

  private cancelFromSide(orderId: string, userId: string, side: "bids" | "asks"): CancelOrderResult | undefined {
    const book = side === "bids" ? this.bids : this.asks;
    const priceArr = side === "bids" ? this.bidPrices : this.askPrices;

    for (const [price, orders] of book) {
      const index = orders.findIndex((order) => order.id === orderId);
      if (index === -1) {
        continue;
      }

      const order = orders[index];
      if (order.userId !== userId) {
        return { status: "owner_mismatch", order };
      }

      orders.splice(index, 1);
      if (orders.length === 0) {
        book.delete(price);
        const scaledPrice = toScaled(price);
        const priceIndex = priceArr.findIndex((value) => value === scaledPrice);
        if (priceIndex !== -1) {
          priceArr.splice(priceIndex, 1);
        }
      }

      return { status: "cancelled", order };
    }

    return undefined;
  }

  getDepth(): DepthSnapshot {
    const bids: { price: string; quantity: string }[] = [];
    const asks: { price: string; quantity: string }[] = [];

    for (const price of this.bidPrices) {
      const orders = this.bids.get(fromScaled(price))!;
      const total = orders.reduce((s, o) => s + (toScaled(o.quantity) - toScaled(o.filled)), 0n);
      bids.push({ price: fromScaled(price), quantity: fromScaled(total) });
    }

    for (const price of this.askPrices) {
      const orders = this.asks.get(fromScaled(price))!;
      const total = orders.reduce((s, o) => s + (toScaled(o.quantity) - toScaled(o.filled)), 0n);
      asks.push({ price: fromScaled(price), quantity: fromScaled(total) });
    }

    return { bids, asks };
  }
}
