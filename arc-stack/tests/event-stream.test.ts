import { describe, expect, it } from "vitest";
import { parseResumeCursor, readResumableEventPage } from "../src/event-stream.js";
import type { ExchangeEvent } from "../src/exchange-events.js";

function event(sequence: number): ExchangeEvent {
  const hash = `0x${sequence.toString(16).padStart(64, "0")}` as const;
  return {
    sequence: sequence.toString(), resumeCursor: sequence.toString(), eventId: hash,
    topic: "ORDER", entityId: `order-${sequence}`, eventType: "ORDER_ACCEPTED",
    payload: {}, payloadHash: hash, sourceRoot: hash, occurredAt: "2026-07-22T00:00:00.000Z",
  };
}

describe("resumable event pages", () => {
  it("returns a strict resume cursor with no duplicate delivery", async () => {
    const all = [event(1), event(2), event(3), event(4)];
    const source = async (cursor: bigint, limit: number) => all.filter((item) => BigInt(item.sequence) > cursor).slice(0, limit);
    const first = await readResumableEventPage(source, 0n, 2);
    const second = await readResumableEventPage(source, first.cursor, 2);
    expect([...first.events, ...second.events].map((item) => item.sequence)).toEqual(["1", "2", "3", "4"]);
    expect(second.cursor).toBe(4n);
  });

  it("rejects malformed cursors and corrupt duplicate/regressing pages", async () => {
    expect(() => parseResumeCursor("-1")).toThrow("invalid_resume_cursor");
    await expect(readResumableEventPage(async () => [event(2), event(1)], 0n)).rejects
      .toThrow("event_stream_sequence_regression");
  });
});
