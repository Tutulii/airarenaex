import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalArcMarketIdentity,
  canonicalArcMarketSpecPayload,
  finalizeArcMarketSpec,
} from "../market-spec.js";

const arcStackDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const vectorPath = path.resolve(arcStackDir, "../config/arena-exchange/vectors/arc-market-spec-1x2.v1.json");
const vector = JSON.parse(await readFile(vectorPath, "utf8")) as { draft: unknown };
const finalized = finalizeArcMarketSpec(vector.draft);

process.stdout.write(`${JSON.stringify({
  canonicalIdentity: canonicalArcMarketIdentity(vector.draft),
  marketId: finalized.marketId,
  canonicalSpecPayload: canonicalArcMarketSpecPayload(vector.draft),
  specHash: finalized.specHash,
}, null, 2)}\n`);
