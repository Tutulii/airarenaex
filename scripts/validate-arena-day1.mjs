#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const scopePath = path.join(rootDir, "config/arena-exchange/beta-scope.v1.json");

export const requiredExclusions = Object.freeze([
  "subjective-or-freeform-markets",
  "leverage",
  "borrowing",
  "cross-margin",
  "correlation-discounts",
  "liquidation",
  "yield-bearing-collateral",
  "collateral-rehypothecation",
  "continuous-execution",
  "direct-amm-fills",
  "permissionless-market-creation",
  "cross-chain-collateral",
  "governance-selected-live-outcomes",
  "uncapped-deposits",
  "unregistered-oracle-adapters",
  "crypto-markets-without-approved-adapter",
  "politics-markets-without-approved-adapter",
  "unrestricted-public-mainnet",
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isIsoTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

export async function loadDay1Artifacts() {
  const scope = JSON.parse(await readFile(scopePath, "utf8"));
  const decisionRecords = new Map();
  for (const record of scope.decisionRecords ?? []) {
    const absoluteRecordPath = path.resolve(rootDir, record);
    invariant(
      absoluteRecordPath.startsWith(`${rootDir}${path.sep}`),
      `decision record escapes repository: ${record}`,
    );
    decisionRecords.set(record, await readFile(absoluteRecordPath, "utf8"));
  }
  return { scope, decisionRecords };
}

export function validateDay1Artifacts({ scope, decisionRecords }, { requireSignoff = false } = {}) {
  invariant(scope.schemaVersion === 1, "schemaVersion must be 1");
  invariant(scope.scopeId === "air-arena-arc-capped-beta-v1", "unexpected scopeId");
  invariant(["proposed", "approved"].includes(scope.status), "status must be proposed or approved");
  invariant(["pending", "approved"].includes(scope.approval?.status), "approval status must be pending or approved");
  invariant(
    (scope.status === "approved") === (scope.approval.status === "approved"),
    "scope and approval statuses must change together",
  );

  invariant(scope.launch?.chainFamily === "evm", "beta chain family must be EVM");
  invariant(scope.launch?.network === "arc-testnet", "beta network must be ARC Testnet");
  invariant(scope.launch?.chainId === 5_042_002, "ARC Testnet chain ID must be 5042002");
  invariant(scope.launch?.stage === "capped-arc-testnet-beta", "launch stage must remain capped ARC Testnet beta");
  invariant(scope.launch?.publicMainnet === false, "public mainnet must be disabled");
  invariant(scope.launch?.realValuePublicAccess === false, "real-value public access must be disabled");
  invariant(scope.launch?.allowlistRequired === true, "allowlist must be required");
  invariant(scope.launch?.depositCapsRequired === true, "deposit caps must be required");

  invariant(scope.collateral?.assetClass === "stable-erc20", "collateral must be a stable ERC-20");
  invariant(scope.collateral?.symbol === "USDC", "collateral symbol must be USDC");
  invariant(
    scope.collateral?.tokenAddress === "0x3600000000000000000000000000000000000000",
    "collateral must use the ARC Testnet USDC interface",
  );
  invariant(scope.collateral?.applicationDecimals === 6, "USDC application accounting must use six decimals");
  invariant(scope.collateral?.allowlistedTokenCount === 1, "exactly one collateral token must be allowlisted");
  invariant(scope.collateral?.nativeGasAssetAllowedAsCollateral === false, "native gas collateral must be disabled");
  invariant(scope.collateral?.yieldBearing === false, "yield-bearing collateral must be disabled");
  invariant(scope.collateral?.rehypothecation === false, "rehypothecation must be disabled");

  invariant(JSON.stringify(scope.markets?.activeCategories) === JSON.stringify(["SPORTS"]), "SPORTS must be the only active beta category");
  invariant(
    JSON.stringify(scope.markets?.reservedCategories) === JSON.stringify(["CRYPTO", "POLITICS"]),
    "CRYPTO and POLITICS must remain reserved until adapters are approved",
  );
  invariant(
    JSON.stringify(scope.markets?.templates) === JSON.stringify(["deterministic-sports-result"]),
    "only deterministic sports-result markets are allowed",
  );
  invariant(JSON.stringify(scope.markets?.outcomeCounts) === JSON.stringify([2, 3]), "only two- and three-outcome markets are allowed");
  invariant(scope.markets?.permissionlessCreation === false, "permissionless markets must be disabled");
  invariant(scope.markets?.subjective === false, "subjective markets must be disabled");
  invariant(scope.markets?.resolutionPolicy === "deterministic-or-invalid", "resolution must be deterministic or invalid");
  invariant(scope.markets?.unregisteredOracleAdaptersFailClosed === true, "unregistered oracle adapters must fail closed");

  invariant(scope.execution?.mechanism === "frequent-batch-auction", "execution must use frequent batch auctions");
  invariant(scope.execution?.signedLimitOrders === true, "orders must be signed limit orders");
  invariant(scope.execution?.signatureStandard === "EIP-712", "orders must use EIP-712");
  invariant(scope.execution?.contractWalletStandard === "ERC-1271", "contract wallets must use ERC-1271");
  for (const disabledField of ["continuousExecution", "directAmmFills", "leverage", "borrowing", "crossMargin"]) {
    invariant(scope.execution?.[disabledField] === false, `${disabledField} must be disabled`);
  }

  invariant(scope.productBoundary?.exchangeContract === "ArenaExchange", "exchange contract must be ArenaExchange");
  invariant(
    scope.productBoundary?.exchangeAddress === "0x6B42F8Ec16EE7C580213D0d07076019aBD6eE071",
    "exchange address changed without a scope version",
  );
  invariant(
    scope.productBoundary?.apiService === "airarena-arc-api" && scope.productBoundary?.apiSurface === "/v1",
    "ARC API boundary changed unexpectedly",
  );
  invariant(
    scope.productBoundary?.mcpService === "airarena-arc-mcp" && scope.productBoundary?.mcpToolPrefix === "airarena_arc_",
    "ARC MCP boundary changed unexpectedly",
  );
  invariant(scope.productBoundary?.databaseNamespace === "arc_", "ARC database namespace must be arc_");
  invariant(scope.productBoundary?.sharesAirOtcFinancialState === false, "AIR OTC financial state must remain isolated");
  invariant(scope.productBoundary?.sharesSolanaFinancialState === false, "Solana financial state must remain isolated");
  invariant(scope.productBoundary?.extendLegacyDealStateMachine === false, "legacy Deal state machine must remain isolated");

  invariant(Array.isArray(scope.excludedFeatures), "excludedFeatures must be an array");
  invariant(new Set(scope.excludedFeatures).size === scope.excludedFeatures.length, "excludedFeatures must not contain duplicates");
  for (const exclusion of requiredExclusions) {
    invariant(scope.excludedFeatures.includes(exclusion), `missing exclusion: ${exclusion}`);
  }

  invariant(Array.isArray(scope.decisionRecords) && scope.decisionRecords.length === 3, "exactly three Day 1 decision records are required");
  invariant(new Set(scope.decisionRecords).size === 3, "decision records must be unique");
  invariant(decisionRecords instanceof Map, "decisionRecords must be a Map");
  invariant(decisionRecords.size === 3, "all three decision records must be loaded");
  for (const record of scope.decisionRecords) {
    invariant(record.startsWith("docs/adr/"), `decision record must be stored under docs/adr: ${record}`);
    const recordText = decisionRecords.get(record);
    invariant(typeof recordText === "string", `decision record is missing: ${record}`);
    invariant(
      recordText.includes("- Scope manifest: `config/arena-exchange/beta-scope.v1.json`"),
      `decision record is not bound to the canonical scope manifest: ${record}`,
    );
    invariant(
      recordText.includes(scope.status === "approved" ? "- Status: Accepted" : "- Status: Proposed"),
      `decision record status does not match the scope manifest: ${record}`,
    );
    invariant(recordText.includes("ARC Testnet"), `decision record does not bind ARC Testnet: ${record}`);

    if (scope.approval.status === "approved") {
      invariant(!recordText.includes("PENDING"), `approved decision record still contains PENDING: ${record}`);
      invariant(recordText.includes("- Status: APPROVED"), `owner sign-off is missing: ${record}`);
      invariant(recordText.includes(`- Approved by: ${scope.approval.approvedBy}`), `approvedBy does not match the scope manifest: ${record}`);
      invariant(recordText.includes(`- Approved at: ${scope.approval.approvedAt}`), `approvedAt does not match the scope manifest: ${record}`);
      invariant(
        recordText.includes(`- Approval reference: ${scope.approval.approvalReference}`),
        `approvalReference does not match the scope manifest: ${record}`,
      );
    }
  }

  if (scope.approval.status === "approved") {
    invariant(typeof scope.approval.approvedBy === "string" && scope.approval.approvedBy.trim().length > 0, "approvedBy is required");
    invariant(isIsoTimestamp(scope.approval.approvedAt), "approvedAt must be an ISO timestamp");
    invariant(
      typeof scope.approval.approvalReference === "string" && scope.approval.approvalReference.trim().length > 0,
      "approvalReference is required",
    );
  }

  if (requireSignoff) invariant(scope.status === "approved", "scope status is not approved");
  return { scopeId: scope.scopeId, status: scope.status };
}

async function main() {
  const requireSignoff = process.argv.includes("--require-signoff");
  const artifacts = await loadDay1Artifacts();
  const result = validateDay1Artifacts(artifacts, { requireSignoff });
  console.log(`AIR Arena Day 1 ${requireSignoff ? "exit gate" : "scope check"}: PASS (${result.scopeId})`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`AIR Arena Day 1 validation: FAIL - ${error.message}`);
    process.exitCode = 1;
  });
}
