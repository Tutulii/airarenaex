export type OrderableMarketState = {
  outcome_count: number;
  status: string;
  close_time: Date | string;
};

export function validateOrderableMarket(
  market: OrderableMarketState | undefined,
  outcome: number,
  now = new Date(),
): void {
  if (!market) throw new Error("market_not_found");
  if (market.status !== "OPEN") throw new Error("market_not_open");
  if (new Date(market.close_time).getTime() <= now.getTime()) throw new Error("market_closed");
  if (!Number.isInteger(outcome) || outcome < 0 || outcome >= market.outcome_count) {
    throw new Error("invalid_market_outcome");
  }
}
