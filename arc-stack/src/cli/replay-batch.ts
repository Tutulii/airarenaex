import { readFile } from "node:fs/promises";
import { replayPublicBatchBundle, type PublicBatchBundle } from "../batch-bundle.js";

const path = process.argv[2];
if (!path) throw new Error("usage: npm run batch:replay -- <public-batch-bundle.json>");
const bundle = JSON.parse(await readFile(path, "utf8")) as PublicBatchBundle;
const replay = replayPublicBatchBundle(bundle);
process.stdout.write(`${JSON.stringify({
  valid: replay.valid,
  batchId: bundle.batchId,
  bundleHash: replay.actualBundleHash,
  resultHash: replay.actualResultHash,
  clearingPricePpm: replay.result.clearingPricePpm?.toString() ?? null,
  executableQuantity: replay.result.executableQuantity.toString(),
}, null, 2)}\n`);
if (!replay.valid) process.exitCode = 1;
