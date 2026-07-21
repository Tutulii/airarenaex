import assert from "node:assert/strict";
import test from "node:test";

import { loadDay1Artifacts, validateDay1Artifacts } from "../scripts/validate-arena-day1.mjs";

const source = await loadDay1Artifacts();

function artifacts(mutator) {
  const copy = {
    scope: structuredClone(source.scope),
    decisionRecords: new Map(source.decisionRecords),
  };
  mutator(copy);
  return copy;
}

function rejects(mutator, pattern) {
  assert.throws(() => validateDay1Artifacts(artifacts(mutator), { requireSignoff: true }), pattern);
}

test("canonical ARC Day 1 scope passes the signed exit gate", () => {
  assert.deepEqual(validateDay1Artifacts(source, { requireSignoff: true }), {
    scopeId: "air-arena-arc-capped-beta-v1",
    status: "approved",
  });
});

test("wrong chain id fails closed", () => {
  rejects(({ scope }) => { scope.launch.chainId = 1; }, /chain ID/);
});

test("wrong collateral address fails closed", () => {
  rejects(({ scope }) => { scope.collateral.tokenAddress = "0x0000000000000000000000000000000000000001"; }, /USDC interface/);
});

test("native gas collateral cannot be enabled", () => {
  rejects(({ scope }) => { scope.collateral.nativeGasAssetAllowedAsCollateral = true; }, /native gas collateral/);
});

test("reserved categories cannot become executable", () => {
  rejects(({ scope }) => { scope.markets.activeCategories.push("CRYPTO"); }, /only active beta category/);
});

test("unregistered adapters must remain fail closed", () => {
  rejects(({ scope }) => { scope.markets.unregisteredOracleAdaptersFailClosed = false; }, /fail closed/);
});

test("financial state cannot be shared with another product", () => {
  rejects(({ scope }) => { scope.productBoundary.sharesAirOtcFinancialState = true; }, /financial state/);
});

test("every required exclusion is binding", () => {
  rejects(({ scope }) => { scope.excludedFeatures = scope.excludedFeatures.filter((value) => value !== "leverage"); }, /missing exclusion: leverage/);
});

test("approval metadata and ADR status cannot diverge", () => {
  rejects(({ scope }) => { scope.approval.status = "pending"; }, /statuses must change together/);
});

test("ADR sign-off must exactly match the canonical manifest", () => {
  rejects(({ scope, decisionRecords }) => {
    const [record] = scope.decisionRecords;
    decisionRecords.set(record, decisionRecords.get(record).replace(scope.approval.approvalReference, "wrong-reference"));
  }, /approvalReference/);
});
