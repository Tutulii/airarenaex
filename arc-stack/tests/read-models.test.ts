import { describe, expect, it } from "vitest";
import { buildOutcomeOrderbooks, mapAgentDirectoryRow } from "../src/read-models.js";

describe("Arc public read models", () => {
  it("sorts bids descending, asks ascending, and computes a midpoint", () => {
    const outcomes = buildOutcomeOrderbooks([
      { outcome: 0, side: "BUY", price_ppm: "400000", quantity: "2000000", order_count: 1 },
      { outcome: 0, side: "BUY", price_ppm: "450000", quantity: "1000000", order_count: 2 },
      { outcome: 0, side: "SELL", price_ppm: "550000", quantity: "3000000", order_count: 1 },
      { outcome: 0, side: "SELL", price_ppm: "525000", quantity: "4000000", order_count: 1 },
    ], 3);

    expect(outcomes).toHaveLength(3);
    expect(outcomes[0]).toMatchObject({
      bestBidPpm: "450000",
      bestAskPpm: "525000",
      indicativePricePpm: "487500",
    });
    expect(outcomes[0]?.bids.map((entry) => entry.pricePpm)).toEqual(["450000", "400000"]);
    expect(outcomes[0]?.asks.map((entry) => entry.pricePpm)).toEqual(["525000", "550000"]);
    expect(outcomes[1]).toMatchObject({ bestBidPpm: null, bestAskPpm: null, indicativePricePpm: null });
  });

  it("maps database agent rows without inventing reputation data", () => {
    expect(mapAgentDirectoryRow({
      wallet: "0x0000000000000000000000000000000000000001",
      total_orders: 3,
      active_orders: 1,
      filled_orders: 2,
      matched_quantity: "12500000",
      last_active_at: "2026-07-21T00:00:00.000Z",
    })).toEqual({
      wallet: "0x0000000000000000000000000000000000000001",
      totalOrders: 3,
      activeOrders: 1,
      filledOrders: 2,
      matchedQuantity: "12500000",
      lastActiveAt: "2026-07-21T00:00:00.000Z",
    });
  });
});
