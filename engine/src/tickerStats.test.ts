import test from "node:test";
import assert from "node:assert/strict";
import { TICKER_WINDOW_MS, TickerWindow } from "./tickerStats.js";

const HOUR = 60 * 60 * 1000;

function windowAt(clock: { now: number }): TickerWindow {
  return new TickerWindow(TICKER_WINDOW_MS, () => clock.now);
}

test("reports empty stats before any trade", () => {
  const clock = { now: 0 };
  assert.deepEqual(windowAt(clock).snapshot(), { volume: 0, quoteVolume: 0, trades: 0 });
});

test("accumulates volume, quote volume and trade count", () => {
  const clock = { now: 0 };
  const window = windowAt(clock);

  window.add(100, 2, 0);
  window.add(110, 1, 1000);

  assert.deepEqual(window.snapshot(), {
    firstPrice: 100,
    lastPrice: 110,
    high: 110,
    low: 100,
    volume: 3,
    quoteVolume: 310,
    trades: 2,
  });
});

test("ignores non-positive and non-finite fills", () => {
  const clock = { now: 0 };
  const window = windowAt(clock);

  window.add(0, 1, 0);
  window.add(100, 0, 0);
  window.add(Number.NaN, 1, 0);

  assert.equal(window.snapshot().trades, 0);
});

test("drops a fill once it is older than the window", () => {
  const clock = { now: 0 };
  const window = windowAt(clock);

  window.add(100, 2, 0);
  clock.now = TICKER_WINDOW_MS + 1;

  const stats = window.snapshot();
  assert.equal(stats.trades, 0);
  assert.equal(stats.volume, 0);
  assert.equal(stats.firstPrice, undefined);
});

test("expires stale fills on read even when no new fill arrives", () => {
  const clock = { now: 0 };
  const window = windowAt(clock);
  window.add(100, 1, 0);

  clock.now = TICKER_WINDOW_MS - 1;
  assert.equal(window.snapshot().trades, 1);

  clock.now = TICKER_WINDOW_MS + 1;
  assert.equal(window.snapshot().trades, 0);
});

test("recomputes extremes when the trade holding them leaves the window", () => {
  const clock = { now: 0 };
  const window = windowAt(clock);

  window.add(200, 1, 0);
  window.add(100, 1, 1 * HOUR);
  window.add(101, 1, 2 * HOUR);
  clock.now = 24.5 * HOUR;

  const stats = window.snapshot();
  assert.equal(stats.trades, 2);
  assert.equal(stats.firstPrice, 100);
  assert.equal(stats.high, 101);
  assert.equal(stats.low, 100);
});

test("seeds from persisted ticks in timestamp order", () => {
  const clock = { now: 2 * HOUR };
  const window = windowAt(clock);

  window.seed([
    { at: 2 * HOUR, price: 102, quantity: 2 },
    { at: 1 * HOUR, price: 101, quantity: 1 },
  ]);

  const stats = window.snapshot();
  assert.equal(stats.firstPrice, 101);
  assert.equal(stats.lastPrice, 102);
  assert.equal(stats.trades, 2);
  assert.equal(stats.volume, 3);
  assert.equal(stats.quoteVolume, 305);
});

test("clone and restore revert a partial mutation", () => {
  const clock = { now: 0 };
  const window = windowAt(clock);

  window.add(100, 1, 0);
  const saved = window.clone();
  window.add(200, 1, 1);
  assert.equal(window.snapshot().trades, 2);

  window.restore(saved);

  const restored = window.snapshot();
  assert.equal(restored.trades, 1);
  assert.equal(restored.lastPrice, 100);
  assert.equal(restored.high, 100);
});
