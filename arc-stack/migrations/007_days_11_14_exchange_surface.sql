-- Days 11-14: cancellation cutoff, immutable public batch data,
-- resumable exchange events, and crash-safe HTTP idempotency.

ALTER TABLE arc_batches
  ADD COLUMN IF NOT EXISTS cancellation_cutoff timestamptz;

UPDATE arc_batches
   SET cancellation_cutoff = batch_end - interval '200 milliseconds'
 WHERE cancellation_cutoff IS NULL;

ALTER TABLE arc_batches ALTER COLUMN cancellation_cutoff SET NOT NULL;
ALTER TABLE arc_batches DROP CONSTRAINT IF EXISTS arc_batches_cancellation_cutoff_check;
ALTER TABLE arc_batches ADD CONSTRAINT arc_batches_cancellation_cutoff_check
  CHECK (cancellation_cutoff >= batch_start AND cancellation_cutoff < batch_end);

CREATE INDEX IF NOT EXISTS arc_batches_cancellation_cutoff_idx
  ON arc_batches (status, cancellation_cutoff);

CREATE TABLE IF NOT EXISTS arc_batch_publications (
  batch_id text PRIMARY KEY REFERENCES arc_batches(batch_id),
  schema_version text NOT NULL,
  order_root text NOT NULL CHECK (order_root ~ '^0x[0-9a-fA-F]{64}$'),
  fill_root text NOT NULL CHECK (fill_root ~ '^0x[0-9a-fA-F]{64}$'),
  bundle_hash text NOT NULL UNIQUE CHECK (bundle_hash ~ '^0x[0-9a-fA-F]{64}$'),
  bundle jsonb NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

DROP TRIGGER IF EXISTS arc_batch_publications_immutable ON arc_batch_publications;
CREATE TRIGGER arc_batch_publications_immutable
BEFORE UPDATE OR DELETE ON arc_batch_publications
FOR EACH ROW EXECUTE FUNCTION arc_reject_immutable_mutation();

CREATE TABLE IF NOT EXISTS arc_exchange_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic text NOT NULL CHECK (topic IN ('ORDER','BATCH','MARKET','JOB','SYSTEM')),
  entity_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  event_key text NOT NULL UNIQUE CHECK (event_key ~ '^0x[0-9a-fA-F]{64}$'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^0x[0-9a-fA-F]{64}$'),
  source_root text CHECK (source_root IS NULL OR source_root ~ '^0x[0-9a-fA-F]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS arc_exchange_events_topic_sequence_idx
  ON arc_exchange_events (topic, sequence);
CREATE INDEX IF NOT EXISTS arc_exchange_events_entity_sequence_idx
  ON arc_exchange_events (entity_id, sequence);

DROP TRIGGER IF EXISTS arc_exchange_events_immutable ON arc_exchange_events;
CREATE TRIGGER arc_exchange_events_immutable
BEFORE UPDATE OR DELETE ON arc_exchange_events
FOR EACH ROW EXECUTE FUNCTION arc_reject_immutable_mutation();

INSERT INTO arc_exchange_events(
  topic, entity_id, event_type, payload, event_key, payload_hash, source_root, occurred_at
)
SELECT 'ORDER', order_hash, event_type, payload, event_key, payload_hash, payload_hash, occurred_at
  FROM arc_order_events
 ORDER BY sequence
ON CONFLICT (event_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS arc_http_idempotency (
  actor_hash text NOT NULL CHECK (actor_hash ~ '^0x[0-9a-fA-F]{64}$'),
  route text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-fA-F]{64}$'),
  state text NOT NULL CHECK (state IN ('IN_PROGRESS','COMPLETED','FAILED')),
  lease_token uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  status_code integer CHECK (status_code IS NULL OR status_code BETWEEN 100 AND 599),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_hash, route, idempotency_key),
  CHECK ((state = 'COMPLETED') = (status_code IS NOT NULL AND response IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS arc_http_idempotency_lease_idx
  ON arc_http_idempotency (state, lease_expires_at);
