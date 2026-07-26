import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { ARC_CHAIN_ID, ARC_USDC_ADDRESS, loadConfig } from "../src/config.js";
import {
  buildAutomaticMarketSpec,
  matchSportmonksPrimaryFixture,
  txlineWitnessEligibility,
  type SportmonksFixture,
  type TxlineFixture,
} from "../src/fixture-admission.js";
import { ARC_EXCHANGE_V3_ADDRESS, verifyFinalizedArcMarketSpec } from "../src/market-spec.js";

const txlineWitness: TxlineFixture = {
  fixtureId: "18272873",
  sport: "football",
  homeTeam: "Azerbaijan",
  awayTeam: "Tajikistan",
  startsAt: "2026-09-23T15:00:00.000Z",
  status: "upcoming",
  marketTypes: ["1X2_PARTICIPANT_RESULT"],
};

const witness = (data: unknown[], subscription: unknown[] = [{ plans: [{ plan: "Pro - Trialing" }] }]) => ({
  data,
  subscription,
});

const witnessFixture = (id: number, home = "Azerbaijan", away = "Tajikistan", startingAt = "2026-09-23 00:00:00") => ({
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
  raw: witnessFixture(19766419, "Azerbaijan", "Tajikistan", "2026-09-23 15:00:00"),
};

describe("automatic fixture admission", () => {
  it("admits only future football 1X2 fixtures inside the configured window", () => {
    const nowMs = Date.parse("2026-07-26T00:00:00.000Z");
    expect(txlineWitnessEligibility(txlineWitness, { nowMs, horizonDays: 180, minLeadSeconds: 3600 }))
      .toMatchObject({ eligible: true });
    expect(txlineWitnessEligibility({ ...txlineWitness, sport: "cricket" }, { nowMs, horizonDays: 180, minLeadSeconds: 3600 }))
      .toEqual({ eligible: false, reason: "unsupported_sport" });
    expect(txlineWitnessEligibility({ ...txlineWitness, marketTypes: [] }, { nowMs, horizonDays: 180, minLeadSeconds: 3600 }))
      .toEqual({ eligible: false, reason: "unsupported_market_template" });
    expect(txlineWitnessEligibility({ ...txlineWitness, status: "live" }, { nowMs, horizonDays: 180, minLeadSeconds: 3600 }))
      .toEqual({ eligible: false, reason: "fixture_not_upcoming:live" });
  });

  it("binds a unique same-orientation, same-date Sportmonks primary fixture", () => {
    expect(matchSportmonksPrimaryFixture(txlineWitness, witness([witnessFixture(19766419)]))).toMatchObject({
      kind: "MATCH",
      primary: {
        fixtureIdentity: "19766419",
        homeTeam: "Azerbaijan",
        awayTeam: "Tajikistan",
        accessTier: "TRIAL",
      },
    });
    expect(matchSportmonksPrimaryFixture(txlineWitness, witness([witnessFixture(1, "Tajikistan", "Azerbaijan")]))).toEqual({
      kind: "NONE",
      reason: "qualifying_primary_fixture_not_found",
    });
    expect(matchSportmonksPrimaryFixture(txlineWitness, witness([witnessFixture(1, undefined, undefined, "2026-09-24 00:00:00")]))).toEqual({
      kind: "NONE",
      reason: "qualifying_primary_fixture_not_found",
    });
  });

  it("fails closed for ambiguous or paid Sportmonks primary results", () => {
    expect(matchSportmonksPrimaryFixture(txlineWitness, witness([witnessFixture(2), witnessFixture(1)]))).toMatchObject({
      kind: "AMBIGUOUS",
      reason: "multiple_qualifying_primary_fixtures",
      candidates: [{ fixtureIdentity: "1" }, { fixtureIdentity: "2" }],
    });
    expect(matchSportmonksPrimaryFixture(txlineWitness, witness([witnessFixture(1)], [{ plans: [{ plan: "Pro Annual" }] }]))).toEqual({
      kind: "NONE",
      reason: "primary_paid_subscription_forbidden",
    });
  });

  it("derives a deterministic canonical V3 market identity and immutable specification", () => {
    const config = {
      chainId: ARC_CHAIN_ID,
      usdcAddress: getAddress(ARC_USDC_ADDRESS),
      exchangeAddress: ARC_EXCHANGE_V3_ADDRESS,
      oraclePrimarySignerPrivateKey: `0x${"11".repeat(32)}` as `0x${string}`,
      oracleWitnessSignerPrivateKey: `0x${"12".repeat(32)}` as `0x${string}`,
    };
    const first = buildAutomaticMarketSpec(config, txlineWitness, sportmonksPrimary);
    const second = buildAutomaticMarketSpec(config, { ...txlineWitness }, { ...sportmonksPrimary });
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
        witnessSourceId: "txline-witness",
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
