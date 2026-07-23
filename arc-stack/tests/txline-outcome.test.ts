import { afterEach, describe, expect, it, vi } from "vitest";
import { CreateMarketSchema } from "../src/schemas.js";
import { fetchTrustedTxlineOutcome, parseTrustedTxlineOutcome } from "../src/txline-outcome.js";

function finalPayload(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      fixtureId: "18257865",
      status: "final",
      homeScore: 4,
      awayScore: 6,
      winner: "part2",
      source: "txline",
      sourceUpdateId: "1093:1194",
      sourceTimestamp: "2026-07-18T23:01:43.008Z",
      settledAt: "2026-07-18T23:01:43.008Z",
      settlementRule: {
        marketType: "1X2_PARTICIPANT_RESULT",
        period: "regular_time_90_plus_stoppage",
        includes: ["stoppage_time"],
        excludes: ["extra_time", "penalty_shootout"],
      },
      ...overrides,
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("trusted TxLINE outcomes", () => {
  it("maps a verified regulation-time away win to outcome index 2", () => {
    const outcome = parseTrustedTxlineOutcome(finalPayload(), "18257865", Date.parse("2026-07-19T00:00:00Z"));
    expect(outcome).toMatchObject({
      fixtureId: "18257865",
      homeScore: 4,
      awayScore: 6,
      winner: "part2",
      winningOutcome: 2,
      source: "txline",
    });
    expect(outcome.evidenceHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("fails closed on non-final, untrusted, mismatched, or wrong-period outcomes", () => {
    expect(() => parseTrustedTxlineOutcome(finalPayload({ status: "live" }), "18257865")).toThrow(/not_final/);
    expect(() => parseTrustedTxlineOutcome(finalPayload({ source: "manual" }), "18257865")).toThrow(/source_not_trusted/);
    expect(() => parseTrustedTxlineOutcome(finalPayload({ winner: "part1" }), "18257865")).toThrow(/winner_score_mismatch/);
    expect(() => parseTrustedTxlineOutcome(finalPayload({
      settlementRule: {
        marketType: "1X2_PARTICIPANT_RESULT",
        period: "regular_time_90_plus_stoppage",
        includes: ["stoppage_time"],
        excludes: [],
      },
    }), "18257865")).toThrow(/rule_not_regulation_only/);
  });

  it("treats an unavailable final outcome as pending instead of inferring one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ success: false, error: "txline_outcome_not_found" }),
      { status: 404, headers: { "content-type": "application/json" } },
    )));
    await expect(fetchTrustedTxlineOutcome("https://txline.example", "18272873")).resolves.toEqual({ kind: "pending" });
  });

  it("restricts autonomously settled fixture markets to explicit three-outcome 1X2", () => {
    const base = {
      fixtureId: "18257865",
      oracleBinding: {
        primaryAdapterId: "txline.sports-result.v1",
        primaryFixtureIdentity: "18257865",
        witnessAdapterId: "sportmonks.football.v3",
        witnessFixtureIdentity: "9901",
        witnessAccessTier: "TRIAL",
        witnessAuthenticated: true,
      },
      specHash: `0x${"11".repeat(32)}`,
      closeTime: "2027-07-22T00:00:00.000Z",
      resolutionRule: {
        primarySourceId: `0x${"12".repeat(32)}`,
        witnessSourceId: `0x${"13".repeat(32)}`,
        sourceEventId: `0x${"14".repeat(32)}`,
        primarySigner: "0x00000000000000000000000000000000000000A1",
        witnessSigner: "0x00000000000000000000000000000000000000A2",
        maxReportAgeSeconds: "120",
        maxSourceTimestampSkewSeconds: "30",
        graceSeconds: "900",
      },
    };
    const parsed = CreateMarketSchema.safeParse({ ...base, outcomeCount: 3 });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toMatchObject({
        category: "SPORTS",
        oracleSource: "TXLINE",
        outcomeLabels: ["Home", "Draw", "Away"],
        resolutionRules: "Regulation-time 1X2 result",
      });
    }
    expect(CreateMarketSchema.safeParse({ ...base, outcomeCount: 2 }).success).toBe(false);
    expect(CreateMarketSchema.safeParse({ ...base, outcomeCount: 3, category: "CRYPTO" }).success).toBe(false);
    expect(CreateMarketSchema.safeParse({ ...base, outcomeCount: 3, oracleSource: "UNREGISTERED" }).success).toBe(false);
  });
});
