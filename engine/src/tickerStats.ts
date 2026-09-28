export interface MarketStats {
  firstPrice?: number;
  lastPrice?: number;
  high?: number;
  low?: number;
  volume: number;
  quoteVolume: number;
  trades: number;
}

export interface TickerStatsRow {
  market: string;
  first_price: string | null;
  last_price: string | null;
  high: string | null;
  low: string | null;
  volume: string | null;
  quote_volume: string | null;
  trades: string;
}

function toNumber(value: string | null): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function buildMarketStats(rows: TickerStatsRow[]): Record<string, MarketStats> {
  const statsByMarket: Record<string, MarketStats> = {};

  for (const row of rows) {
    statsByMarket[row.market] = {
      firstPrice: toNumber(row.first_price),
      lastPrice: toNumber(row.last_price),
      high: toNumber(row.high),
      low: toNumber(row.low),
      volume: toNumber(row.volume),
      quoteVolume: toNumber(row.quote_volume),
      trades: toNumber(row.trades),
    };
  }

  return statsByMarket;
}
