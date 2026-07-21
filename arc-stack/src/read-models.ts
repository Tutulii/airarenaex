import type { Database } from "./db.js";

export type RawOrderbookLevel = {
  outcome: number;
  side: "BUY" | "SELL";
  price_ppm: string;
  quantity: string;
  order_count: number;
};

export type OrderbookLevel = {
  pricePpm: string;
  quantity: string;
  orderCount: number;
};

export type OutcomeOrderbook = {
  outcome: number;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  bestBidPpm: string | null;
  bestAskPpm: string | null;
  indicativePricePpm: string | null;
};

function level(row: RawOrderbookLevel): OrderbookLevel {
  return {
    pricePpm: row.price_ppm,
    quantity: row.quantity,
    orderCount: Number(row.order_count),
  };
}

export function buildOutcomeOrderbooks(rows: RawOrderbookLevel[], outcomeCount: number): OutcomeOrderbook[] {
  return Array.from({ length: outcomeCount }, (_unused, outcome) => {
    const bids = rows
      .filter((row) => row.outcome === outcome && row.side === "BUY")
      .sort((a, b) => Number(BigInt(b.price_ppm) - BigInt(a.price_ppm)))
      .map(level);
    const asks = rows
      .filter((row) => row.outcome === outcome && row.side === "SELL")
      .sort((a, b) => Number(BigInt(a.price_ppm) - BigInt(b.price_ppm)))
      .map(level);
    const bestBidPpm = bids[0]?.pricePpm ?? null;
    const bestAskPpm = asks[0]?.pricePpm ?? null;
    const indicativePricePpm = bestBidPpm && bestAskPpm
      ? ((BigInt(bestBidPpm) + BigInt(bestAskPpm)) / 2n).toString()
      : bestBidPpm ?? bestAskPpm;
    return { outcome, bids, asks, bestBidPpm, bestAskPpm, indicativePricePpm };
  });
}

export async function readOrderbook(
  db: Database,
  marketId: string,
): Promise<{ marketId: string; outcomeCount: number; outcomes: OutcomeOrderbook[] } | null> {
  const market = await db.query<{ outcome_count: number }>(
    "SELECT outcome_count FROM arc_markets WHERE market_id = $1",
    [marketId],
  );
  const outcomeCount = market.rows[0]?.outcome_count;
  if (!outcomeCount) return null;

  const levels = await db.query<RawOrderbookLevel>(
    `SELECT outcome, side, price_ppm::text,
            SUM(quantity - filled_quantity)::text AS quantity,
            COUNT(*)::integer AS order_count
       FROM arc_orders
      WHERE market_id = $1
        AND status = 'ACTIVE'
        AND expiry > now()
        AND quantity > filled_quantity
      GROUP BY outcome, side, price_ppm
      ORDER BY outcome ASC,
               CASE WHEN side = 'BUY' THEN price_ppm END DESC,
               CASE WHEN side = 'SELL' THEN price_ppm END ASC`,
    [marketId],
  );
  return { marketId, outcomeCount, outcomes: buildOutcomeOrderbooks(levels.rows, outcomeCount) };
}

export type AgentDirectoryRow = {
  wallet: string;
  total_orders: number;
  active_orders: number;
  filled_orders: number;
  matched_quantity: string;
  last_active_at: Date | string;
};

export function mapAgentDirectoryRow(row: AgentDirectoryRow) {
  return {
    wallet: row.wallet,
    totalOrders: Number(row.total_orders),
    activeOrders: Number(row.active_orders),
    filledOrders: Number(row.filled_orders),
    matchedQuantity: row.matched_quantity,
    lastActiveAt: new Date(row.last_active_at).toISOString(),
  };
}

export async function readAgentDirectory(db: Database, limit: number) {
  const result = await db.query<AgentDirectoryRow>(
    `SELECT maker AS wallet,
            COUNT(*)::integer AS total_orders,
            COUNT(*) FILTER (WHERE status IN ('ACTIVE','MATCHING'))::integer AS active_orders,
            COUNT(*) FILTER (WHERE status = 'FILLED')::integer AS filled_orders,
            COALESCE(SUM(filled_quantity), 0)::text AS matched_quantity,
            MAX(updated_at) AS last_active_at
       FROM arc_orders
      GROUP BY maker
      ORDER BY MAX(updated_at) DESC, maker ASC
      LIMIT $1`,
    [limit],
  );
  return result.rows.map(mapAgentDirectoryRow);
}
