# Architecture

## Shape

```
client ──HTTP──▶ api ──LPUSH "message"──▶ [Redis list] ──BRPOP──▶ engine
                    ▲                                                   │
                    └───────────── PUBLISH (per-request channel) ────────┘

engine ──▶ Postgres        trades, klines_1m/1h/1w, open_orders, command_journal
engine ──▶ PUBLISH zex:events ──▶ api ──▶ SSE clients on /api/v1/stream
```

The engine is a single writer. Nothing else mutates an order book. That one
constraint is what makes the rest of the design tractable: there is no
distributed lock to reason about, and command handling is sequential.

## Request path

`RedisManager.sendAndWait` opens a request by subscribing the API to a
per-request channel, then `LPUSH`ing `{clientId, message}` onto the `message`
list. The engine `BRPOP`s, processes, and `PUBLISH`es to `clientId`. Each
request gets its own channel id, so responses cannot be delivered to the wrong
caller and no shared reply key can be overwritten.

A `clientId` is captured *before* the try block in the engine's loop. If command
processing throws, the catch still knows which caller to answer, and replies
with `ENGINE_ERROR` rather than leaving that request to expire on its timeout.
Callers that need at-most-once semantics send an `Idempotency-Key`.

## Consistency

Order persistence is one transaction (`TradeStore.persistOrderResult`): fills,
OHLCV upserts, the open-order snapshot, and the command journal row commit
together or not at all. Two properties fall out of that:

- The book mutation and the record of it cannot disagree.
- A retried create-order short-circuits on the journal row, so it cannot place a
  second order. This is why the journal is written in the same transaction
  rather than after the fact.

The engine is the only writer, so ordering is total and these transactions
cannot interleave with a competing updater.

## Recovery

On startup the engine rebuilds in-memory state from Postgres before it consumes
commands: open orders from `open_orders`, 24h ticker stats from `trades`. There
is no window where it serves reads against an empty book.

The gap: a command that mutated the book but died before its transaction
committed leaves no record, and a command that committed but died before
replying is covered by the journal on retry. The first case is the open
window. Closing it means a pending→completed journal written *before* the book
mutation, which is a larger change and not built yet.

## Money

Two processes must agree on how decimal strings become fixed-point integers, so
that agreement is tested rather than assumed:

- `engine/src/decimal.ts` owns the grammar and the 8-place scale.
- `api/src/validation/decimal.ts` accepts exactly what survives that grammar and
  scale, rejecting early with a `400`.
- `api/src/validation/decimal.engine-parity.test.ts` duplicates the engine
  constants and asserts every accepted value round-trips unchanged.

The duplication is deliberate. The packages build in separate Docker contexts,
so a shared import would break the isolated images. The parity test is what
keeps the copy honest.

Two failure modes motivated this. `"1e-8"` passed `Number()`-based validation,
threw inside the engine, and left the caller waiting out its timeout. Values
with more than 8 decimal places did not throw — `toScaled` *slices* the
fraction, so the order would have landed for a silently smaller quantity. The
second is worse, because it succeeds and is wrong.

## Open tradeoffs

- **Redis list transport.** `LPUSH`/`BRPOP` is simple and at-most-once. A
  dropped connection mid-command loses it. A durable log (Streams, or a
  Postgres-backed queue) is the upgrade if delivery guarantees matter.
- **One connection does blocking reads and publishes.** `BRPOP` holds the
  socket, so event publishing is serialised behind the queue wait. Correct as
  ordered today; it breaks if a second consumer or a subscription is added to
  the same connection.
- **Full snapshot per mutation.** Each order rewrites the market's entire
  `open_orders` set inside its transaction. O(book size) writes per order, which
  is fine at demo scale and the obvious thing to fix with incremental diffs.
- **No auth, no balances.** `userId` is caller-supplied and orders are not
  financially constrained. Scope choices, documented rather than hidden.
