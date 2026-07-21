import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { hashArcOrder, orderDomain, orderTypes, type ArcOrder } from "../src/chain.js";

describe("Arc order domain", () => {
  it("binds signatures to Arc chain ID and the exchange contract", async () => {
    const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const exchange = "0x00000000000000000000000000000000000000A1";
    const order: ArcOrder = {
      maker: account.address,
      marketId: `0x${"11".repeat(32)}`,
      outcome: 1,
      isBuy: true,
      pricePpm: 550_000n,
      quantity: 10_000_000n,
      expiry: 2_000_000_000n,
      nonce: 1n,
      clientOrderId: `0x${"22".repeat(32)}`,
    };
    const hash = hashArcOrder(exchange, order);
    const signature = await account.signTypedData({
      domain: orderDomain(exchange),
      types: orderTypes,
      primaryType: "Order",
      message: order,
    });
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(orderDomain(exchange).chainId).toBe(5_042_002);
  });
});
