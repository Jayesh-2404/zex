import { Router } from "express";
import { Client } from 'pg';

const viewRouter = Router();
const intervalTables: Record<string, string> = {
  '1m': 'klines_1m',
  '1h': 'klines_1h',
  '1w': 'klines_1w',
};

const client = new Client({
  user: process.env.POSTGRES_USER ?? 'cex',
  host: process.env.POSTGRES_HOST ?? 'localhost',
  database: process.env.POSTGRES_DB ?? 'cex',
  password: process.env.POSTGRES_PASSWORD ?? 'cex',
  port: Number(process.env.POSTGRES_PORT ?? 5432),
})
client.connect().catch((error) => {
  console.error("Failed to connect to Postgres", error);
});

function parseUnixSeconds(value: unknown) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    return null;
  }

  return new Date(seconds * 1000);
}

viewRouter.get("/", async (req, res) => {
  const { market, interval, startTime, endTime } = req.query;
  const tableName = typeof interval === 'string' ? intervalTables[interval] : undefined;

  if (!tableName) {
    return res.status(400).send('Invalid interval');
  }

  const startDate = parseUnixSeconds(startTime);
  const endDate = parseUnixSeconds(endTime);

  if (!startDate || !endDate) {
    return res.status(400).send('Invalid time range');
  }

  try {
    const marketName = typeof market === 'string' ? market : 'SOL_USDC';
    const query = `
      SELECT bucket, start, open, high, low, close, volume, quote_volume, trades
      FROM ${tableName}
      WHERE market = $1 AND bucket >= $2 AND bucket <= $3
      ORDER BY bucket ASC
    `;
    const result = await client.query(query, [marketName, startDate, endDate]);
    res.json(result.rows.map((x: any) => ({
      close: x.close,
      end: x.bucket,
      high: x.high,
      low: x.low,
      open: x.open,
      quoteVolume: x.quote_volume,
      start: x.start,
      trades: x.trades,
      volume: x.volume,
    })));
  } catch (err) {
    console.log(err);
    res.status(500).send(err);
  }
});
export default viewRouter;
