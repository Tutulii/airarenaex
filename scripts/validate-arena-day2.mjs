#!/usr/bin/env node

import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vectorPath = path.join(root, "config/arena-exchange/vectors/arc-market-spec-1x2.v1.json");
const contractPath = path.join(root, "docs/contracts/ARENA_EXCHANGE_MARKET_SPEC_V1.md");
const implementationPath = path.join(root, "arc-stack/src/market-spec.ts");

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function validate() {
  const [vectorText, contractText, packageText, vectorFiles] = await Promise.all([
    readFile(vectorPath, "utf8"),
    readFile(contractPath, "utf8"),
    readFile(path.join(root, "package.json"), "utf8"),
    readdir(path.dirname(vectorPath)),
    access(implementationPath),
  ]);
  const vector = JSON.parse(vectorText);
  const rootPackage = JSON.parse(packageText);

  invariant(vector.vectorVersion === 1, "golden vector version must be 1");
  invariant(vector.name === "arc-football-regulation-1x2-v1", "unexpected golden vector name");
  invariant(!vectorText.includes("PENDING"), "golden vector contains a pending value");
  invariant(vectorFiles.length === 1 && vectorFiles[0] === "arc-market-spec-1x2.v1.json", "ARC must have one unambiguous canonical vector");
  invariant(vector.draft?.schemaVersion === "arc-market-spec-v1", "wrong MarketSpec schema version");
  invariant(vector.draft?.chain?.network === "arc-testnet", "vector is not bound to ARC Testnet");
  invariant(vector.draft?.chain?.chainId === 5_042_002, "vector is not bound to ARC chain ID 5042002");
  invariant(
    vector.draft?.chain?.exchangeAddress === "0x1457B0E54f697E9662E1678b74f545CFCe17e96a",
    "vector exchange does not match the active ArenaExchange V2 deployment",
  );
  invariant(vector.draft?.collateral?.tokenAddress === "0x3600000000000000000000000000000000000000", "vector collateral does not match Day 1 scope");
  invariant(vector.draft?.category === "SPORTS", "only SPORTS may be executable");
  invariant(vector.draft?.parameters?.referenceData?.liveOddsExecution === "NEVER", "live odds must remain reference-only");
  invariant(vector.draft?.resolutionRule?.onDivergence === "INVALID", "source divergence must invalidate");
  invariant(vector.draft?.resolutionRule?.onUnavailable === "INVALID", "source unavailability must invalidate");
  invariant(/^0x[0-9a-f]{64}$/.test(vector.expected?.marketId), "marketId must be a lowercase bytes32 value");
  invariant(/^0x[0-9a-f]{64}$/.test(vector.expected?.specHash), "specHash must be a lowercase bytes32 value");
  invariant(typeof vector.expected?.canonicalIdentity === "string", "canonical identity is missing");
  invariant(typeof vector.expected?.canonicalSpecPayload === "string", "canonical spec payload is missing");
  JSON.parse(vector.expected.canonicalIdentity);
  JSON.parse(vector.expected.canonicalSpecPayload);

  for (const marker of [
    "Frozen for the capped ARC Testnet beta",
    "arc-stack/src/market-spec.ts",
    "arc-market-spec-1x2.v1.json",
    "Keccak256",
    "EVM `bytes32`",
    "Live odds are `REFERENCE_ONLY`",
    "two independent sources",
    "requires a new version and new golden vectors",
  ]) {
    invariant(contractText.includes(marker), `MarketSpec contract is missing: ${marker}`);
  }
  invariant(!contractText.includes("future `arena_exchange` Solana program"), "MarketSpec contract still describes the Solana target");
  invariant(!contractText.includes("SHA256("), "ARC MarketSpec must use Keccak-256, not SHA-256");

  invariant(rootPackage.scripts?.["roadmap:day2:check"]?.includes("arc-stack"), "Day 2 check is not routed to arc-stack");
  invariant(!rootPackage.scripts?.["roadmap:day2:check"]?.includes("api-server"), "Day 2 check still routes to the legacy API server");

  console.log(`AIR Arena ARC Day 2 artifact gate: PASS (${vector.expected.marketId})`);
}

validate().catch((error) => {
  console.error(`AIR Arena ARC Day 2 validation: FAIL - ${error.message}`);
  process.exitCode = 1;
});
