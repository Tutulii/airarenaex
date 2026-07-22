import { describe, expect, it } from "vitest";
import { PrepareCancelSchema, PrepareOrderSchema, SubmitOrderSchema } from "../src/schemas.js";

const future = String(Math.floor(Date.now() / 1000) + 3_600);
const baseOrder = {
  marketId: `0x${"11".repeat(32)}`,
  outcome: 0,
  side: "BUY" as const,
  pricePpm: "500000",
  quantity: "10000",
  expiry: future,
  nonce: "1",
  clientOrderId: "schema-boundary-vector",
};

describe("signed envelope schema boundaries", () => {
  it("accepts the executable lot size and rejects dust or off-step quantities", () => {
    expect(PrepareOrderSchema.safeParse(baseOrder).success).toBe(true);
    expect(PrepareOrderSchema.safeParse({ ...baseOrder, quantity: "9999" }).success).toBe(false);
    expect(PrepareOrderSchema.safeParse({ ...baseOrder, quantity: "10001" }).success).toBe(false);
  });

  it("rejects values that cannot be represented by the Solidity envelope", () => {
    const uint64Overflow = (1n << 64n).toString();
    const uint256Overflow = (1n << 256n).toString();
    expect(PrepareOrderSchema.safeParse({ ...baseOrder, expiry: uint64Overflow }).success).toBe(false);
    expect(PrepareOrderSchema.safeParse({ ...baseOrder, nonce: uint256Overflow }).success).toBe(false);
    expect(PrepareCancelSchema.safeParse({
      orderHash: baseOrder.marketId,
      nonce: uint256Overflow,
      deadline: future,
    }).success).toBe(false);
  });

  it("applies the same constraints to submitted signed orders", () => {
    expect(SubmitOrderSchema.safeParse({
      order: {
        maker: "0x00000000000000000000000000000000000000a1",
        marketId: baseOrder.marketId,
        outcome: 0,
        isBuy: true,
        pricePpm: "500000",
        quantity: "10001",
        expiry: future,
        nonce: "1",
        clientOrderId: `0x${"22".repeat(32)}`,
      },
      signature: "0x1234",
    }).success).toBe(false);
  });
});
