import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { getAddress, type Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import {
  BATCH_BUNDLE_POLICY_HASH,
  buildPublicBatchBundle,
  replayPublicBatchBundle,
  type PublicBatchOrder,
} from "../src/batch-bundle.js";

const temporaryDirectories: string[] = [];
const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const replayCliPath = join(packageDirectory, "src/cli/replay-batch.ts");
const tsxLoaderPath = createRequire(import.meta.url).resolve("tsx");
afterEach(() => temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function order(index: number, side: "BUY" | "SELL", lots: bigint): PublicBatchOrder {
  const hash = `0x${index.toString(16).padStart(64, "0")}` as Hex;
  return {
    orderHash: hash,
    maker: getAddress(`0x${index.toString(16).padStart(40, "0")}`),
    side,
    pricePpm: side === "BUY" ? 600_000n : 400_000n,
    quantity: lots * 10_000n,
    filledQuantity: 0n,
    expiryUnix: 2_000_000_000n,
    nonce: BigInt(index),
    clientOrderId: `0x${(index + 100).toString(16).padStart(64, "0")}`,
    signature: `0x${"11".repeat(65)}`,
    acceptedSequence: BigInt(index),
  };
}

describe("public batch replay bundle", () => {
  it("replays byte-identically in-process and through the standalone CLI", () => {
    const bundle = buildPublicBatchBundle({
      batchId: `0x${"aa".repeat(32)}`,
      chainId: 5_042_002,
      exchangeAddress: getAddress("0x00000000000000000000000000000000000000a1"),
      marketId: `0x${"bb".repeat(32)}`,
      outcome: 1,
      cutoffUnix: 1_900_000_000n,
      cancellationCutoffUnixMs: 1_899_999_999_800n,
      policyHash: BATCH_BUNDLE_POLICY_HASH,
      orders: [order(1, "BUY", 7n), order(2, "BUY", 5n), order(3, "SELL", 6n), order(4, "SELL", 4n)],
    });
    const replay = replayPublicBatchBundle(bundle);
    expect(replay.valid).toBe(true);
    expect(replay.expectedBundleHash).toBe(bundle.bundleHash);
    expect(replay.expectedResultHash).toBe(bundle.resultHash);

    const directory = mkdtempSync(join(tmpdir(), "airarena-batch-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "bundle.json");
    writeFileSync(file, `${JSON.stringify(bundle)}\n`, { mode: 0o600 });
    const cli = spawnSync(process.execPath, ["--import", tsxLoaderPath, replayCliPath, file], {
      // Prove that the operator CLI is independent of the caller's working directory.
      cwd: directory, encoding: "utf8",
    });
    expect(cli.stderr).toBe("");
    expect(cli.status).toBe(0);
    const output = JSON.parse(cli.stdout) as { valid: boolean; bundleHash: Hex; resultHash: Hex };
    expect(output).toMatchObject({ valid: true, bundleHash: bundle.bundleHash, resultHash: bundle.resultHash });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(bundle);
  });

  it("fails closed when any public order is mutated", () => {
    const bundle = buildPublicBatchBundle({
      batchId: `0x${"dd".repeat(32)}`,
      chainId: 5_042_002,
      exchangeAddress: getAddress("0x00000000000000000000000000000000000000a1"),
      marketId: `0x${"ee".repeat(32)}`,
      outcome: 0,
      cutoffUnix: 1_900_000_000n,
      cancellationCutoffUnixMs: 1_899_999_999_800n,
      policyHash: BATCH_BUNDLE_POLICY_HASH,
      orders: [order(10, "BUY", 2n), order(11, "SELL", 2n)],
    });
    const mutated = structuredClone(bundle);
    mutated.orders[0]!.quantity = "30000";
    expect(replayPublicBatchBundle(mutated).valid).toBe(false);
  });

  it("fails closed for an unsupported clearing policy", () => {
    const input = {
      batchId: `0x${"ab".repeat(32)}` as Hex,
      chainId: 5_042_002,
      exchangeAddress: getAddress("0x00000000000000000000000000000000000000a1"),
      marketId: `0x${"bc".repeat(32)}` as Hex,
      outcome: 0,
      cutoffUnix: 1_900_000_000n,
      cancellationCutoffUnixMs: 1_899_999_999_800n,
      policyHash: BATCH_BUNDLE_POLICY_HASH,
      orders: [order(20, "BUY", 2n), order(21, "SELL", 2n)],
    };
    const bundle = buildPublicBatchBundle(input);
    expect(replayPublicBatchBundle({ ...bundle, policyVersion: "unknown-policy" }).valid).toBe(false);
    expect(() => buildPublicBatchBundle({ ...input, policyHash: `0x${"ff".repeat(32)}` }))
      .toThrow("unsupported_batch_policy_hash");
  });
});
