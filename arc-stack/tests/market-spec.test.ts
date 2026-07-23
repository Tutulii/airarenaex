import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ArcMarketSpecValidationError,
  arcInvalidationPayout,
  arcTradeFeeAtoms,
  canonicalArcMarketIdentity,
  canonicalArcMarketSpecPayload,
  canonicalizeArcJson,
  deriveArcMarketId,
  deriveArcSpecHash,
  finalizeArcMarketSpec,
  parseArcMarketSpecDraft,
  verifyFinalizedArcMarketSpec,
} from "../src/market-spec.js";

type GoldenVector = {
  vectorVersion: number;
  name: string;
  draft: Record<string, any>;
  expected: {
    canonicalIdentity: string;
    marketId: string;
    canonicalSpecPayload: string;
    specHash: string;
  };
};

const testDir = path.dirname(fileURLToPath(import.meta.url));
const vectorPath = path.resolve(testDir, "../../config/arena-exchange/vectors/arc-market-spec-1x2.v1.json");
const vector = JSON.parse(readFileSync(vectorPath, "utf8")) as GoldenVector;

function draft(): Record<string, any> {
  return structuredClone(vector.draft);
}

function expectValidationCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ArcMarketSpecValidationError);
    expect(error).toMatchObject({ code });
  }
}

