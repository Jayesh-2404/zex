#!/usr/bin/env node
// Live end-to-end verification for the zex demo stack.
//
// Flow: reset the stack to a deterministic seed (docker compose down -v),
// boot it (docker compose up -d --build), wait for /api/v1/health, then:
//   1. place a limit buy that crosses the seeded ACME_USD book (12 x 10 resting
//      sell owned by user-2) and assert it fills against that resting order;
//   2. assert the resulting trade row, its 1m kline, the depth update and the
//      exact balance movements via API reads;
//   3. place a non-crossing buy and cancel it, asserting the reservation is
//      released (balances and book return to their pre-order state).
//
// Plain Node >= 18 (global fetch), no dependencies, Windows-friendly.
//
// Usage:
//   node scripts/e2e-live.mjs                   # reset + boot + verify
//   node scripts/e2e-live.mjs --no-compose      # verify an already-running stack
//   node scripts/e2e-live.mjs --base-url http://localhost:3000
//
// Exits 0 and prints a compact PASS summary with observed values; exits 1 with
// a clear message on the first failed assertion (or on a boot/compose problem).
// `--no-compose` expects a freshly seeded stack; run `docker compose down -v`
// before any run that follows earlier trading activity.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const readOpt = (name, fallback) => {
  const index = args.indexOf(name);
  return index !== -1 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

if (hasFlag("--help") || hasFlag("-h")) {
  console.log(`Usage: node scripts/e2e-live.mjs [options]

Boots the zex compose stack from a clean slate and verifies the live
place -> fill -> trade/kline/balances -> rest -> cancel path over HTTP.

Options:
  --no-compose              skip docker compose down -v / up; verify a running stack
  --base-url <url>          API base URL (default http://localhost:3000)
  --health-timeout <secs>   how long to wait for /api/v1/health (default 120)
  --help                    show this help`);
  process.exit(0);
}

const BASE_URL = readOpt("--base-url", "http://localhost:3000").replace(/\/+$/, "");
const SKIP_COMPOSE = hasFlag("--no-compose");
const healthSeconds = Number(readOpt("--health-timeout", "120"));
const HEALTH_TIMEOUT_MS = (Number.isFinite(healthSeconds) && healthSeconds > 0 ? healthSeconds : 120) * 1000;

const MARKET = "ACME_USD";
const USER1 = "user-1";
const USER2 = "user-2";
const BUY_PRICE = "12"; // equal to the seeded resting sell, so the buy crosses
const BUY_QTY = "1";
const REST_PRICE = "5"; // below every ask: rests without filling
const REST_QTY = "2";
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const summary = [];
let assertions = 0;

function check(condition, message, observed) {
  assertions += 1;
  if (!condition) {
    const detail = observed === undefined ? "" : ` (observed: ${format(observed)})`;
    throw new Error(`FAILED: ${message}${detail}`);
  }
}

function format(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) {
    return String(value);
  }
  return text.length > 400 ? `${text.slice(0, 400)}...` : text;
}

function record(label, value) {
  summary.push([label, value]);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(method, pathname, { body, headers } = {}) {
  const response = await fetch(BASE_URL + pathname, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = text === "" ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json, text };
}

async function getJson(pathname) {
  const response = await request("GET", pathname);
  check(response.status === 200, `GET ${pathname} returned HTTP ${response.status}`, response.json ?? response.text);
  return response.json;
}

async function pollFor(fn, predicate, description, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (predicate(value)) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(`FAILED: ${description} did not appear within ${timeoutMs / 1000}s (last: ${format(value)})`);
    }
    await sleep(250);
  }
}

const balances = async (userId) => {
  const rows = await getJson(`/api/v1/balances?userId=${encodeURIComponent(userId)}`);
  check(Array.isArray(rows), `balances for ${userId} was not an array`, rows);
  return rows;
};

const rowOf = (rows, userId, asset) => rows.find((row) => row.userId === userId && row.asset === asset) ?? null;
const total = (row) => Number(row.available) + Number(row.locked);
const flow = (row) => `${row.available} available / ${row.locked} locked`;

const depth = () => getJson(`/api/v1/depth?symbol=${MARKET}`);
const level = (snapshot, side, price) => (snapshot?.[side] ?? []).find((entry) => entry.price === price) ?? null;

