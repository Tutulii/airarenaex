import { keccak256, stringToHex, type Address, type Hex } from "viem";
import {
  BATCH_POLICY_VERSION,
  clearUniformPriceBatch,
  type BatchClearingResult,
  type ClearingFill,
  type ClearingOrder,
} from "./batch-clearing.js";
import { canonicalJson } from "./order-intake.js";

export const BATCH_BUNDLE_SCHEMA_VERSION = "airarena.arc.batch.v1";
export const BATCH_BUNDLE_POLICY_HASH = keccak256(stringToHex(BATCH_POLICY_VERSION));
const EMPTY_MERKLE_ROOT = keccak256(stringToHex("AIR_ARENA_EMPTY_MERKLE_TREE_V1"));

export type PublicBatchOrder = ClearingOrder & {
  nonce: bigint;
  clientOrderId: Hex;
  signature: Hex;
  acceptedSequence: bigint;
};

export type JsonBatchOrder = {
  orderHash: Hex;
  maker: Address;
  side: "BUY" | "SELL";
  pricePpm: string;
  quantity: string;
  filledQuantity: string;
  expiryUnix: string;
  nonce: string;
  clientOrderId: Hex;
  signature: Hex;
  acceptedSequence: string;
};

export type JsonBatchFill = {
  buyOrderHash: Hex;
  sellOrderHash: Hex;
  quantity: string;
};

export type PublicBatchBundle = {
  schemaVersion: typeof BATCH_BUNDLE_SCHEMA_VERSION;
  batchId: Hex;
  chainId: number;
  exchangeAddress: Address;
  marketId: Hex;
  outcome: number;
  cutoffUnix: string;
  cancellationCutoffUnixMs: string;
  policyVersion: string;
  policyHash: Hex;
  orderRoot: Hex;
  fillRoot: Hex;
  inputRoot: Hex;
  resultHash: Hex;
  clearingPricePpm: string | null;
  executableQuantity: string;
  orders: JsonBatchOrder[];
  fills: JsonBatchFill[];
  bundleHash: Hex;
};

type BundleInput = {
  batchId: Hex;
  chainId: number;
  exchangeAddress: Address;
  marketId: Hex;
  outcome: number;
  cutoffUnix: bigint;
  cancellationCutoffUnixMs: bigint;
  policyHash: Hex;
  orders: PublicBatchOrder[];
};

function hashValue(domain: string, value: unknown): Hex {
  return keccak256(stringToHex(canonicalJson({ domain, value })));
}

export function merkleRoot(domain: string, values: unknown[]): Hex {
  if (values.length === 0) return EMPTY_MERKLE_ROOT;
  let layer = values.map((value, index) => hashValue(`${domain}:LEAF`, { index, value }));
  while (layer.length > 1) {
    const next: Hex[] = [];
    for (let index = 0; index < layer.length; index += 2) {
      const left = layer[index]!;
      const right = layer[index + 1] ?? left;
      next.push(hashValue(`${domain}:NODE`, { left, right }));
    }
    layer = next;
  }
  return layer[0]!;
}

function jsonOrder(order: PublicBatchOrder): JsonBatchOrder {
  return {
    orderHash: order.orderHash,
    maker: order.maker,
    side: order.side,
    pricePpm: order.pricePpm.toString(),
    quantity: order.quantity.toString(),
    filledQuantity: order.filledQuantity.toString(),
    expiryUnix: order.expiryUnix.toString(),
    nonce: order.nonce.toString(),
    clientOrderId: order.clientOrderId,
    signature: order.signature,
    acceptedSequence: order.acceptedSequence.toString(),
  };
}

function jsonFill(fill: ClearingFill): JsonBatchFill {
  return { ...fill, quantity: fill.quantity.toString() };
}

function clearingOrder(order: JsonBatchOrder): ClearingOrder {
  return {
    orderHash: order.orderHash,
    maker: order.maker,
    side: order.side,
    pricePpm: BigInt(order.pricePpm),
    quantity: BigInt(order.quantity),
    filledQuantity: BigInt(order.filledQuantity),
    expiryUnix: BigInt(order.expiryUnix),
  };
}

function bundleWithoutHash(bundle: PublicBatchBundle): Omit<PublicBatchBundle, "bundleHash"> {
  const { bundleHash: _bundleHash, ...value } = bundle;
  return value;
}

