import { getAddress, isAddress, isHex, keccak256, stringToHex, type Hex } from "viem";
import { z } from "zod";
import type { ArcOrder } from "./chain.js";

const UintString = z.string().regex(/^(0|[1-9][0-9]*)$/);
const Bytes32 = z.string().refine((value) => isHex(value, { strict: true }) && value.length === 66, "must be bytes32");
const Address = z.string().refine(isAddress, "must be an EVM address").transform((value) => getAddress(value));
const Outcome = z.number().int().min(0).max(2);
const PricePpm = UintString.transform(BigInt).refine((value) => value > 0n && value < 1_000_000n);
const Quantity = UintString.transform(BigInt).refine((value) => value > 0n && value <= (2n ** 128n - 1n));
const FutureUnixTimestamp = UintString.transform(BigInt).refine(
  (value) => value > BigInt(Math.floor(Date.now() / 1000)),
  "must be in the future",
);

export const PrepareOrderSchema = z.object({
  marketId: Bytes32,
  outcome: Outcome,
  side: z.enum(["BUY", "SELL"]),
  pricePpm: PricePpm,
  quantity: Quantity,
  expiry: FutureUnixTimestamp,
  nonce: UintString.transform(BigInt),
  clientOrderId: z.string().trim().min(1).max(128),
});

export const SubmitOrderSchema = z.object({
  order: z.object({
    maker: Address,
    marketId: Bytes32,
    outcome: Outcome,
    isBuy: z.boolean(),
    pricePpm: PricePpm,
    quantity: Quantity,
    expiry: FutureUnixTimestamp,
    nonce: UintString.transform(BigInt),
    clientOrderId: Bytes32,
  }),
  signature: z.string().refine((value) => isHex(value, { strict: true }), "must be a hex signature"),
});

export const CreateMarketSchema = z.object({
  fixtureId: z.string().trim().min(1).max(256),
  outcomeCount: z.literal(3),
  closeTime: z.string().datetime({ offset: true }),
  category: z.literal("SPORTS").default("SPORTS"),
  oracleSource: z.literal("TXLINE").default("TXLINE"),
  displayTitle: z.string().trim().min(1).max(180).optional(),
  outcomeLabels: z.tuple([z.string().trim().min(1).max(80), z.string().trim().min(1).max(80), z.string().trim().min(1).max(80)])
    .default(["Home", "Draw", "Away"]),
  resolutionRules: z.string().trim().min(1).max(500).default("Regulation-time 1X2 result"),
});

export const ResolveMarketSchema = z.object({ winningOutcome: z.number().int().min(0).max(2) });

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

export function marketIdentifiers(fixtureId: string): { marketId: Hex; externalIdHash: Hex } {
  return {
    marketId: keccak256(stringToHex(`airarena:arc:market:${fixtureId}`)),
    externalIdHash: keccak256(stringToHex(`txline:${fixtureId}`)),
  };
}
