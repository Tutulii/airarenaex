import { describe, expect, it } from "vitest";
import {
  CANCELLATION_CUTOFF_MS,
  cancellationCutoffMs,
  cancellationWindowOpen,
} from "../src/cancellation-cutoff.js";

describe("batch cancellation cutoff", () => {
  it("accepts strictly before the cutoff and fails closed at or after it", () => {
    const batchEnd = 10_000n;
    const cutoff = cancellationCutoffMs(batchEnd);
    expect(CANCELLATION_CUTOFF_MS).toBe(200n);
    expect(cutoff).toBe(9_800n);
    expect(cancellationWindowOpen(9_799n, cutoff)).toBe(true);
    expect(cancellationWindowOpen(9_800n, cutoff)).toBe(false);
    expect(cancellationWindowOpen(10_001n, cutoff)).toBe(false);
  });
});