export function buildPublicBatchBundle(input: BundleInput): PublicBatchBundle {
  if (input.policyHash.toLowerCase() !== BATCH_BUNDLE_POLICY_HASH.toLowerCase()) {
    throw new Error("unsupported_batch_policy_hash");
  }
  const ordered = [...input.orders].sort((left, right) =>
    left.orderHash.toLowerCase().localeCompare(right.orderHash.toLowerCase()),
  );
  const result = clearUniformPriceBatch(ordered, input.cutoffUnix, { batchId: input.batchId });
  const byHash = new Map(ordered.map((order) => [order.orderHash.toLowerCase(), order]));
  const eligibleOrders = result.orderedEligibleOrders.map((order) => {
    const publicOrder = byHash.get(order.orderHash.toLowerCase());
    if (!publicOrder) throw new Error("batch_bundle_order_metadata_missing");
    return jsonOrder(publicOrder);
  });
  const fills = result.fills.map(jsonFill);
  const withoutHash: Omit<PublicBatchBundle, "bundleHash"> = {
    schemaVersion: BATCH_BUNDLE_SCHEMA_VERSION,
    batchId: input.batchId,
    chainId: input.chainId,
    exchangeAddress: input.exchangeAddress,
    marketId: input.marketId,
    outcome: input.outcome,
    cutoffUnix: input.cutoffUnix.toString(),
    cancellationCutoffUnixMs: input.cancellationCutoffUnixMs.toString(),
    policyVersion: BATCH_POLICY_VERSION,
    policyHash: input.policyHash,
    orderRoot: merkleRoot("AIR_ARENA_BATCH_ORDER_V1", eligibleOrders),
    fillRoot: merkleRoot("AIR_ARENA_BATCH_FILL_V1", fills),
    inputRoot: result.inputRoot,
    resultHash: result.resultHash,
    clearingPricePpm: result.clearingPricePpm?.toString() ?? null,
    executableQuantity: result.executableQuantity.toString(),
    orders: eligibleOrders,
    fills,
  };
  return { ...withoutHash, bundleHash: hashValue("AIR_ARENA_BATCH_BUNDLE_V1", withoutHash) };
}

export type BatchReplayResult = {
  valid: boolean;
  expectedBundleHash: Hex;
  actualBundleHash: Hex;
  expectedResultHash: Hex;
  actualResultHash: Hex;
  result: BatchClearingResult;
};

export function replayPublicBatchBundle(bundle: PublicBatchBundle): BatchReplayResult {
  if (bundle.schemaVersion !== BATCH_BUNDLE_SCHEMA_VERSION) throw new Error("unsupported_batch_bundle_schema");
  const result = clearUniformPriceBatch(
    bundle.orders.map(clearingOrder),
    BigInt(bundle.cutoffUnix),
    { batchId: bundle.batchId },
  );
  const expectedOrderRoot = merkleRoot("AIR_ARENA_BATCH_ORDER_V1", bundle.orders);
  const expectedFills = result.fills.map(jsonFill);
  const expectedFillRoot = merkleRoot("AIR_ARENA_BATCH_FILL_V1", expectedFills);
  const expectedBundleHash = hashValue("AIR_ARENA_BATCH_BUNDLE_V1", bundleWithoutHash(bundle));
  return {
    valid:
      bundle.policyVersion === BATCH_POLICY_VERSION
      && bundle.policyHash.toLowerCase() === BATCH_BUNDLE_POLICY_HASH.toLowerCase()
      && expectedBundleHash.toLowerCase() === bundle.bundleHash.toLowerCase()
      && expectedOrderRoot.toLowerCase() === bundle.orderRoot.toLowerCase()
      && expectedFillRoot.toLowerCase() === bundle.fillRoot.toLowerCase()
      && result.inputRoot.toLowerCase() === bundle.inputRoot.toLowerCase()
      && result.resultHash.toLowerCase() === bundle.resultHash.toLowerCase()
      && canonicalJson(expectedFills) === canonicalJson(bundle.fills),
    expectedBundleHash,
    actualBundleHash: bundle.bundleHash,
    expectedResultHash: result.resultHash,
    actualResultHash: bundle.resultHash,
    result,
  };
}