const recentTrades = () => getJson(`/api/v1/trades/recent?market=${MARKET}&limit=100`);
const openOrders = (userId) => getJson(`/api/v1/orders/open?market=${MARKET}&userId=${encodeURIComponent(userId)}`);

async function klinesBetween(fromSeconds, toSeconds) {
  const rows = await getJson(
    `/api/v1/klines?market=${MARKET}&interval=1m&startTime=${fromSeconds}&endTime=${toSeconds}`,
  );
  check(Array.isArray(rows), "klines response was not an array", rows);
  return rows;
}

async function waitForHealth() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let last;
  while (Date.now() < deadline) {
    try {
      const response = await request("GET", "/api/v1/health");
      last = response.json ?? response.text;
      const health = response.json;
      if (
        response.status === 200 &&
        health?.api?.status === "ok" &&
        health?.redis?.status === "ok" &&
        health?.postgres?.status === "ok"
      ) {
        return health;
      }
    } catch (error) {
      last = error?.message ?? String(error);
    }
    await sleep(1000);
  }
  throw new Error(
    `FAILED: ${BASE_URL}/api/v1/health was not ok within ${HEALTH_TIMEOUT_MS / 1000}s` +
      ` (last: ${format(last)}) - is the stack up and TCP port ${baseUrlPort()} free?`,
  );
}

function baseUrlPort() {
  try {
    return new URL(BASE_URL).port || (BASE_URL.startsWith("https") ? "443" : "80");
  } catch {
    return "3000";
  }
}

function requireDocker() {
  const version = spawnSync("docker", ["--version"], { encoding: "utf8", cwd: ROOT });
  if (version.error) {
    throw new Error(
      `FAILED: Docker CLI not available (${version.error.message}) - install Docker Desktop` +
        ` so \`docker\` is on PATH, or verify an already-running stack with --no-compose`,
    );
  }
  check(version.status === 0, "docker --version failed", (version.stderr || version.stdout || "").trim());
  const compose = spawnSync("docker", ["compose", "version"], { encoding: "utf8", cwd: ROOT });
  if (compose.error || compose.status !== 0) {
    throw new Error(
      `FAILED: the docker compose plugin is not available (${format(
        (compose.stderr || compose.stdout || compose.error?.message || "").trim(),
      )})`,
    );
  }
  return { docker: version.stdout.trim(), compose: compose.stdout.trim() };
}

function runCompose(composeArgs) {
  console.log(`> docker ${composeArgs.join(" ")}`);
  const result = spawnSync("docker", composeArgs, { stdio: "inherit", cwd: ROOT });
  if (result.error) {
    throw new Error(`FAILED: could not run "docker ${composeArgs.join(" ")}": ${result.error.message}`);
  }
  check(result.status === 0, `"docker ${composeArgs.join(" ")}" exited with code ${result.status}`);
}

