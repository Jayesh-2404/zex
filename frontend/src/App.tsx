import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";
const DEFAULT_MARKET = "SOL_USDC";
const DEFAULT_USER = "user-1";

type OrderSide = "buy" | "sell";

interface Fill {
  price: string;
  quantity: string;
  makerOrderId: string;
  takerOrderId: string;
  makerUserId: string;
  takerUserId: string;
}

interface OrderResponse {
  orderId?: string;
  market?: string;
  price?: string;
  quantity?: string;
  filled?: string;
  side?: OrderSide;
  status?: string;
  fills?: Fill[];
  reason?: string;
  message?: string;
}

interface DepthLevel {
  price: string;
  quantity: string;
}

interface DepthSnapshot {
  market: string;
  bids: DepthLevel[];
  asks: DepthLevel[];
}

interface Ticker {
  symbol: string;
  firstPrice: string;
  lastPrice: string;
  high: string;
  low: string;
  priceChange: string;
  priceChangePercent: string;
  volume: string;
  quoteVolume: string;
  trades: string;
}

interface OpenOrder {
  market: string;
  id: string;
  price: string;
  quantity: string;
  filled: string;
  side: OrderSide;
  userId: string;
}

interface Kline {
  close: string;
  end: string;
  high: string;
  low: string;
  open: string;
  quoteVolume: string;
  start: string;
  trades: number;
  volume: string;
}

interface RecentTrade {
  id: string;
  market: string;
  price: string;
  quantity: string;
  makerOrderId: string;
  takerOrderId: string;
  makerUserId: string;
  takerUserId: string;
  takerSide: OrderSide;
  createdAt: string;
}

interface PanelState<T> {
  data: T;
  error?: string;
}

function createIdempotencyKey(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `order-${Date.now()}-${random}`;
}

