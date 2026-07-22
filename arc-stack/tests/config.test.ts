import { describe, expect, it } from "vitest";
import { ARC_CHAIN_ID, ARC_USDC_ADDRESS, loadConfig } from "../src/config.js";

const base = {
  NODE_ENV: "test",
  SERVICE_ROLE: "mcp",
  ARC_RPC_URL: "https://rpc.example.invalid",
};

describe("Arc configuration boundary", () => {
  it("hard locks the service to Arc Testnet", () => {
    expect(() => loadConfig({ ...base, ARC_CHAIN_ID: "1" })).toThrow(/must be 5042002/);
    expect(loadConfig(base).chainId).toBe(ARC_CHAIN_ID);
  });

  it("rejects a substituted collateral contract", () => {
    expect(() =>
      loadConfig({ ...base, ARC_USDC_ADDRESS: "0x0000000000000000000000000000000000000001" }),
    ).toThrow(/official Arc Testnet USDC/);
    expect(loadConfig(base).usdcAddress).toBe(ARC_USDC_ADDRESS);
  });

  it("requires production secrets only in the service that owns them", () => {
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: "production",
        SERVICE_ROLE: "api",
        DATABASE_URL: "postgresql://localhost/arc",
      }),
    ).toThrow(/AUTH_TOKEN_PEPPER/);
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: "production",
        SERVICE_ROLE: "api",
        DATABASE_URL: "postgresql://localhost/arc",
        AUTH_TOKEN_PEPPER: "p".repeat(32),
      }),
    ).toThrow(/ARC_RECEIPT_SIGNER_PRIVATE_KEY/);
    expect(loadConfig({ ...base, NODE_ENV: "production", SERVICE_ROLE: "mcp" }).serviceRole).toBe("mcp");
  });

  it("rejects configurations that would split one auction across transactions", () => {
    expect(() => loadConfig({
      ...base,
      ARC_BATCH_MAX_ORDERS: "41",
      ARC_BATCH_EXECUTION_CHUNK_SIZE: "40",
    })).toThrow(/atomic execution/);
    expect(loadConfig({
      ...base,
      ARC_BATCH_MAX_ORDERS: "40",
      ARC_BATCH_EXECUTION_CHUNK_SIZE: "40",
    }).batchMaxOrders).toBe(40);
  });
});