async function main() {
  console.log("zex live e2e: place -> fill -> cancel against the demo stack");

  if (SKIP_COMPOSE) {
    console.log("--no-compose: verifying the stack that is already running (must be freshly seeded)");
  } else {
    const versions = requireDocker();
    record("docker", `${versions.docker}; ${versions.compose}`);
    runCompose(["compose", "down", "-v"]); // documented demo reset: wipes the volumes
    runCompose(["compose", "up", "-d", "--build"]);
  }

  const health = await waitForHealth();
  record("health", `api=${health.api.status} redis=${health.redis.status} postgres=${health.postgres.status}`);
  console.log("health ok; running assertions");

  // -- fresh-seed preconditions -------------------------------------------------
  const before = {
    user1: await balances(USER1),
    user2: await balances(USER2),
    depth: await depth(),
    trades: await recentTrades(),
  };

  const u1UsdBefore = rowOf(before.user1, USER1, "USD");
  const u1AcmeBefore = rowOf(before.user1, USER1, "ACME");
  const u2UsdBefore = rowOf(before.user2, USER2, "USD");
  const u2AcmeBefore = rowOf(before.user2, USER2, "ACME");
  check(
    u1UsdBefore && u1AcmeBefore && u2UsdBefore && u2AcmeBefore,
    "seed balances missing for user-1/user-2",
    { user1: before.user1, user2: before.user2 },
  );
  check(
    u1UsdBefore.available === "99900" && u1UsdBefore.locked === "100",
    "stack is not freshly seeded: user-1 USD expected 99900 available / 100 locked - run `docker compose down -v` first",
    flow(u1UsdBefore),
  );
  check(
    u2AcmeBefore.available === "990" && u2AcmeBefore.locked === "10",
    "stack is not freshly seeded: user-2 ACME expected 990 available / 10 locked - run `docker compose down -v` first",
    flow(u2AcmeBefore),
  );

  const seedAsk = level(before.depth, "asks", BUY_PRICE);
  check(
    seedAsk?.quantity === "10",
    `seeded ask ${BUY_PRICE} x 10 not found in depth - run \`docker compose down -v\` first`,
    before.depth,
  );
  check(level(before.depth, "bids", "10")?.quantity === "10", "seeded bid 10 x 10 not found in depth", before.depth);
  check(
    before.trades.some((trade) => trade.makerOrderId === "demo-trade-sell-1") &&
      before.trades.some((trade) => trade.makerOrderId === "demo-trade-sell-2"),
    "seeded demo trades not found - run `docker compose down -v` first",
    before.trades.map((trade) => trade.id),
  );
  record(
    "seed",
    `user-1 USD ${flow(u1UsdBefore)}, user-2 ACME ${flow(u2AcmeBefore)}, ask ${BUY_PRICE} x 10, bid 10 x 10, ${before.trades.length} demo trades`,
  );

  const klineFrom = Math.floor(Date.now() / 1000) - 180;
  const klineTo = Math.ceil(Date.now() / 1000) + 240;
  const klinesBefore = new Map((await klinesBetween(klineFrom, klineTo)).map((candle) => [candle.start, candle]));

  // -- 1. crossing order: buy 1 @ 12 must fill against seeded demo-sell-1 --------
  const created = await request("POST", "/api/v1/order", {
    body: { market: MARKET, price: BUY_PRICE, quantity: BUY_QTY, side: "buy", userId: USER1 },
    headers: { "Idempotency-Key": `e2e-live-cross-${RUN_ID}` },
  });
  check(created.status === 200, "crossing order was rejected", created.json ?? created.text);
  const order = created.json;
  check(
    order?.status === "filled" && order.filled === BUY_QTY && order.side === "buy" &&
      order.price === BUY_PRICE && order.quantity === BUY_QTY,
    `crossing buy did not fill exactly ${BUY_QTY} @ ${BUY_PRICE}`,
    order,
  );
  check(Array.isArray(order.fills) && order.fills.length === 1, "expected exactly one fill", order.fills);
  const fill = order.fills[0];
  check(
    fill.price === BUY_PRICE && fill.quantity === BUY_QTY && fill.makerOrderId === "demo-sell-1" &&
      fill.makerUserId === USER2 && fill.takerOrderId === order.orderId && fill.takerUserId === USER1,
    "fill does not match the seeded resting sell",
    fill,
  );
  record(
    "crossing order",
    `buy ${BUY_QTY} @ ${BUY_PRICE} ${USER1} -> ${order.orderId} status=${order.status} filled=${order.filled}, fills=${order.fills.length}`,
  );

  // -- trade row -----------------------------------------------------------------
  const tradesNow = await pollFor(
    recentTrades,
    (rows) => rows.some((trade) => trade.takerOrderId === order.orderId),
    "trade row for the taker order",
  );
  const trade = tradesNow.find((entry) => entry.takerOrderId === order.orderId);
  check(
    trade.price === BUY_PRICE && trade.quantity === BUY_QTY && trade.makerOrderId === "demo-sell-1" &&
      trade.makerUserId === USER2 && trade.takerUserId === USER1 && trade.takerSide === "buy",
    "trade row does not match the reported fill",
    trade,
  );
  const newTrades = tradesNow.filter((entry) => !before.trades.some((old) => old.id === entry.id));
  check(newTrades.length === 1, "expected exactly one new trade row", newTrades.map((entry) => entry.id));
  record(
    "trade",
    `#${trade.id} ${trade.quantity} @ ${trade.price} maker=${trade.makerOrderId} (${trade.makerUserId}) taker=${trade.takerUserId} side=${trade.takerSide}`,
  );

  // -- 1m kline ------------------------------------------------------------------
  const klinesAfter = new Map((await klinesBetween(klineFrom, klineTo)).map((candle) => [candle.start, candle]));
  const changedCandles = [...klinesAfter.values()].filter(
    (candle) => !klinesBefore.has(candle.start) || Number(candle.volume) !== Number(klinesBefore.get(candle.start).volume),
  );
  check(
    changedCandles.length === 1,
    "expected exactly one changed 1m candle in the run window",
    { before: [...klinesBefore.keys()], after: [...klinesAfter.keys()] },
  );
  const candle = changedCandles[0];
  check(Number(candle.close) === 12, "1m candle close is not the fill price 12", candle);
  if (klinesBefore.has(candle.start)) {
    const previous = klinesBefore.get(candle.start);
    check(
      Number(candle.volume) - Number(previous.volume) === 1 && Number(candle.trades) - Number(previous.trades) === 1,
      "existing 1m candle did not absorb exactly one fill",
      { before: previous, after: candle },
    );
  } else {
    check(
      Number(candle.open) === 12 && Number(candle.high) === 12 && Number(candle.low) === 12 &&
        Number(candle.volume) === 1 && Number(candle.quoteVolume) === 12 && Number(candle.trades) === 1,
      "new 1m candle does not match the single 1 @ 12 fill",
      candle,
    );
  }
  record(
    "kline 1m",
    `${candle.start} o/h/l/c ${candle.open}/${candle.high}/${candle.low}/${candle.close} volume ${candle.volume} quote ${candle.quoteVolume} trades ${candle.trades}`,
  );

  // -- balances and book after the fill ------------------------------------------
  const afterFillUser1 = await balances(USER1);
  const afterFillUser2 = await balances(USER2);
  const u1UsdAfter = rowOf(afterFillUser1, USER1, "USD");
  const u1AcmeAfter = rowOf(afterFillUser1, USER1, "ACME");
  const u2UsdAfter = rowOf(afterFillUser2, USER2, "USD");
  const u2AcmeAfter = rowOf(afterFillUser2, USER2, "ACME");
  check(u1UsdAfter && u1AcmeAfter && u2UsdAfter && u2AcmeAfter, "post-fill balances missing", {
    user1: afterFillUser1,
    user2: afterFillUser2,
  });
  check(
    total(u1UsdAfter) === total(u1UsdBefore) - 12,
    "buyer USD total did not decrease by the 12 paid",
    { before: flow(u1UsdBefore), after: flow(u1UsdAfter) },
  );
  check(
    total(u1AcmeAfter) === total(u1AcmeBefore) + 1,
    "buyer ACME total did not increase by the 1 bought",
    { before: flow(u1AcmeBefore), after: flow(u1AcmeAfter) },
  );
  check(
    total(u2UsdAfter) === total(u2UsdBefore) + 12,
    "seller USD total did not increase by the 12 received",
    { before: flow(u2UsdBefore), after: flow(u2UsdAfter) },
  );
  check(
    total(u2AcmeAfter) === total(u2AcmeBefore) - 1,
    "seller ACME total did not decrease by the 1 sold",
    { before: flow(u2AcmeBefore), after: flow(u2AcmeAfter) },
  );
  check(u2AcmeAfter.locked === "9", "seller ACME locked did not settle from 10 to 9", flow(u2AcmeAfter));
  record("balances user-1", `USD ${flow(u1UsdBefore)} -> ${flow(u1UsdAfter)} (total ${total(u1UsdBefore)} -> ${total(u1UsdAfter)}); ACME ${flow(u1AcmeBefore)} -> ${flow(u1AcmeAfter)}`);
  record("balances user-2", `USD ${flow(u2UsdBefore)} -> ${flow(u2UsdAfter)}; ACME ${flow(u2AcmeBefore)} -> ${flow(u2AcmeAfter)}`);

  const depthAfterFill = await depth();
  check(
    level(depthAfterFill, "asks", BUY_PRICE)?.quantity === "9",
    "ask 12 did not shrink from 10 to 9 after the fill",
    depthAfterFill,
  );
  check(level(depthAfterFill, "bids", "10")?.quantity === "10", "seeded bid 10 x 10 disappeared", depthAfterFill);
  const openAfterFill = await openOrders(USER1);
  check(
    openAfterFill.some((entry) => entry.id === "demo-buy-1" && entry.filled === "0" && entry.quantity === "10"),
    "user-1's other seeded open order went missing",
    openAfterFill,
  );
  check(!openAfterFill.some((entry) => entry.id === order.orderId), "fully filled order is still listed as open", openAfterFill);
  record("depth", `asks 12 x ${seedAsk.quantity} -> 12 x ${level(depthAfterFill, "asks", BUY_PRICE)?.quantity}; bids 10 x 10 unchanged`);

  // -- 2. non-crossing order: buy 2 @ 5 rests, then cancel releases it -----------
  const preRest = {
    user1: await balances(USER1),
    trades: await recentTrades(),
  };
  const restCreated = await request("POST", "/api/v1/order", {
    body: { market: MARKET, price: REST_PRICE, quantity: REST_QTY, side: "buy", userId: USER1 },
    headers: { "Idempotency-Key": `e2e-live-rest-${RUN_ID}` },
  });
  check(restCreated.status === 200, "non-crossing order was rejected", restCreated.json ?? restCreated.text);
  const resting = restCreated.json;
  check(
    resting?.status === "open" && resting.filled === "0" && Array.isArray(resting.fills) && resting.fills.length === 0,
    "non-crossing order did not rest open with no fills",
    resting,
  );

  const restBefore = rowOf(preRest.user1, USER1, "USD");
  const restMid = rowOf(await balances(USER1), USER1, "USD");
  const reserved = Number(REST_PRICE) * Number(REST_QTY);
  check(
    Number(restMid.locked) === Number(restBefore.locked) + reserved,
    `placing the resting buy did not lock ${reserved} USD`,
    { before: flow(restBefore), after: flow(restMid) },
  );
  check(
    Number(restMid.available) === Number(restBefore.available) - reserved,
    `placing the resting buy did not move ${reserved} USD out of available`,
    { before: flow(restBefore), after: flow(restMid) },
  );
  const depthResting = await depth();
  check(
    level(depthResting, "bids", REST_PRICE)?.quantity === REST_QTY,
    `resting bid ${REST_PRICE} x ${REST_QTY} missing from depth`,
    depthResting,
  );
  const openResting = await openOrders(USER1);
  check(
    openResting.some(
      (entry) => entry.id === resting.orderId && entry.price === REST_PRICE &&
        entry.quantity === REST_QTY && entry.filled === "0",
    ),
    "resting order missing from open orders",
    openResting,
  );
  record(
    "resting order",
    `buy ${REST_QTY} @ ${REST_PRICE} ${USER1} -> ${resting.orderId} status=${resting.status}; reserved ${reserved} USD (${flow(restMid)})`,
  );

  const cancelled = await request("DELETE", `/api/v1/order/${encodeURIComponent(resting.orderId)}`, {
    body: { market: MARKET, userId: USER1 },
  });
  check(cancelled.status === 200, "cancel was rejected", cancelled.json ?? cancelled.text);
  check(
    cancelled.json?.status === "cancelled" && cancelled.json.orderId === resting.orderId &&
      cancelled.json.quantity === REST_QTY && cancelled.json.filled === "0",
    "cancel response mismatch",
    cancelled.json,
  );

  const restAfter = rowOf(await balances(USER1), USER1, "USD");
  check(
    restAfter.available === restBefore.available && restAfter.locked === restBefore.locked,
    "cancel did not restore the USD reservation",
    { before: flow(restBefore), after: flow(restAfter) },
  );
  const depthFinal = await depth();
  check(!level(depthFinal, "bids", REST_PRICE), "cancelled bid level is still in the book", depthFinal);
  const openFinal = await openOrders(USER1);
  check(!openFinal.some((entry) => entry.id === resting.orderId), "cancelled order is still listed as open", openFinal);
  const tradesFinal = await recentTrades();
  check(tradesFinal.length === preRest.trades.length, "cancel unexpectedly created trades", {
    before: preRest.trades.length,
    after: tradesFinal.length,
  });
  record(
    "cancel",
    `${resting.orderId} status=${cancelled.json.status}; USD restored to ${flow(restAfter)}; bid level removed; no new trades`,
  );

  console.log("");
  console.log(`PASS zex live e2e (${MARKET}) - ${assertions} assertions, 0 failures`);
  for (const [label, value] of summary) {
    console.log(`  ${label.padEnd(22)} ${value}`);
  }
}

main().catch((error) => {
  console.error("");
  console.error(error?.message ?? String(error));
  console.error(`(no PASS summary; ${assertions} assertions passed before the failure)`);
  process.exitCode = 1;
});
