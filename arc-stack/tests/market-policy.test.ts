import { describe, expect, it } from "vitest";
import { validateOrderableMarket } from "../src/market-policy.js";

const now = new Date("2026-07-21T12:00:00.000Z");

describe("market order admission policy", () => {
  it("allows only an existing, open, unexpired market outcome", () => {
    expect(() => validateOrderableMarket({
      outcome_count: 2,
      status: "OPEN",
      close_time: "2026-07-21T13:00:00.000Z",
    }, 1, now)).not.toThrow();
  });

  it.each([
    [undefined, 0, "market_not_found"],
    [{ outcome_count: 2, status: "QUEUED", close_time: "2026-07-21T13:00:00.000Z" }, 0, "market_not_open"],
    [{ outcome_count: 2, status: "RESOLVED", close_time: "2026-07-21T13:00:00.000Z" }, 0, "market_not_open"],
    [{ outcome_count: 2, status: "OPEN", close_time: "2026-07-21T12:00:00.000Z" }, 0, "market_closed"],
    [{ outcome_count: 2, status: "OPEN", close_time: "2026-07-21T13:00:00.000Z" }, 2, "invalid_market_outcome"],
  ] as const)("rejects unsafe order admission (%s)", (market, outcome, error) => {
    expect(() => validateOrderableMarket(market, outcome, now)).toThrow(error);
  });
});
