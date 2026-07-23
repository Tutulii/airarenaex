import { afterEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { cancelProtocolLiquidityOrders, submitProtocolLiquidityQuote } from "../src/liquidity-agent.js";

const key = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const marketId = `0x${"11".repeat(32)}` as Hex;

const config = {
  apiUrl: "https://arc-api.example",
  liquidityAgentPrivateKey: key,
  liquidityLimits: {
    vaultAtoms: 1_000_000n,
    inventoryAtoms: 1_000_000n,
    notionalAtoms: 1_000_000n,
    lossAtoms: 100_000n,
    drawdownAtoms: 100_000n,
    dailyVolumeAtoms: 500_000n,
  },
};

const riskState = {
  fundedAtoms: 500_000n,
  availableAtoms: 500_000n,
  inventoryAtoms: 0n,
  openNotionalAtoms: 0n,
  realizedPnlAtoms: 0n,
  peakEquityAtoms: 500_000n,
  currentEquityAtoms: 500_000n,
  dailyVolumeAtoms: 0n,
};

const quote = {
  marketId,
  outcome: 0 as const,
  side: "BUY" as const,
  pricePpm: 500_000n,
  quantity: 100_000n,
  expiry: 2_000_000_000n,
  nonce: 7n,
  clientOrderId: `0x${"22".repeat(32)}`,
};

afterEach(() => vi.unstubAllGlobals());

describe("protocol liquidity agent", () => {
  it("stops before network activity in the same cycle when oracle health is bad", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitProtocolLiquidityQuote({ config, quote, riskState, oracleHealthy: false }))
      .rejects.toThrow("liquidity_oracle_unhealthy");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("authenticates, prepares, signs, and submits through the ordinary public order path", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const responses = [
      { success: true, data: { nonce: "challenge-1", message: "Sign this AIR Arena challenge" } },
      { success: true, data: { token: "agent-token" } },
      {
        success: true,
        data: {
          orderHash: `0x${"33".repeat(32)}`,
          order: {
            maker: "0x0000000000000000000000000000000000000001",
            marketId,
            outcome: 0,
            isBuy: true,
            pricePpm: "500000",
            quantity: "100000",
            expiry: "2000000000",
            nonce: "7",
            clientOrderId: quote.clientOrderId,
          },
          typedData: {
            domain: { name: "AIR Arena Arc", version: "1", chainId: 5_042_002, verifyingContract: "0x6B42F8Ec16EE7C580213D0d07076019aBD6eE071" },
            types: { Order: [
              { name: "maker", type: "address" }, { name: "marketId", type: "bytes32" },
              { name: "outcome", type: "uint8" }, { name: "isBuy", type: "bool" },
              { name: "pricePpm", type: "uint64" }, { name: "quantity", type: "uint128" },
              { name: "expiry", type: "uint64" }, { name: "nonce", type: "uint256" },
              { name: "clientOrderId", type: "bytes32" },
            ] },
            primaryType: "Order",
            message: {
              maker: "0x0000000000000000000000000000000000000001", marketId, outcome: 0, isBuy: true,
              pricePpm: 500_000n, quantity: 100_000n, expiry: 2_000_000_000n, nonce: 7n,
              clientOrderId: quote.clientOrderId,
            },
          },
        },
      },
      { success: true, data: { orderHash: `0x${"33".repeat(32)}`, job: { id: "job-1" } } },
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(responses[calls.length - 1], (_key, value: unknown) => (
        typeof value === "bigint" ? value.toString() : value
      )), {
        status: calls.length === 4 ? 202 : 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const result = await submitProtocolLiquidityQuote({ config, quote, riskState, oracleHealthy: true });
    expect(result.orderHash).toBe(`0x${"33".repeat(32)}`);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/v1/auth/challenge", "/v1/auth/token", "/v1/orders/prepare", "/v1/orders/submit",
    ]);
    expect(calls[3]!.init.headers).toMatchObject({
      authorization: "Bearer agent-token",
      "idempotency-key": expect.stringContaining(":7"),
    });
  });

  it("cancels resting maker orders only through the signed public cancellation path", async () => {
    const calls: string[] = [];
    const maker = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const orderHash = `0x${"44".repeat(32)}`;
    const responses: unknown[] = [
      { success: true, data: { nonce: "challenge-2", message: "Sign this AIR Arena challenge" } },
      { success: true, data: { token: "agent-token" } },
      { success: true, data: [{ order_hash: orderHash, market_id: marketId, status: "ACTIVE" }] },
      {
        success: true,
        data: {
          cancellationHash: `0x${"55".repeat(32)}`,
          cancellation: { maker, orderHash, nonce: "1700000000000", deadline: "1700000300" },
          typedData: {
            domain: { name: "AIR Arena Arc", version: "1", chainId: 5_042_002, verifyingContract: "0x6B42F8Ec16EE7C580213D0d07076019aBD6eE071" },
            types: { Cancel: [
              { name: "maker", type: "address" }, { name: "orderHash", type: "bytes32" },
              { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint64" },
            ] },
            primaryType: "Cancel",
            message: { maker, orderHash, nonce: "1700000000000", deadline: "1700000300" },
          },
        },
      },
      { success: true, data: { orderHash, job: { id: "cancel-job" } } },
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      calls.push(new URL(String(url)).pathname);
      return new Response(JSON.stringify(responses[calls.length - 1]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    await expect(cancelProtocolLiquidityOrders({
      config: { apiUrl: config.apiUrl, liquidityAgentPrivateKey: key },
      marketId,
      nowMs: 1_700_000_000_000,
    })).resolves.toEqual({ submitted: 1, skipped: 0 });
    expect(calls).toEqual([
      "/v1/auth/challenge", "/v1/auth/token", "/v1/orders",
      "/v1/orders/cancellations/prepare", "/v1/orders/cancellations/submit",
    ]);
  });
});
