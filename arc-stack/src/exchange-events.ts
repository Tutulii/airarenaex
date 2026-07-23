import type { Hex } from "viem";
import type { Database, DatabaseClient } from "./db.js";

export type ExchangeEventTopic = "ORDER" | "BATCH" | "MARKET" | "JOB" | "SYSTEM";

export type ExchangeEvent = {
  sequence: string;
  resumeCursor: string;
  eventId: Hex;
  topic: ExchangeEventTopic;
  entityId: string;
  eventType: string;
  payload: unknown;
  payloadHash: Hex;
  sourceRoot: Hex | null;
  occurredAt: string;
};

export async function appendExchangeEvent(
  db: Database | DatabaseClient,
  input: {
    topic: ExchangeEventTopic;
    entityId: string;
    eventType: string;
    payload: unknown;
    eventKey: Hex;
    payloadHash: Hex;
    sourceRoot?: Hex | null;
    occurredAt?: Date;
  },
): Promise<bigint> {
  const inserted = await db.query<{ sequence: string }>(
    `INSERT INTO arc_exchange_events(
       topic, entity_id, event_type, payload, event_key, payload_hash, source_root, occurred_at
     ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,COALESCE($8,clock_timestamp()))
     ON CONFLICT (event_key) DO NOTHING RETURNING sequence::text`,
    [
      input.topic,
      input.entityId,
      input.eventType,
      JSON.stringify(input.payload),
      input.eventKey,
      input.payloadHash,
      input.sourceRoot ?? null,
      input.occurredAt ?? null,
    ],
  );
  if (inserted.rows[0]) return BigInt(inserted.rows[0].sequence);
  const existing = await db.query<{ sequence: string }>(
    "SELECT sequence::text FROM arc_exchange_events WHERE event_key = $1",
    [input.eventKey],
  );
  if (!existing.rows[0]) throw new Error("exchange_event_insert_failed");
  return BigInt(existing.rows[0].sequence);
}

export async function readExchangeEventsAfter(
  db: Database | DatabaseClient,
  afterSequence: bigint,
  limit = 100,
  topics: ExchangeEventTopic[] = [],
): Promise<ExchangeEvent[]> {
  if (afterSequence < 0n) throw new Error("invalid_resume_cursor");
  const boundedLimit = Math.min(500, Math.max(1, limit));
  const result = await db.query<{
    sequence: string;
    topic: ExchangeEventTopic;
    entity_id: string;
    event_type: string;
    payload: unknown;
    event_key: Hex;
    payload_hash: Hex;
    source_root: Hex | null;
    occurred_at: Date;
  }>(
    `SELECT sequence::text, topic, entity_id, event_type, payload, event_key, payload_hash,
            source_root, occurred_at
       FROM arc_exchange_events
      WHERE sequence > $1
        AND (cardinality($3::text[]) = 0 OR topic = ANY($3::text[]))
      ORDER BY arc_exchange_events.sequence ASC LIMIT $2`,
    [afterSequence.toString(), boundedLimit, topics],
  );
  return result.rows.map((row) => ({
    sequence: row.sequence,
    resumeCursor: row.sequence,
    eventId: row.event_key,
    topic: row.topic,
    entityId: row.entity_id,
    eventType: row.event_type,
    payload: row.payload,
    payloadHash: row.payload_hash,
    sourceRoot: row.source_root,
    occurredAt: row.occurred_at.toISOString(),
  }));
}
