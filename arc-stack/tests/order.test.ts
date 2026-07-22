import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  acceptanceDomain,
  acceptanceTypes,
  cancelTypes,
  hashArcCancel,
  hashArcOrder,
  hashOrderAcceptance,
  orderDomain,
  orderTypes,
  type ArcCancel,
  type ArcOrder,
  type OrderAcceptance,
} from "../src/chain.js";

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
    expect(hash).toBe("0xbb655889b7b45ca288ac97b9b8ccf748fab1f8a96eaa343fb6fcb77700e28a6c");
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(orderDomain(exchange).chainId).toBe(5_042_002);
  });

  it("signs canonical cancellation envelopes in an independent nonce namespace", async () => {
    const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const exchange = "0x00000000000000000000000000000000000000A1";
    const cancellation: ArcCancel = {
      maker: account.address,
      orderHash: `0x${"33".repeat(32)}`,
      nonce: 1n,
      deadline: 2_000_000_000n,
    };
    const digest = hashArcCancel(exchange, cancellation);
    const signature = await account.signTypedData({
      domain: orderDomain(exchange),
      types: cancelTypes,
      primaryType: "Cancel",
      message: cancellation,
    });
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(digest).toBe("0xfe2db784b339d2fc1003166551d2f1c50fa6d457c3ddc9e940c0df763a56582f");
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
    await expect(recoverTypedDataAddress({
      domain: orderDomain(exchange),
      types: cancelTypes,
      primaryType: "Cancel",
      message: cancellation,
      signature,
    })).resolves.toBe(account.address);
  });

  it("binds signed acceptance receipts to the exchange, request, sequence, and timestamp", async () => {
    const signer = privateKeyToAccount("0x8b3a350cf5c34c9194ca3a545d48f0d9652f0d9f316f6c6f6c6f6c6f6c6f6c6f");
    const exchange = "0x00000000000000000000000000000000000000A1";
    const receipt: OrderAcceptance = {
      orderHash: `0x${"44".repeat(32)}`,
      maker: "0x00000000000000000000000000000000000000b2",
      sequence: 42n,
      acceptedAt: 2_000_000_000n,
      requestHash: `0x${"55".repeat(32)}`,
    };
    const digest = hashOrderAcceptance(exchange, receipt);
    const signature = await signer.signTypedData({
      domain: acceptanceDomain(exchange),
      types: acceptanceTypes,
      primaryType: "OrderAcceptance",
      message: receipt,
    });
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
    await expect(recoverTypedDataAddress({
      domain: acceptanceDomain(exchange),
      types: acceptanceTypes,
      primaryType: "OrderAcceptance",
      message: receipt,
      signature,
    })).resolves.toBe(signer.address);
    expect(hashOrderAcceptance("0x00000000000000000000000000000000000000b2", receipt)).not.toBe(digest);
    expect(hashOrderAcceptance(exchange, { ...receipt, sequence: 43n })).not.toBe(digest);
  });
});
