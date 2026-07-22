import { describe, expect, it, vi } from "vitest";
import { failJob, type ArcJob } from "../src/jobs.js";
import type { Database } from "../src/db.js";

function job(attempts: number): ArcJob {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    kind: "EXECUTE_BATCH",
    payload: {},
    status: "RUNNING",
    attempts,
    maxAttempts: 8,
    idempotencyKey: "execute-batch:test",
  };
}

describe("failJob", () => {
  it("marks deterministic permanent failures dead on the first attempt", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    const dead = await failJob({ query } as unknown as Database, job(1), "batch_chunk_prestate_changed", {
      permanent: true,
    });

    expect(dead).toBe(true);
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]![1]).toEqual([
      "00000000-0000-0000-0000-000000000001",
      "DEAD",
      "batch_chunk_prestate_changed",
      2,
    ]);
  });

  it("retains retry backoff for transient failures", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    const dead = await failJob({ query } as unknown as Database, job(1), "rpc_timeout");

    expect(dead).toBe(false);
    expect(query.mock.calls[0]![1]).toEqual([
      "00000000-0000-0000-0000-000000000001",
      "FAILED",
      "rpc_timeout",
      2,
    ]);
  });
});
