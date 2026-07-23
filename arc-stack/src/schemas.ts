import { getAddress, isAddress, isHex, keccak256, stringToHex, type Hex } from "viem";
import { z } from "zod";
import type { ArcCancel, ArcOrder } from "./chain.js";
import {
  MAX_ORDER_PRICE_PPM,
  MAX_ORDER_QUANTITY_ATOMS,
  MIN_ORDER_PRICE_PPM,
  MIN_ORDER_QUANTITY_ATOMS,
  ORDER_QUANTITY_STEP_ATOMS,
} from "./trading-policy.js";

const UintString = z.string().regex(/^(0|[1-9][0-9]*)$/);
const UINT64_MAX = (1n << 64n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
const Uint256 = UintString.transform(BigInt).refine((value) => value <= UINT256_MAX, "must fit uint256");
export const Bytes32Schema = z.string().refine((value) => isHex(value, { strict: true }) && value.length === 66, "must be bytes32");
const Address = z.string().refine(isAddress, "must be an EVM address").transform((value) => getAddress(value));
const Outcome = z.number().int().min(0).max(2);
const PricePpm = UintString.transform(BigInt).refine(
  (value) => value >= MIN_ORDER_PRICE_PPM && value <= MAX_ORDER_PRICE_PPM,
  `must be between ${MIN_ORDER_PRICE_PPM} and ${MAX_ORDER_PRICE_PPM}`,
);
const Quantity = UintString.transform(BigInt).refine(
  (value) => value >= MIN_ORDER_QUANTITY_ATOMS
    && value <= MAX_ORDER_QUANTITY_ATOMS
    && value % ORDER_QUANTITY_STEP_ATOMS === 0n,
  `must be ${MIN_ORDER_QUANTITY_ATOMS}-${MAX_ORDER_QUANTITY_ATOMS} in ${ORDER_QUANTITY_STEP_ATOMS}-atom steps`,
);
const FutureUnixTimestamp = UintString.transform(BigInt).refine(
  (value) => value > BigInt(Math.floor(Date.now() / 1000)) && value <= UINT64_MAX,
  "must be a future uint64 Unix timestamp",
);

export const PrepareOrderSchema = z.object({
  marketId: Bytes32Schema,
  outcome: Outcome,
  side: z.enum(["BUY", "SELL"]),
  pricePpm: PricePpm,
  quantity: Quantity,
  expiry: FutureUnixTimestamp,
  nonce: Uint256,
  clientOrderId: z.string().trim().min(1).max(128),
});

export const SubmitOrderSchema = z.object({
  order: z.object({
    maker: Address,
    marketId: Bytes32Schema,
    outcome: Outcome,
    isBuy: z.boolean(),
    pricePpm: PricePpm,
    quantity: Quantity,
    expiry: FutureUnixTimestamp,
    nonce: Uint256,
    clientOrderId: Bytes32Schema,
  }),
  signature: z.string().refine((value) => isHex(value, { strict: true }), "must be a hex signature"),
});

export const PrepareCancelSchema = z.object({
  orderHash: Bytes32Schema,
  nonce: Uint256,
  deadline: FutureUnixTimestamp,
});

export const SubmitCancelSchema = z.object({
  cancellation: z.object({
    maker: Address,
    orderHash: Bytes32Schema,
    nonce: Uint256,
    deadline: FutureUnixTimestamp,
  }),
  signature: z.string().refine((value) => isHex(value, { strict: true }), "must be a hex signature"),
});

export const CreateMarketSchema = z.object({
  fixtureId: z.string().trim().min(1).max(256),
  specHash: Bytes32Schema,
  outcomeCount: z.literal(3),
  closeTime: z.string().datetime({ offset: true }),
  category: z.literal("SPORTS").default("SPORTS"),
  oracleSource: z.literal("TXLINE").default("TXLINE"),
  displayTitle: z.string().trim().min(1).max(180).optional(),
  outcomeLabels: z.tuple([z.string().trim().min(1).max(80), z.string().trim().min(1).max(80), z.string().trim().min(1).max(80)])
    .default(["Home", "Draw", "Away"]),
  resolutionRules: z.string().trim().min(1).max(500).default("Regulation-time 1X2 result"),
  resolutionRule: z.object({
    primarySourceId: Bytes32Schema,
    witnessSourceId: Bytes32Schema,
    sourceEventId: Bytes32Schema,
    primarySigner: Address,
    witnessSigner: Address,
    maxReportAgeSeconds: UintString.transform(BigInt).refine((value) => value > 0n && value <= UINT64_MAX, "must be a positive uint64"),
    maxSourceTimestampSkewSeconds: UintString.transform(BigInt).refine((value) => value <= UINT64_MAX, "must fit uint64"),
    graceSeconds: UintString.transform(BigInt).refine((value) => value > 0n && value <= UINT64_MAX, "must be a positive uint64"),
  }).strict().refine((rule) => rule.primarySourceId !== rule.witnessSourceId, "sources must be independent")
    .refine((rule) => rule.primarySigner !== rule.witnessSigner, "signers must be independent"),
}).strict();

export const ResolutionReportSchema = z.object({
  sourceId: Bytes32Schema,
  sourceEventId: Bytes32Schema,
  observedAt: UintString.transform(BigInt).refine((value) => value <= UINT64_MAX, "must fit uint64"),
  publishedAt: UintString.transform(BigInt).refine((value) => value <= UINT64_MAX, "must fit uint64"),
  finalResult: z.boolean(),
  normalizedOutcome: Outcome,
  rawPayloadHash: Bytes32Schema,
  signatureEvidence: z.string().refine((value) => isHex(value, { strict: true }) && value.length > 2, "must be a non-empty hex signature"),
}).strict();

export const ResolveMarketSchema = z.object({
  primary: ResolutionReportSchema,
  witness: ResolutionReportSchema,
}).strict();

export function createArcOrder(
  maker: `0x${string}`,
  input: z.infer<typeof PrepareOrderSchema>,
): ArcOrder {
  return {
    maker: getAddress(maker),
    marketId: input.marketId as Hex,
    outcome: input.outcome,
    isBuy: input.side === "BUY",
    pricePpm: input.pricePpm,
    quantity: input.quantity,
    expiry: input.expiry,
    nonce: input.nonce,
    clientOrderId: keccak256(stringToHex(input.clientOrderId)),
  };
}

export function jsonOrder(order: ArcOrder): Record<string, string | number | boolean> {
  return {
    maker: order.maker,
    marketId: order.marketId,
    outcome: order.outcome,
    isBuy: order.isBuy,
    pricePpm: order.pricePpm.toString(),
    quantity: order.quantity.toString(),
    expiry: order.expiry.toString(),
    nonce: order.nonce.toString(),
    clientOrderId: order.clientOrderId,
  };
}

export function createArcCancel(
  maker: `0x${string}`,
  input: z.infer<typeof PrepareCancelSchema>,
): ArcCancel {
  return { maker: getAddress(maker), orderHash: input.orderHash as Hex, nonce: input.nonce, deadline: input.deadline };
}

export function jsonCancel(cancellation: ArcCancel): Record<string, string> {
  return {
    maker: cancellation.maker,
    orderHash: cancellation.orderHash,
    nonce: cancellation.nonce.toString(),
    deadline: cancellation.deadline.toString(),
  };
}

export function marketIdentifiers(fixtureId: string): { marketId: Hex; externalIdHash: Hex } {
  return {
    marketId: keccak256(stringToHex(`airarena:arc:market:${fixtureId}`)),
    externalIdHash: keccak256(stringToHex(`txline:${fixtureId}`)),
  };
}
