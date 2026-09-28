import test from "node:test";
import assert from "node:assert/strict";
import { buildMarketStats, TickerStatsRow } from "./tickerStats.js";

function row(overrides: Partial<TickerStatsRow> = {}): TickerStatsRow {
  return {
    market: "SOL_USDC",
    first_price: "100",
    last_price: "110.5",
    high: "112",
    low: "99.5",
    volume: "12.5",
    quote_volume: "1350.25",
    trades: "7",
    ...overrides,
  };
}

test("builds no stats from empty input", () => {
  assert.deepEqual(buildMarketStats([]), {});
});

test("converts numeric text columns into MarketStats numbers", () => {
  assert.deepEqual(buildMarketStats([row()]), {
    SOL_USDC: {
      firstPrice: 100,
      lastPrice: 110.5,
      high: 112,
      low: 99.5,
      volume: 12.5,
      quoteVolume: 1350.25,
      trades: 7,
    },
  });
});

test("groups rows per market and tolerates null aggregates", () => {
  const stats = buildMarketStats([
    row({ market: "SOL_USDC" }),
    row({ market: "BTC_USDC", first_price: null, last_price: null, high: null, low: null }),
  ]);

  assert.equal(Object.keys(stats).length, 2);
  assert.equal(stats.BTC_USDC.firstPrice, 0);
  assert.equal(stats.SOL_USDC.trades, 7);
});
