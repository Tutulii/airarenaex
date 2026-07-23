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

  it("fails closed when authenticated TxLINE SSE is enabled without its API token", () => {
    const productionMiddleman = {
      ...base,
      NODE_ENV: "production",
      SERVICE_ROLE: "middleman",
      DATABASE_URL: "postgresql://localhost/arc",
      ARC_EXCHANGE_ADDRESS: "0x6B42F8Ec16EE7C580213D0d07076019aBD6eE071",
      ARC_RELAYER_PRIVATE_KEY: "0x" + "11".repeat(32),
      ARC_UPGRADE_MULTISIG_PRIVATE_KEY: "0x" + "12".repeat(32),
      ARC_SEQUENCER_PRIVATE_KEY: "0x" + "13".repeat(32),
      ARC_RESOLVER_PRIVATE_KEY: "0x" + "14".repeat(32),
      SPORTMONKS_API_TOKEN: "trial-token-value",
      ARC_ORACLE_PRIMARY_SIGNER_PRIVATE_KEY: "0x" + "15".repeat(32),
      ARC_ORACLE_WITNESS_SIGNER_PRIVATE_KEY: "0x" + "16".repeat(32),
      ARC_LIQUIDITY_AGENT_PRIVATE_KEY: "0x" + "17".repeat(32),
      ARC_LIQUIDITY_AGENT_ADDRESS: "0x7e9fb40f66c4e132Fa5E64E49f307E02B76540f8",
      TXLINE_SOURCE_URL: "https://txline-source.example",
      TXLINE_SSE_URL: "https://txline.example/api/scores/stream",
    };
    expect(() => loadConfig(productionMiddleman)).toThrow(
      "TXLINE_API_TOKEN is required when TXLINE_SSE_URL is configured",
    );
    expect(loadConfig({ ...productionMiddleman, TXLINE_API_TOKEN: "x".repeat(16) }).txlineSseUrl)
      .toBe("https://txline.example/api/scores/stream");
  });
});
