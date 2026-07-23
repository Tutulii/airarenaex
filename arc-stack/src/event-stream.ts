import type { ExchangeEvent } from "./exchange-events.js";

export const EVENT_STREAM_PROTOCOL = "airarena.arc.events.v1";

export type EventPageSource = (afterSequence: bigint, limit: number) => Promise<ExchangeEvent[]>;

export function parseResumeCursor(value: string | undefined): bigint {
  if (value === undefined || value === "") return 0n;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("invalid_resume_cursor");
  return BigInt(value);
}

/**
 * Reads one strictly ordered page and rejects corrupt or duplicate sources.
 * Persisting the returned cursor only after consuming the page gives exactly-once
 * delivery to a reconnecting client on top of at-least-once transport.
 */
export async function readResumableEventPage(
  source: EventPageSource,
  cursor: bigint,
  limit = 100,
): Promise<{ events: ExchangeEvent[]; cursor: bigint }> {
  const events = await source(cursor, limit);
  let next = cursor;
  const ids = new Set<string>();
  for (const event of events) {
    const sequence = BigInt(event.sequence);
    if (sequence <= next) throw new Error("event_stream_sequence_regression");
    if (ids.has(event.eventId.toLowerCase())) throw new Error("event_stream_duplicate_event");
    if (event.resumeCursor !== event.sequence) throw new Error("event_stream_cursor_mismatch");
    ids.add(event.eventId.toLowerCase());
    next = sequence;
  }
  return { events, cursor: next };
}
