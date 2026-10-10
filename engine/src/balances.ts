import { Fill, Order } from "./orderbook.js";
import { fromScaled, SCALE, toScaled } from "./decimal.js";

export interface Balance {
  userId: string;
  asset: string;
  available: string;
  locked: string;
}

export interface BalanceChange {
  userId: string;
  asset: string;
  availableDelta: string;
  lockedDelta: string;
  reason: string;
  orderId?: string;
}

type MutableBalance = { available: bigint; locked: bigint };

function quoteNotional(price: string, quantity: string): bigint {
  return (toScaled(price) * toScaled(quantity)) / SCALE;
}

function splitMarket(market: string): { symbol: string; quote: string } {
  const [symbol, quote] = market.split("_");
  if (!symbol || !quote) {
    throw new Error(`Invalid stock symbol: ${market}`);
  }
  return { symbol, quote };
}

export class VirtualLedger {
  private balances = new Map<string, MutableBalance>();
  private changes: BalanceChange[] = [];

  constructor(initialBalances: Balance[] = []) {
    for (const balance of initialBalances) {
      this.balances.set(this.key(balance.userId, balance.asset), {
        available: toScaled(balance.available),
        locked: toScaled(balance.locked),
      });
    }
  }

  getBalances(userId?: string): Balance[] {
    const entries = [...this.balances.entries()]
      .filter(([key]) => !userId || key.startsWith(`${userId}:`))
      .map(([key, value]) => {
        const [owner, asset] = key.split(":");
        return {
          userId: owner,
          asset,
          available: fromScaled(value.available),
          locked: fromScaled(value.locked),
        };
      });
    return entries.sort((a, b) => a.asset.localeCompare(b.asset));
  }

  reserveOrder(market: string, order: Order): void {
    const { symbol, quote } = splitMarket(market);
    const asset = order.side === "buy" ? quote : symbol;
    const amount = order.side === "buy" ? quoteNotional(order.price, order.quantity) : toScaled(order.quantity);
    this.moveAvailableToLocked(order.userId, asset, amount, "order_reserved", order.id);
  }

  settleFill(market: string, fill: Fill, makerSide: Order["side"]): void {
    const { symbol, quote } = splitMarket(market);
    const quantity = toScaled(fill.quantity);
    const notional = quoteNotional(fill.price, fill.quantity);
    const buyer = makerSide === "buy" ? fill.makerUserId : fill.takerUserId;
    const seller = makerSide === "sell" ? fill.makerUserId : fill.takerUserId;

    this.debitLocked(buyer, quote, notional, "trade_settled", fill.takerOrderId);
    this.debitLocked(seller, symbol, quantity, "trade_settled", fill.takerOrderId);
    this.creditAvailable(seller, quote, notional, "trade_settled", fill.takerOrderId);
    this.creditAvailable(buyer, symbol, quantity, "trade_settled", fill.takerOrderId);
  }

  reconcileOrderReservation(market: string, order: Order, remainingQuantity: string): void {
    const { symbol, quote } = splitMarket(market);
    const asset = order.side === "buy" ? quote : symbol;
    const desired = remainingQuantity === "0"
      ? 0n
      : order.side === "buy"
        ? quoteNotional(order.price, remainingQuantity)
        : toScaled(remainingQuantity);
    const balance = this.getMutable(order.userId, asset);
    const difference = balance.locked - desired;

    if (difference > 0n) {
      balance.locked -= difference;
      balance.available += difference;
      this.record(order.userId, asset, difference, -difference, "reservation_released", order.id);
    } else if (difference < 0n) {
      const amount = -difference;
      if (balance.available < amount) {
        throw new Error(`Insufficient ${asset} balance for order reservation`);
      }
      balance.available -= amount;
      balance.locked += amount;
      this.record(order.userId, asset, -amount, amount, "reservation_adjusted", order.id);
    }
  }

  drainChanges(): BalanceChange[] {
    const changes = this.changes;
    this.changes = [];
    return changes;
  }

  restore(balances: Balance[]): void {
    this.balances.clear();
    for (const balance of balances) {
      this.balances.set(this.key(balance.userId, balance.asset), {
        available: toScaled(balance.available),
        locked: toScaled(balance.locked),
      });
    }
    this.changes = [];
  }

  private key(userId: string, asset: string): string {
    return `${userId}:${asset}`;
  }

  private getMutable(userId: string, asset: string): MutableBalance {
    const key = this.key(userId, asset);
    if (!this.balances.has(key)) {
      this.balances.set(key, { available: 0n, locked: 0n });
    }
    return this.balances.get(key)!;
  }

  private moveAvailableToLocked(userId: string, asset: string, amount: bigint, reason: string, orderId: string): void {
    const balance = this.getMutable(userId, asset);
    if (balance.available < amount) {
      throw new Error(`Insufficient ${asset} balance`);
    }
    balance.available -= amount;
    balance.locked += amount;
    this.record(userId, asset, -amount, amount, reason, orderId);
  }

  private debitLocked(userId: string, asset: string, amount: bigint, reason: string, orderId: string): void {
    const balance = this.getMutable(userId, asset);
    if (balance.locked < amount) {
      throw new Error(`Insufficient locked ${asset} balance`);
    }
    balance.locked -= amount;
    this.record(userId, asset, "0", -amount, reason, orderId);
  }

  private creditAvailable(userId: string, asset: string, amount: bigint, reason: string, orderId: string): void {
    const balance = this.getMutable(userId, asset);
    balance.available += amount;
    this.record(userId, asset, amount, "0", reason, orderId);
  }

  private record(
    userId: string,
    asset: string,
    availableDelta: bigint | string,
    lockedDelta: bigint | string,
    reason: string,
    orderId?: string,
  ): void {
    this.changes.push({
      userId,
      asset,
      availableDelta: typeof availableDelta === "string" ? availableDelta : fromScaled(availableDelta),
      lockedDelta: typeof lockedDelta === "string" ? lockedDelta : fromScaled(lockedDelta),
      reason,
      orderId,
    });
  }
}
