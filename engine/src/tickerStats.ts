export interface MarketStats {
  firstPrice?: number;
  lastPrice?: number;
  high?: number;
  low?: number;
  volume: number;
  quoteVolume: number;
  trades: number;
}

export interface TickerTick {
  at: number;
  price: number;
  quantity: number;
}

export interface TickerState {
  ticks: TickerTick[];
  stats: MarketStats;
}

export interface TickerTickRow {
  market: string;
  price: string;
  quantity: string;
  created_at: Date | string;
}

export const TICKER_WINDOW_MS = 24 * 60 * 60 * 1000;

function emptyStats(): MarketStats {
  return { volume: 0, quoteVolume: 0, trades: 0 };
}

function applyTick(stats: MarketStats, price: number, quantity: number): void {
  stats.firstPrice ??= price;
  stats.lastPrice = price;
  stats.high = stats.high === undefined ? price : Math.max(stats.high, price);
  stats.low = stats.low === undefined ? price : Math.min(stats.low, price);
  stats.volume += quantity;
  stats.quoteVolume += price * quantity;
  stats.trades += 1;
}

/**
 * Rolling 24h ticker. Ticks are kept so that expiring one updates `firstPrice`
 * and, when the expiring tick held the extreme, `high` and `low` as well.
 * Aggregates are recomputed only when a tick actually leaves the window.
 */
export class TickerWindow {
  private ticks: TickerTick[] = [];
  private stats: MarketStats = emptyStats();
  private readonly windowMs: number;

  constructor(
    windowMs: number = TICKER_WINDOW_MS,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.windowMs = windowMs;
  }

  add(price: number, quantity: number, at: number = this.now()): void {
    if (!Number.isFinite(price) || !Number.isFinite(quantity) || price <= 0 || quantity <= 0) {
      return;
    }

    this.ticks.push({ at, price, quantity });
    applyTick(this.stats, price, quantity);
    this.expire(at);
  }

  seed(ticks: TickerTick[]): void {
    this.ticks = [];
    this.stats = emptyStats();

    for (const tick of [...ticks].sort((a, b) => a.at - b.at)) {
      this.add(tick.price, tick.quantity, tick.at);
    }

    this.expire(this.now());
  }

  snapshot(): MarketStats {
    this.expire(this.now());
    return { ...this.stats };
  }

  clone(): TickerState {
    return {
      ticks: this.ticks.map((tick) => ({ ...tick })),
      stats: { ...this.stats },
    };
  }

  restore(state: TickerState): void {
    this.ticks = state.ticks.map((tick) => ({ ...tick }));
    this.stats = { ...state.stats };
  }

  get tradeCount(): number {
    return this.ticks.length;
  }

  private expire(at: number): void {
    const cutoff = at - this.windowMs;
    let expired = 0;

    while (expired < this.ticks.length && this.ticks[expired].at <= cutoff) {
      expired += 1;
    }

    if (expired === 0) {
      return;
    }

    this.ticks.splice(0, expired);
    this.recompute();
  }

  private recompute(): void {
    const stats = emptyStats();
    for (const tick of this.ticks) {
      applyTick(stats, tick.price, tick.quantity);
    }
    this.stats = stats;
  }
}
