import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { ARC_CHAIN_ID, ARC_USDC_ADDRESS, loadConfig } from "../src/config.js";
import {
  buildAutomaticMarketSpec,
  normalizeSportmonksFixturePage,
  sportmonksFixtureEligibility,
  type SportmonksFixture,
} from "../src/fixture-admission.js";
import { ARC_EXCHANGE_V3_ADDRESS, verifyFinalizedArcMarketSpec } from "../src/market-spec.js";

const providerPage = (data: unknown[], subscription: unknown[] = [{ plans: [{ plan: "Pro - Trialing" }] }]) => ({
  data,
  subscription,
  pagination: { current_page: 1, next_page: null, has_more: false },
});

const providerFixture = (id: number, home = "Azerbaijan", away = "Tajikistan", startingAt = "2026-09-23 00:00:00") => ({
  id,
  starting_at: startingAt,
  participants: [
    { id: id * 10, name: home, meta: { location: "home" } },
    { id: id * 10 + 1, name: away, meta: { location: "away" } },
  ],
});

const sportmonksPrimary: SportmonksFixture = {
  fixtureIdentity: "19766419",
  homeTeam: "Azerbaijan",
  awayTeam: "Tajikistan",
  startsAt: "2026-09-23 15:00:00",
  accessTier: "TRIAL",
  raw: providerFixture(19766419, "Azerbaijan", "Tajikistan", "2026-09-23 15:00:00"),
};

describe("automatic fixture admission", () => {
  it("pages Sportmonks directly and admits fixtures inside the configured window", () => {
    const nowMs = Date.parse("2026-07-26T00:00:00.000Z");
    const page = normalizeSportmonksFixturePage(providerPage([
      providerFixture(19766419, "Azerbaijan", "Tajikistan", "2026-09-23 15:00:00"),
    ]));
    expect(page).toMatchObject({
      nextPage: null,
      fixtures: [{
        fixtureIdentity: "19766419",
        homeTeam: "Azerbaijan",
        awayTeam: "Tajikistan",
        accessTier: "TRIAL",
      }],
    });
    expect(sportmonksFixtureEligibility(page.fixtures[0]!, { nowMs, horizonDays: 180, minLeadSeconds: 3600 }))
      .toMatchObject({ eligible: true });
    expect(sportmonksFixtureEligibility({ ...page.fixtures[0]!, startsAt: "2026-07-26 00:30:00" }, {
      nowMs, horizonDays: 180, minLeadSeconds: 3600,
    })).toEqual({ eligible: false, reason: "fixture_inside_minimum_lead_window" });
    expect(normalizeSportmonksFixturePage({
      ...providerPage([providerFixture(19766419)]),
      pagination: {
        current_page: 1,
        has_more: true,
        next_page: "https://api.sportmonks.com/v3/football/fixtures/between/2026-09-23/2026-09-29?page=2",
      },
    }).nextPage).toBe(2);
    expect(() => normalizeSportmonksFixturePage(providerPage([
      providerFixture(1),
    ], [{ plans: [{ plan: "Pro Annual" }] }]))).toThrow("fixture_admission_paid_subscription_forbidden");
  });

  it("derives a deterministic canonical V3 market identity and immutable specification", () => {
    const config = {
      chainId: ARC_CHAIN_ID,
      usdcAddress: getAddress(ARC_USDC_ADDRESS),
      exchangeAddress: ARC_EXCHANGE_V3_ADDRESS,
      oraclePrimarySignerPrivateKey: `0x${"11".repeat(32)}` as `0x${string}`,
      oracleWitnessSignerPrivateKey: `0x${"12".repeat(32)}` as `0x${string}`,
    };
    const first = buildAutomaticMarketSpec(config, sportmonksPrimary);
    const second = buildAutomaticMarketSpec(config, { ...sportmonksPrimary });
    expect(first).toEqual(second);
    expect(first.scheduledStartAt).toBe("2026-09-23T15:00:00Z");
    expect(() => verifyFinalizedArcMarketSpec(first)).not.toThrow();
    expect(first).toMatchObject({
      chain: { chainId: ARC_CHAIN_ID, exchangeAddress: ARC_EXCHANGE_V3_ADDRESS, contractVersion: "arena-exchange-v3" },
      collateral: { tokenAddress: getAddress(ARC_USDC_ADDRESS), decimals: 6, payoutAtoms: "1000000" },
      outcomes: [{ id: "home" }, { id: "draw" }, { id: "away" }],
      resolutionRule: {
        adapter: "sportmonks.football.v3",
        fixtureId: sportmonksPrimary.fixtureIdentity,
        primarySourceId: "sportmonks-primary",
        witnessSourceId: "sportmonks-confirmation",
      },
    });
    expect(first.marketId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(first.specHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("keeps automatic admission disabled by default and parses explicit production enablement", () => {
    const base = { NODE_ENV: "test", SERVICE_ROLE: "mcp", ARC_RPC_URL: "https://rpc.example.invalid" };
    expect(loadConfig(base).fixtureAdmission.enabled).toBe(false);
    expect(loadConfig({
      ...base,
      ARC_FIXTURE_ADMISSION_ENABLED: "true",
      ARC_FIXTURE_ADMISSION_HORIZON_DAYS: "120",
      ARC_FIXTURE_ADMISSION_MAX_PER_RUN: "4",
    }).fixtureAdmission).toMatchObject({ enabled: true, horizonDays: 120, maxPerRun: 4 });
  });
});
