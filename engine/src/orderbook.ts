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

export class OrderBook {
  private bids: Map<string, Order[]> = new Map();
  private asks: Map<string, Order[]> = new Map();
  private bidPrices: number[] = [];
  private askPrices: number[] = [];

  constructor(private market: string) {}

  addOrder(order: Order): { fills: Fill[]; remainingOrder?: Order } {
    return order.side === "buy" ? this.matchBuy(order) : this.matchSell(order);
  }

  private matchBuy(order: Order): { fills: Fill[]; remainingOrder?: Order } {
    const fills: Fill[] = [];
    let remainingQty = parseFloat(order.quantity) - parseFloat(order.filled);

    const askPrices = [...this.askPrices];
    for (const askPrice of askPrices) {
      if (remainingQty <= 1e-8 || askPrice > parseFloat(order.price)) break;

      const ordersAtPrice = this.asks.get(askPrice.toString())!;
      const remaining: Order[] = [];

      for (const askOrder of ordersAtPrice) {
        if (remainingQty <= 1e-8) { remaining.push(askOrder); continue; }

        const askRemaining = parseFloat(askOrder.quantity) - parseFloat(askOrder.filled);
        if (askRemaining <= 1e-8) continue;

        const fillQty = Math.min(remainingQty, askRemaining);
        fills.push({
          price: askOrder.price,
          quantity: fillQty.toString(),
          makerOrderId: askOrder.id,
          takerOrderId: order.id,
          makerUserId: askOrder.userId,
          takerUserId: order.userId,
        });

        remainingQty -= fillQty;
        order.filled = (parseFloat(order.filled) + fillQty).toString();
        askOrder.filled = (parseFloat(askOrder.filled) + fillQty).toString();

        if (parseFloat(askOrder.quantity) - parseFloat(askOrder.filled) > 1e-8) {
          remaining.push(askOrder);
        }
      }

      if (remaining.length > 0) {
        this.asks.set(askPrice.toString(), remaining);
      } else {
        this.asks.delete(askPrice.toString());
        this.askPrices = this.askPrices.filter((p) => p !== askPrice);
      }
    }

    if (remainingQty > 1e-8) {
      const remainingOrder: Order = { ...order, quantity: remainingQty.toString(), filled: "0" };
      this.addToBook(remainingOrder, "bids", (a, b) => b - a);
      return { fills, remainingOrder };
    }

    return { fills };
  }

  private matchSell(order: Order): { fills: Fill[]; remainingOrder?: Order } {
    const fills: Fill[] = [];
    let remainingQty = parseFloat(order.quantity) - parseFloat(order.filled);

    const bidPrices = [...this.bidPrices].reverse();
    for (const bidPrice of bidPrices) {
      if (remainingQty <= 1e-8 || bidPrice < parseFloat(order.price)) break;

      const ordersAtPrice = this.bids.get(bidPrice.toString())!;
      const remaining: Order[] = [];

      for (const bidOrder of ordersAtPrice) {
        if (remainingQty <= 1e-8) { remaining.push(bidOrder); continue; }

        const bidRemaining = parseFloat(bidOrder.quantity) - parseFloat(bidOrder.filled);
        if (bidRemaining <= 1e-8) continue;

        const fillQty = Math.min(remainingQty, bidRemaining);
        fills.push({
          price: bidOrder.price,
          quantity: fillQty.toString(),
          makerOrderId: bidOrder.id,
          takerOrderId: order.id,
          makerUserId: bidOrder.userId,
          takerUserId: order.userId,
        });

        remainingQty -= fillQty;
        order.filled = (parseFloat(order.filled) + fillQty).toString();
        bidOrder.filled = (parseFloat(bidOrder.filled) + fillQty).toString();

        if (parseFloat(bidOrder.quantity) - parseFloat(bidOrder.filled) > 1e-8) {
          remaining.push(bidOrder);
        }
      }

      if (remaining.length > 0) {
        this.bids.set(bidPrice.toString(), remaining);
      } else {
        this.bids.delete(bidPrice.toString());
        this.bidPrices = this.bidPrices.filter((p) => p !== bidPrice);
      }
    }

    if (remainingQty > 1e-8) {
      const remainingOrder: Order = { ...order, quantity: remainingQty.toString(), filled: "0" };
      this.addToBook(remainingOrder, "asks", (a, b) => a - b);
      return { fills, remainingOrder };
    }

    return { fills };
  }

  private addToBook(order: Order, side: "bids" | "asks", sortFn: (a: number, b: number) => number): void {
    const price = parseFloat(order.price);
    const key = price.toString();
    const book = side === "bids" ? this.bids : this.asks;
    const priceArr = side === "bids" ? this.bidPrices : this.askPrices;

    if (!book.has(key)) {
      book.set(key, []);
      priceArr.push(price);
      priceArr.sort(sortFn);
    }
    book.get(key)!.push(order);
  }

  getDepth(): DepthSnapshot {
    const bids: { price: string; quantity: string }[] = [];
    const asks: { price: string; quantity: string }[] = [];

    for (const price of this.bidPrices) {
      const orders = this.bids.get(price.toString())!;
      const total = orders.reduce((s, o) => s + (parseFloat(o.quantity) - parseFloat(o.filled)), 0);
      bids.push({ price: price.toString(), quantity: total.toString() });
    }

    for (const price of this.askPrices) {
      const orders = this.asks.get(price.toString())!;
      const total = orders.reduce((s, o) => s + (parseFloat(o.quantity) - parseFloat(o.filled)), 0);
      asks.push({ price: price.toString(), quantity: total.toString() });
    }

    return { bids, asks };
  }
}