describe("AIR Arena ARC MarketSpec v1", () => {
  it("matches the committed canonical serialization and Keccak-256 golden vector", () => {
    const finalized = finalizeArcMarketSpec(vector.draft);
    expect(vector.vectorVersion).toBe(1);
    expect(vector.name).toBe("arc-football-regulation-1x2-v1");
    expect(canonicalArcMarketIdentity(vector.draft)).toBe(vector.expected.canonicalIdentity);
    expect(finalized.marketId).toBe(vector.expected.marketId);
    expect(canonicalArcMarketSpecPayload(vector.draft)).toBe(vector.expected.canonicalSpecPayload);
    expect(finalized.specHash).toBe(vector.expected.specHash);
    expect(deriveArcMarketId(vector.draft)).toBe(vector.expected.marketId);
    expect(deriveArcSpecHash(vector.draft)).toBe(vector.expected.specHash);
  });

  it("binds new specifications to the deployed frozen V3 address without changing the V2 vector", () => {
    const v3 = draft();
    v3.chain.contractVersion = "arena-exchange-v3";
    v3.chain.exchangeAddress = "0x6B42F8Ec16EE7C580213D0d07076019aBD6eE071";
    const finalized = finalizeArcMarketSpec(v3);
    expect(finalized.chain.contractVersion).toBe("arena-exchange-v3");
    expect(finalized.chain.exchangeAddress).toBe("0x6B42F8Ec16EE7C580213D0d07076019aBD6eE071");
    expect(finalized.marketId).not.toBe(vector.expected.marketId);
    expect(finalized.specHash).not.toBe(vector.expected.specHash);
    expect(finalizeArcMarketSpec(vector.draft).specHash).toBe(vector.expected.specHash);
  });

  it("produces identical hashes for semantically equivalent key and set ordering", () => {
    const reordered = draft();
    reordered.outcomes.reverse();
    reordered.resolutionRule.finalStatuses.reverse();
    reordered.parameters = Object.fromEntries(Object.entries(reordered.parameters).reverse());
    const rootReordered = Object.fromEntries(Object.entries(reordered).reverse());
    expect(canonicalArcMarketIdentity(rootReordered)).toBe(vector.expected.canonicalIdentity);
    expect(canonicalArcMarketSpecPayload(rootReordered)).toBe(vector.expected.canonicalSpecPayload);
    expect(finalizeArcMarketSpec(rootReordered)).toEqual(finalizeArcMarketSpec(vector.draft));
  });

  it("supports the deterministic two-outcome to-advance template", () => {
    const input = draft();
    input.templateId = "sports.result.to-advance.v1";
    input.outcomes = [
      { index: 0, id: "home", label: "Home advances" },
      { index: 1, id: "away", label: "Away advances" },
    ];
    input.resolutionRule.settlementBasis = "TO_ADVANCE";
    const finalized = finalizeArcMarketSpec(input);
    expect(finalized.outcomes).toHaveLength(2);
    expect(finalized.marketId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(finalized.specHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("verifies an untampered finalized specification", () => {
    const finalized = finalizeArcMarketSpec(vector.draft);
    expect(verifyFinalizedArcMarketSpec(finalized)).toEqual(finalized);
  });

  it("rejects tampered market and specification hashes", () => {
    const marketTamper = finalizeArcMarketSpec(vector.draft);
    marketTamper.marketId = `0x${"0".repeat(64)}`;
    expectValidationCode(() => verifyFinalizedArcMarketSpec(marketTamper), "MARKET_ID_MISMATCH");

    const specTamper = finalizeArcMarketSpec(vector.draft);
    specTamper.specHash = `0x${"0".repeat(64)}`;
    expectValidationCode(() => verifyFinalizedArcMarketSpec(specTamper), "SPEC_HASH_MISMATCH");
  });

  it("rejects unknown fields instead of silently dropping them", () => {
    const input = draft();
    input.operatorSelectedWinner = "home";
    expectValidationCode(() => parseArcMarketSpecDraft(input), "SCHEMA_INVALID");
  });

  it("rejects numeric, negative, non-canonical, and overflowing atom values", () => {
    for (const invalid of [1_000_000, "-1", "01", "340282366920938463463374607431768211456"]) {
      const input = draft();
      input.collateral.payoutAtoms = invalid;
      expectValidationCode(() => parseArcMarketSpecDraft(input), "SCHEMA_INVALID");
    }
  });

  it("rejects non-canonical timestamps and invalid lifecycle ordering", () => {
    const imprecise = draft();
    imprecise.tradingOpensAt = "2026-07-20T12:00:00.001Z";
    expectValidationCode(() => parseArcMarketSpecDraft(imprecise), "SCHEMA_INVALID");

    const reversed = draft();
    reversed.tradingClosesAt = reversed.tradingOpensAt;
    expectValidationCode(() => parseArcMarketSpecDraft(reversed), "INVALID_TIME_ORDER");
  });

  it("rejects template, outcome, and settlement-basis mismatches", () => {
    const missingDraw = draft();
    missingDraw.outcomes = missingDraw.outcomes.filter((outcome: any) => outcome.id !== "draw");
    missingDraw.outcomes[1].index = 1;
    expectValidationCode(() => parseArcMarketSpecDraft(missingDraw), "TEMPLATE_MISMATCH");

    const wrongBasis = draft();
    wrongBasis.resolutionRule.settlementBasis = "TO_ADVANCE";
    expectValidationCode(() => parseArcMarketSpecDraft(wrongBasis), "TEMPLATE_MISMATCH");
  });

  it("rejects duplicate outcomes and non-contiguous indices", () => {
    const duplicate = draft();
    duplicate.outcomes[2].id = "home";
    expectValidationCode(() => parseArcMarketSpecDraft(duplicate), "DUPLICATE_VALUE");

    const gap = draft();
    gap.outcomes[2].index = 1;
    expectValidationCode(() => parseArcMarketSpecDraft(gap), "DUPLICATE_VALUE");

    const duplicateLabel = draft();
    duplicateLabel.outcomes[2].label = "HOME WIN";
    expectValidationCode(() => parseArcMarketSpecDraft(duplicateLabel), "DUPLICATE_VALUE");
  });

  it("rejects unsafe batch policy combinations", () => {
    const cutoff = draft();
    cutoff.parameters.batch.cancelCutoffMs = cutoff.parameters.batch.intervalMs;
    expectValidationCode(() => parseArcMarketSpecDraft(cutoff), "INVALID_BATCH_POLICY");

    const prices = draft();
    prices.parameters.batch.minPricePpm = prices.parameters.batch.maxPricePpm;
    expectValidationCode(() => parseArcMarketSpecDraft(prices), "INVALID_BATCH_POLICY");

    const step = draft();
    step.parameters.batch.quantityStepAtoms = "3000";
    expectValidationCode(() => parseArcMarketSpecDraft(step), "INVALID_BATCH_POLICY");
  });

  it("rejects cap relationships that could over-reserve custody", () => {
    const reserve = draft();
    reserve.parameters.caps.walletOpenOrderReserveAtoms = "1000000001";
    expectValidationCode(() => parseArcMarketSpecDraft(reserve), "INVALID_CAP_POLICY");

    const order = draft();
    order.parameters.caps.maxOrderQuantityAtoms = "500000001";
    expectValidationCode(() => parseArcMarketSpecDraft(order), "INVALID_CAP_POLICY");

    const global = draft();
    global.parameters.caps.globalCollateralAtoms = "9999999999";
    expectValidationCode(() => parseArcMarketSpecDraft(global), "INVALID_CAP_POLICY");
  });

  it("requires an independent witness and unambiguous finality channels", () => {
    const sameSource = draft();
    sameSource.resolutionRule.witnessSourceId = sameSource.resolutionRule.primarySourceId;
    expectValidationCode(() => parseArcMarketSpecDraft(sameSource), "SOURCE_NOT_INDEPENDENT");

    const overlap = draft();
    overlap.resolutionRule.finalActions = ["final"];
    expectValidationCode(() => parseArcMarketSpecDraft(overlap), "AMBIGUOUS_FINALITY");
  });

  it("rejects fee policies that contradict the declared rate or order caps", () => {
    const zeroFee = draft();
    zeroFee.parameters.fees.tradeFeeBps = 0;
    expectValidationCode(() => parseArcMarketSpecDraft(zeroFee), "INVALID_FEE_POLICY");

    const excessiveMinimum = draft();
    excessiveMinimum.parameters.fees.minimumFeeAtoms = "100000001";
    expectValidationCode(() => parseArcMarketSpecDraft(excessiveMinimum), "INVALID_FEE_POLICY");
  });

  it("publishes deterministic invalidation payout and dust handling", () => {
    expect(arcInvalidationPayout(vector.draft)).toEqual({
      payoutPerOutcomeAtoms: "333333",
      remainderAtoms: "1",
      remainderDestination: "PROTOCOL_DUST_VAULT",
    });
  });

  it("calculates fees with integer ceiling and the committed minimum", () => {
    const policy = draft().parameters.fees;
    expect(arcTradeFeeAtoms("1000000", policy)).toBe("2500");
    expect(arcTradeFeeAtoms("1", policy)).toBe("1");
    const freePolicy = { ...policy, tradeFeeBps: 0, minimumFeeAtoms: "0" };
    expect(arcTradeFeeAtoms("1000000", freePolicy)).toBe("0");
    expectValidationCode(() => arcTradeFeeAtoms("1", { ...freePolicy, minimumFeeAtoms: "1" }), "INVALID_FEE_POLICY");
    expectValidationCode(() => arcTradeFeeAtoms("0", policy), "SCHEMA_INVALID");
  });

  it("canonical JSON sorts keys and rejects non-integer or non-JSON inputs", () => {
    expect(canonicalizeArcJson({ z: 2, a: { y: true, b: "x" } })).toBe('{"a":{"b":"x","y":true},"z":2}');
    expectValidationCode(() => canonicalizeArcJson(1.5), "NON_CANONICAL_NUMBER");
    expectValidationCode(() => canonicalizeArcJson(-0), "NON_CANONICAL_NUMBER");
    expectValidationCode(() => canonicalizeArcJson(Number.MAX_SAFE_INTEGER + 1), "NON_CANONICAL_NUMBER");
    expectValidationCode(() => canonicalizeArcJson(undefined), "NON_CANONICAL_TYPE");
    expectValidationCode(() => canonicalizeArcJson(new Date()), "NON_CANONICAL_OBJECT");
  });

  it("binds every market to ARC Testnet, the scoped exchange, and official USDC", () => {
    const wrongChain = draft();
    wrongChain.chain.chainId = 1;
    expectValidationCode(() => parseArcMarketSpecDraft(wrongChain), "SCHEMA_INVALID");

    const wrongExchange = draft();
    wrongExchange.chain.exchangeAddress = "0x0000000000000000000000000000000000000001";
    expectValidationCode(() => parseArcMarketSpecDraft(wrongExchange), "WRONG_EXCHANGE");

    const wrongToken = draft();
    wrongToken.collateral.tokenAddress = "0x0000000000000000000000000000000000000001";
    expectValidationCode(() => parseArcMarketSpecDraft(wrongToken), "WRONG_COLLATERAL");
  });

  it("normalizes valid EVM address casing before hashing", () => {
    const lower = draft();
    lower.chain.exchangeAddress = lower.chain.exchangeAddress.toLowerCase();
    expect(finalizeArcMarketSpec(lower)).toEqual(finalizeArcMarketSpec(vector.draft));
  });

  it("forbids reference odds from becoming executable platform quotes", () => {
    const executableOdds = draft();
    executableOdds.parameters.referenceData.liveOddsExecution = "ALLOW";
    expectValidationCode(() => parseArcMarketSpecDraft(executableOdds), "SCHEMA_INVALID");
  });
});
