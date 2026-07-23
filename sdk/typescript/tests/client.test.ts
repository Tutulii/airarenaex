import { describe, expect, it } from "vitest";
import { AirArenaAgentClient, AirArenaApiError } from "../src/client.js";

describe("AirArenaAgentClient", () => {
  it("uses the isolated exchange API and forwards authentication and idempotency", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new AirArenaAgentClient({
      baseUrl: "https://arena.example/",
      token: "secret",
      fetch: (async (input, init) => {
        calls.push({ url: input.toString(), init });
        return new Response(JSON.stringify({ success: true, data: { accepted: true } }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    await client.submitOrder({
      maker: "0x0000000000000000000000000000000000000001",
      marketId: `0x${"11".repeat(32)}`,
      outcome: 0,
      isBuy: true,
      pricePpm: "500000",
      quantity: "10000",
      nonce: "1",
      expiry: "2000000000",
      clientOrderId: `0x${"22".repeat(32)}`,
    }, `0x${"33".repeat(65)}`, "stable-key-1");
    expect(calls[0]?.url).toBe("https://arena.example/v1/exchange/orders/submit");
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer secret");
    expect((calls[0]?.init?.headers as Record<string, string>)["idempotency-key"]).toBe("stable-key-1");
  });

  it("throws a typed stable API error", async () => {
    const client = new AirArenaAgentClient({
      baseUrl: "https://arena.example",
      fetch: (async () => new Response(JSON.stringify({
        success: false,
        error: { code: "market_closed", message: "The market is closed.", retryable: false },
        requestId: "request-1",
      }), { status: 409, headers: { "content-type": "application/json" } })) as typeof fetch,
    });
    await expect(client.market(`0x${"11".repeat(32)}`)).rejects.toMatchObject<Partial<AirArenaApiError>>({
      code: "market_closed",
      retryable: false,
      status: 409,
      requestId: "request-1",
    });
  });

  it("supports the full API base URL and all operator writes", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new AirArenaAgentClient({
      baseUrl: "https://arena.example/v1/exchange/",
      fetch: (async (input, init) => {
        calls.push({ url: input.toString(), init });
        return new Response(JSON.stringify({ success: true, data: { accepted: true } }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    const marketId = `0x${"44".repeat(32)}` as const;
    await client.createMarket({ fixtureId: "fixture-1", outcomeCount: 3, closeTime: "2026-08-01T00:00:00.000Z" }, "operator", "create-key");
    await client.resolveMarket(marketId, 2, "operator", "resolve-key");
    await client.invalidateMarket(marketId, "operator", "invalidate-key");
    expect(calls.map((call) => call.url)).toEqual([
      "https://arena.example/v1/exchange/operator/markets",
      `https://arena.example/v1/exchange/operator/markets/${marketId}/resolve`,
      `https://arena.example/v1/exchange/operator/markets/${marketId}/invalidate`,
    ]);
    expect(calls.every((call) => (call.init?.headers as Record<string, string>)["x-airarena-operator-token"] === "operator"))
      .toBe(true);
  });
});
