import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress, type Hex } from "viem";
import { ORACLE_ADAPTERS, parseSportmonksOracleReport, parseTxlineOracleReport } from "../src/oracle-adapter.js";
import {
  assertQualifyingWitness,
  evaluateOracleQuorum,
  resolutionReportTypes,
  signOracleReport,
} from "../src/oracle-state.js";

const primaryKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const exchange = "0x6B42F8Ec16EE7C580213D0d07076019aBD6eE071";

function primary(at = "2026-07-23T12:00:00.000Z") {
  return parseTxlineOracleReport({
    success: true,
    data: {
      fixtureId: "fixture-1", status: "final", homeScore: 1, awayScore: 0, winner: "part1",
      sourceUpdateId: "10", sourceTimestamp: at, sequence: 10,
    },
  }, undefined, at);
}

function witness(at = "2026-07-23T12:00:01.000Z", score: [number, number] = [1, 0]) {
  return parseSportmonksOracleReport({
    data: {
      id: "witness-1", state: { short_name: "FT" }, participants: [],
      scores: [
        { description: "CURRENT", score: { participant: "home", goals: score[0] } },
        { description: "CURRENT", score: { participant: "away", goals: score[1] } },
      ],
    },
    subscription: [{ type: "trial" }],
  }, undefined, at);
}

describe("independent witness and evidence binding", () => {
  it("rejects market witness qualification without a free authenticated credential", () => {
    const binding = {
      adapterId: ORACLE_ADAPTERS.SPORTMONKS_V1,
      fixtureIdentity: "9901",
      accessTier: "TRIAL" as const,
      authenticated: true as const,
    };
    expect(() => assertQualifyingWitness(binding, {})).toThrow("oracle_witness_credential_unavailable");
    expect(() => assertQualifyingWitness(binding, { sportmonksApiToken: "credential-present" })).not.toThrow();
  });

  it("requires fresh primary plus witness agreement", () => {
    const options = { nowMs: Date.parse("2026-07-23T12:00:02.000Z"), maxAgeSeconds: 30, maxSkewSeconds: 10 };
    expect(evaluateOracleQuorum(primary(), witness(), options)).toMatchObject({ state: "HEALTHY", outcome: 0 });
    expect(evaluateOracleQuorum(primary(), witness(undefined, [0, 1]), options)).toMatchObject({ state: "DIVERGENT", outcome: null });
    expect(evaluateOracleQuorum(primary("2026-07-23T11:00:00.000Z"), witness(), options)).toMatchObject({ state: "STALE", outcome: null });
    expect(evaluateOracleQuorum(primary(), null, options)).toMatchObject({ state: "UNAVAILABLE", outcome: null });
  });

  it("signs the exact Day 18 EIP-712 evidence envelope", async () => {
    const report = primary();
    const signed = await signOracleReport({
      privateKey: primaryKey,
      chainId: 5_042_002,
      exchangeAddress: exchange,
      marketId: `0x${"11".repeat(32)}`,
      specHash: `0x${"22".repeat(32)}`,
      sourceId: `0x${"33".repeat(32)}`,
      sourceEventId: `0x${"44".repeat(32)}`,
      report,
    });
    const signer = await recoverTypedDataAddress({
      domain: { name: "AIR Arena Arc", version: "1", chainId: 5_042_002, verifyingContract: exchange },
      types: resolutionReportTypes,
      primaryType: "ResolutionReport",
      message: {
        marketId: `0x${"11".repeat(32)}`,
        specHash: `0x${"22".repeat(32)}`,
        sourceId: signed.sourceId,
        sourceEventId: signed.sourceEventId,
        observedAt: signed.observedAt,
        publishedAt: signed.publishedAt,
        finalResult: signed.finalResult,
        normalizedOutcome: signed.normalizedOutcome,
        rawPayloadHash: signed.rawPayloadHash,
      },
      signature: signed.signatureEvidence,
    });
    expect(signer).toBe(privateKeyToAccount(primaryKey).address);
  });
});