function formatNumber(value: string | number | undefined, digits = 4): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return "0";
  }
  return parsed.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function readMessage(value: unknown): string {
  if (value && typeof value === "object" && "message" in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return "Request failed";
}

async function fetchJson<T>(path: string, init?: RequestInit, timeoutMs = 6000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, { ...init, signal: controller.signal });
    const text = await response.text();
    const body = text ? JSON.parse(text) : undefined;

    if (!response.ok) {
      throw new Error(readMessage(body));
    }

    return body as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function remainingQuantity(order: OpenOrder): number {
  return Math.max(0, Number(order.quantity) - Number(order.filled));
}

function statusTone(status?: string): string {
  if (status === "filled") return "success";
  if (status === "partial" || status === "open") return "pending";
  if (status === "rejected") return "danger";
  return "neutral";
}

function ErrorLine({ message }: { message?: string }) {
  if (!message) return null;
  return <div className="errorLine">{message}</div>;
}

function TickerStrip({ tickers, market, error }: { tickers: Ticker[]; market: string; error?: string }) {
  const ticker = tickers.find((item) => item.symbol === market) ?? tickers[0];

  return (
    <section className="tickerStrip" aria-label="Ticker stats">
      <div>
        <span className="eyebrow">Market</span>
        <strong>{market}</strong>
      </div>
      <div>
        <span className="eyebrow">Last</span>
        <strong>{formatNumber(ticker?.lastPrice)}</strong>
      </div>
      <div>
        <span className="eyebrow">24h Change</span>
        <strong className={Number(ticker?.priceChange) >= 0 ? "positive" : "negative"}>
          {formatNumber(ticker?.priceChange)} ({formatNumber(ticker?.priceChangePercent, 2)}%)
        </strong>
      </div>
      <div>
        <span className="eyebrow">High / Low</span>
        <strong>
          {formatNumber(ticker?.high)} / {formatNumber(ticker?.low)}
        </strong>
      </div>
      <div>
        <span className="eyebrow">Volume</span>
        <strong>{formatNumber(ticker?.volume)}</strong>
      </div>
      <ErrorLine message={error} />
    </section>
  );
}

function OrderForm({
  market,
  userId,
  side,
  price,
  quantity,
  idempotencyKey,
  submitting,
  error,
  onMarketChange,
  onUserChange,
  onSideChange,
  onPriceChange,
  onQuantityChange,
  onKeyChange,
  onNewKey,
  onSubmit,
}: {
  market: string;
  userId: string;
  side: OrderSide;
  price: string;
  quantity: string;
  idempotencyKey: string;
  submitting: boolean;
  error?: string;
  onMarketChange: (value: string) => void;
  onUserChange: (value: string) => void;
  onSideChange: (value: OrderSide) => void;
  onPriceChange: (value: string) => void;
  onQuantityChange: (value: string) => void;
  onKeyChange: (value: string) => void;
  onNewKey: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <section className="panel orderPanel">
      <div className="panelHeader">
        <h2>Place Order</h2>
      </div>
      <form className="orderForm" onSubmit={onSubmit}>
        <label>
          <span>Market</span>
          <input value={market} onChange={(event) => onMarketChange(event.target.value.toUpperCase())} />
        </label>
        <label>
          <span>User</span>
          <input value={userId} onChange={(event) => onUserChange(event.target.value)} />
        </label>
        <div className="segmented" aria-label="Order side">
          <button
            type="button"
            className={side === "buy" ? "active buy" : ""}
            onClick={() => onSideChange("buy")}
          >
            Buy
          </button>
          <button
            type="button"
            className={side === "sell" ? "active sell" : ""}
            onClick={() => onSideChange("sell")}
          >
            Sell
          </button>
        </div>
        <label>
          <span>Price</span>
          <input inputMode="decimal" value={price} onChange={(event) => onPriceChange(event.target.value)} />
        </label>
        <label>
          <span>Quantity</span>
          <input inputMode="decimal" value={quantity} onChange={(event) => onQuantityChange(event.target.value)} />
        </label>
        <label>
          <span>Idempotency-Key</span>
          <input value={idempotencyKey} onChange={(event) => onKeyChange(event.target.value)} />
        </label>
        <div className="formActions">
          <button type="button" className="secondaryButton" onClick={onNewKey}>
            New Key
          </button>
          <button type="submit" className={`primaryButton ${side}`} disabled={submitting}>
            {submitting ? "Submitting" : `${side === "buy" ? "Buy" : "Sell"} ${market}`}
          </button>
        </div>
        <ErrorLine message={error} />
      </form>
    </section>
  );
}

function OrderResponsePanel({ responses }: { responses: OrderResponse[] }) {
  const latest = responses[0];

  return (
    <section className="panel responsePanel">
      <div className="panelHeader">
        <h2>Order Result</h2>
      </div>
      {!latest ? (
        <div className="emptyState">No submitted orders yet.</div>
      ) : (
        <div className="orderResult">
          <div className="resultTop">
            <span className={`statusPill ${statusTone(latest.status)}`}>{latest.status ?? "unknown"}</span>
            <span>{latest.orderId ?? latest.reason ?? "No order id"}</span>
          </div>
          <div className="metricGrid">
            <div>
              <span>Price</span>
              <strong>{formatNumber(latest.price)}</strong>
            </div>
            <div>
              <span>Quantity</span>
              <strong>{formatNumber(latest.quantity)}</strong>
            </div>
            <div>
              <span>Filled</span>
              <strong>{formatNumber(latest.filled)}</strong>
            </div>
            <div>
              <span>Fills</span>
              <strong>{latest.fills?.length ?? 0}</strong>
            </div>
          </div>
          {latest.message ? <p className="resultMessage">{latest.message}</p> : null}
          <div className="fillsList">
            {(latest.fills ?? []).slice(0, 4).map((fill) => (
              <div key={`${fill.makerOrderId}-${fill.takerOrderId}-${fill.quantity}`}>
                <span>{formatNumber(fill.quantity)}</span>
                <span>@ {formatNumber(fill.price)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {responses.length > 1 ? (
        <div className="recentResponses">
          {responses.slice(1, 5).map((response, index) => (
            <div key={`${response.orderId ?? response.reason}-${index}`}>
              <span className={`statusDot ${statusTone(response.status)}`} />
              <span>{response.orderId ?? response.reason}</span>
              <span>{response.status}</span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function OrderBookPanel({ depth, error }: { depth?: DepthSnapshot; error?: string }) {
  const asks = useMemo(() => [...(depth?.asks ?? [])].reverse(), [depth]);
  const bids = depth?.bids ?? [];
  const maxQuantity = Math.max(
    1,
    ...asks.map((level) => Number(level.quantity) || 0),
    ...bids.map((level) => Number(level.quantity) || 0),
  );

  return (
    <section className="panel bookPanel">
      <div className="panelHeader">
        <h2>Order Book</h2>
      </div>
      <ErrorLine message={error} />
      <div className="bookHeader">
        <span>Price</span>
        <span>Size</span>
        <span>Total</span>
      </div>
      <div className="bookRows asks">
        {asks.slice(-8).map((level) => (
          <BookRow key={`ask-${level.price}`} level={level} maxQuantity={maxQuantity} side="ask" />
        ))}
      </div>
      <div className="spreadLine">
        <span>Spread</span>
        <strong>
          {depth?.asks[0] && depth?.bids[0]
            ? formatNumber(Number(depth.asks[0].price) - Number(depth.bids[0].price))
            : "0"}
        </strong>
      </div>
      <div className="bookRows bids">
        {bids.slice(0, 8).map((level) => (
          <BookRow key={`bid-${level.price}`} level={level} maxQuantity={maxQuantity} side="bid" />
        ))}
      </div>
    </section>
  );
}

function BookRow({ level, maxQuantity, side }: { level: DepthLevel; maxQuantity: number; side: "bid" | "ask" }) {
  const quantity = Number(level.quantity) || 0;
  const width = `${Math.min(100, (quantity / maxQuantity) * 100)}%`;

  return (
    <div className={`bookRow ${side}`}>
      <span className="depthBar" style={{ width }} />
      <span>{formatNumber(level.price)}</span>
      <span>{formatNumber(level.quantity)}</span>
      <span>{formatNumber(quantity)}</span>
    </div>
  );
}

function ChartPanel({ klines, error }: { klines: Kline[]; error?: string }) {
  const points = klines
    .map((item) => ({
      price: Number(item.close),
      volume: Number(item.volume),
    }))
    .filter((item) => Number.isFinite(item.price));
  const width = 640;
  const height = 240;
  const chartTop = 18;
  const chartBottom = 190;
  const min = Math.min(...points.map((point) => point.price));
  const max = Math.max(...points.map((point) => point.price));
  const range = Number.isFinite(max - min) && max !== min ? max - min : 1;
  const path = points
    .map((point, index) => {
      const x = points.length === 1 ? width / 2 : (index / (points.length - 1)) * (width - 40) + 20;
      const y = chartBottom - ((point.price - min) / range) * (chartBottom - chartTop);
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
  const maxVolume = Math.max(1, ...points.map((point) => point.volume || 0));

  return (
    <section className="panel chartPanel">
      <div className="panelHeader">
        <h2>Klines</h2>
        <span>1m</span>
      </div>
      <ErrorLine message={error} />
      {points.length === 0 ? (
        <div className="emptyState">No kline data for this range.</div>
      ) : (
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Close price chart">
          <line x1="20" x2="620" y1="60" y2="60" />
          <line x1="20" x2="620" y1="125" y2="125" />
          <line x1="20" x2="620" y1="190" y2="190" />
          <path d={path} />
          {points.map((point, index) => {
            const x = points.length === 1 ? width / 2 : (index / (points.length - 1)) * (width - 40) + 20;
            const barHeight = Math.max(2, ((point.volume || 0) / maxVolume) * 28);
            return <rect key={index} x={x - 2} y={226 - barHeight} width="4" height={barHeight} />;
          })}
          <text x="24" y="24">{formatNumber(max)}</text>
          <text x="24" y="186">{formatNumber(min)}</text>
        </svg>
      )}
    </section>
  );
}

function OpenOrdersPanel({ orders, error }: { orders: OpenOrder[]; error?: string }) {
  return (
    <section className="panel openOrdersPanel">
      <div className="panelHeader">
        <h2>Open Orders</h2>
        <span>{orders.length}</span>
      </div>
      <ErrorLine message={error} />
      {orders.length === 0 ? (
        <div className="emptyState">No open orders for this user.</div>
      ) : (
        <div className="tableList">
          {orders.map((order) => (
            <div key={order.id} className="tableRow">
              <span className={order.side === "buy" ? "positive" : "negative"}>{order.side}</span>
              <span>{formatNumber(order.price)}</span>
              <span>{formatNumber(remainingQuantity(order))}</span>
              <span>{order.id.slice(0, 8)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function RecentTradesPanel({ trades, error }: { trades: RecentTrade[]; error?: string }) {
  return (
    <section className="panel tradesPanel">
      <div className="panelHeader">
        <h2>Recent Trades</h2>
        <span>{trades.length}</span>
      </div>
      <ErrorLine message={error} />
      {trades.length === 0 ? (
        <div className="emptyState">No recent trades.</div>
      ) : (
        <div className="tableList">
          {trades.slice(0, 8).map((trade) => (
            <div key={trade.id} className="tableRow">
              <span className={trade.takerSide === "buy" ? "positive" : "negative"}>{trade.takerSide}</span>
              <span>{formatNumber(trade.price)}</span>
              <span>{formatNumber(trade.quantity)}</span>
              <span>{new Date(trade.createdAt).toLocaleTimeString()}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default function App() {
  const [market, setMarket] = useState(DEFAULT_MARKET);
  const [userId, setUserId] = useState(DEFAULT_USER);
  const [side, setSide] = useState<OrderSide>("buy");
  const [price, setPrice] = useState("10");
  const [quantity, setQuantity] = useState("1");
  const [idempotencyKey, setIdempotencyKey] = useState(createIdempotencyKey);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const [responses, setResponses] = useState<OrderResponse[]>([]);
  const [depth, setDepth] = useState<PanelState<DepthSnapshot | undefined>>({ data: undefined });
  const [tickers, setTickers] = useState<PanelState<Ticker[]>>({ data: [] });
  const [klines, setKlines] = useState<PanelState<Kline[]>>({ data: [] });
  const [orders, setOrders] = useState<PanelState<OpenOrder[]>>({ data: [] });
  const [trades, setTrades] = useState<PanelState<RecentTrade[]>>({ data: [] });

  const loadMarketData = useCallback(async () => {
    const now = Math.floor(Date.now() / 1000);
    const start = now - 60 * 60 * 6;
    const params = new URLSearchParams({ market, userId });
    const klineParams = new URLSearchParams({
      market,
      interval: "1m",
      startTime: start.toString(),
      endTime: now.toString(),
    });

    await Promise.allSettled([
      fetchJson<DepthSnapshot>(`/api/v1/depth?symbol=${encodeURIComponent(market)}`)
        .then((data) => setDepth({ data }))
        .catch((error: Error) => setDepth((current) => ({ ...current, error: error.message }))),
      fetchJson<Ticker[]>("/api/v1/tickers")
        .then((data) => setTickers({ data }))
        .catch((error: Error) => setTickers((current) => ({ ...current, error: error.message }))),
      fetchJson<Kline[]>(`/api/v1/klines?${klineParams.toString()}`)
        .then((data) => setKlines({ data }))
        .catch((error: Error) => setKlines((current) => ({ ...current, error: error.message }))),
      fetchJson<OpenOrder[]>(`/api/v1/orders/open?${params.toString()}`)
        .then((data) => setOrders({ data }))
        .catch((error: Error) => setOrders((current) => ({ ...current, error: error.message }))),
      fetchJson<RecentTrade[]>(`/api/v1/trades/recent?market=${encodeURIComponent(market)}&limit=25`)
        .then((data) => setTrades({ data }))
        .catch((error: Error) => setTrades((current) => ({ ...current, error: error.message }))),
    ]);
  }, [market, userId]);

  useEffect(() => {
    void loadMarketData();
    const timer = window.setInterval(() => void loadMarketData(), 2000);
    return () => window.clearInterval(timer);
  }, [loadMarketData]);

  async function submitOrder(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setSubmitError(undefined);

    try {
      const response = await fetchJson<OrderResponse>("/api/v1/order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          market,
          price,
          quantity,
          side,
          userId,
        }),
      });
      setResponses((current) => [response, ...current].slice(0, 8));
      setIdempotencyKey(createIdempotencyKey());
      await loadMarketData();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Order submission failed";
      setSubmitError(message);
      setResponses((current) => [{ status: "rejected", reason: "REQUEST_FAILED", message }, ...current].slice(0, 8));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="appShell">
      <header className="topBar">
        <div>
          <h1>Zex Trading</h1>
          <p>Local exchange screen for order entry, market depth, candles, and user orders.</p>
        </div>
        <div className="connectionNote">API {API_BASE_URL}</div>
      </header>

      <TickerStrip tickers={tickers.data} market={market} error={tickers.error} />

      <div className="layoutGrid">
        <div className="leftStack">
          <OrderForm
            market={market}
            userId={userId}
            side={side}
            price={price}
            quantity={quantity}
            idempotencyKey={idempotencyKey}
            submitting={submitting}
            error={submitError}
            onMarketChange={setMarket}
            onUserChange={setUserId}
            onSideChange={setSide}
            onPriceChange={setPrice}
            onQuantityChange={setQuantity}
            onKeyChange={setIdempotencyKey}
            onNewKey={() => setIdempotencyKey(createIdempotencyKey())}
            onSubmit={submitOrder}
          />
          <OrderResponsePanel responses={responses} />
        </div>
        <div className="centerStack">
          <ChartPanel klines={klines.data} error={klines.error} />
          <OpenOrdersPanel orders={orders.data} error={orders.error} />
        </div>
        <div className="rightStack">
          <OrderBookPanel depth={depth.data} error={depth.error} />
          <RecentTradesPanel trades={trades.data} error={trades.error} />
        </div>
      </div>
    </main>
  );
}
