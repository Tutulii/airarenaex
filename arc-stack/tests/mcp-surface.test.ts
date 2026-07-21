import { describe, expect, it } from "vitest";
import { ARC_MCP_TOOLS } from "../src/mcp.js";

describe("Arc MCP isolation", () => {
  it("exposes only explicitly Arc-scoped tools", () => {
    const names = ARC_MCP_TOOLS.map((tool) => tool.name);
    expect(names.length).toBeGreaterThanOrEqual(10);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^airarena_arc_/);
    expect(names.some((name) => name.includes("solana") || name.startsWith("airotc_"))).toBe(false);
  });

  it("does not expose operator settlement or ingestion controls", () => {
    const names = ARC_MCP_TOOLS.map((tool) => tool.name).join("\n");
    expect(names).not.toMatch(/run_settlement|start_ingestion|stop_ingestion|resolve_market|private_key/);
  });
});
