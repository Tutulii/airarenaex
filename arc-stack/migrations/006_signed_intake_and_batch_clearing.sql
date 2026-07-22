ALTER TABLE arc_jobs DROP CONSTRAINT IF EXISTS arc_jobs_kind_check;
ALTER TABLE arc_jobs ADD CONSTRAINT arc_jobs_kind_check CHECK (
  kind IN (
    'SUBMIT_ORDER', 'CANCEL_ORDER', 'EXECUTE_MATCH', 'EXECUTE_BATCH',
    'CREATE_MARKET', 'RESOLVE_MARKET', 'INVALIDATE_MARKET'
  )
);

CREATE TABLE IF NOT EXISTS arc_nonce_claims (
  maker text NOT NULL,
  namespace text NOT NULL CHECK (namespace IN ('ORDER', 'CANCEL')),
  nonce numeric(78,0) NOT NULL CHECK (nonce >= 0),
  digest text NOT NULL CHECK (digest ~ '^0x[0-9a-fA-F]{64}$'),
  state text NOT NULL CHECK (state IN ('ACCEPTED', 'CHAIN_ACTIVE', 'CONSUMED', 'REJECTED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (maker, namespace, nonce)
);

CREATE TABLE IF NOT EXISTS arc_order_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_hash text NOT NULL CHECK (order_hash ~ '^0x[0-9a-fA-F]{64}$'),
  event_type text NOT NULL CHECK (event_type IN (
    'LEGACY_IMPORTED', 'ORDER_ACCEPTED', 'ORDER_CHAIN_ACTIVE', 'ORDER_CANCEL_ACCEPTED',
    'ORDER_CANCELLED', 'ORDER_BATCH_ASSIGNED', 'ORDER_BATCH_RELEASED',
    'ORDER_BATCH_SEALED', 'ORDER_FILLED', 'ORDER_REJECTED'
  )),
  payload jsonb NOT NULL,
  event_key text NOT NULL UNIQUE CHECK (event_key ~ '^0x[0-9a-fA-F]{64}$'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^0x[0-9a-fA-F]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS arc_order_events_order_idx ON arc_order_events (order_hash, sequence);
CREATE INDEX IF NOT EXISTS arc_order_events_type_idx ON arc_order_events (event_type, sequence);

CREATE OR REPLACE FUNCTION arc_reject_immutable_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable_relation:%', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS arc_order_events_immutable ON arc_order_events;
CREATE TRIGGER arc_order_events_immutable
BEFORE UPDATE OR DELETE ON arc_order_events
FOR EACH ROW EXECUTE FUNCTION arc_reject_immutable_mutation();

CREATE TABLE IF NOT EXISTS arc_order_receipts (
  order_hash text PRIMARY KEY REFERENCES arc_orders(order_hash),
  sequence bigint NOT NULL UNIQUE REFERENCES arc_order_events(sequence),
  maker text NOT NULL,
  accepted_at timestamptz NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^0x[0-9a-fA-F]{64}$'),
  receipt_digest text NOT NULL UNIQUE CHECK (receipt_digest ~ '^0x[0-9a-fA-F]{64}$'),
  signer_key_id text NOT NULL,
  signer_address text NOT NULL,
  signature text NOT NULL CHECK (signature ~ '^0x[0-9a-fA-F]+$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

DROP TRIGGER IF EXISTS arc_order_receipts_immutable ON arc_order_receipts;
CREATE TRIGGER arc_order_receipts_immutable
BEFORE UPDATE OR DELETE ON arc_order_receipts
FOR EACH ROW EXECUTE FUNCTION arc_reject_immutable_mutation();

CREATE TABLE IF NOT EXISTS arc_batches (
  batch_id text PRIMARY KEY CHECK (batch_id ~ '^0x[0-9a-fA-F]{64}$'),
  market_id text NOT NULL REFERENCES arc_markets(market_id),
  outcome smallint NOT NULL CHECK (outcome BETWEEN 0 AND 2),
  policy_version text NOT NULL,
  policy_hash text NOT NULL CHECK (policy_hash ~ '^0x[0-9a-fA-F]{64}$'),
  batch_start timestamptz NOT NULL,
  batch_end timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN', 'SEALED', 'EXECUTING', 'EXECUTED', 'NO_CROSS', 'FAILED')),
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  input_root text CHECK (input_root IS NULL OR input_root ~ '^0x[0-9a-fA-F]{64}$'),
  result_hash text CHECK (result_hash IS NULL OR result_hash ~ '^0x[0-9a-fA-F]{64}$'),
  clearing_price_ppm bigint CHECK (clearing_price_ppm IS NULL OR clearing_price_ppm BETWEEN 1 AND 999999),
  executable_quantity numeric(78,0) CHECK (executable_quantity IS NULL OR executable_quantity >= 0),
  sealed_input jsonb,
  result jsonb,
  execution_job_id uuid REFERENCES arc_jobs(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sealed_at timestamptz,
  executed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (market_id, outcome, policy_version, batch_start),
  CHECK (batch_end > batch_start)
);
CREATE INDEX IF NOT EXISTS arc_batches_seal_idx ON arc_batches (status, batch_end);

CREATE TABLE IF NOT EXISTS arc_batch_orders (
  batch_id text NOT NULL REFERENCES arc_batches(batch_id),
  order_hash text NOT NULL REFERENCES arc_orders(order_hash),
  accepted_sequence bigint NOT NULL REFERENCES arc_order_events(sequence),
  assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_at timestamptz,
  PRIMARY KEY (batch_id, order_hash)
);
CREATE INDEX IF NOT EXISTS arc_batch_orders_order_idx ON arc_batch_orders (order_hash, assigned_at DESC);

CREATE TABLE IF NOT EXISTS arc_batch_fills (
  batch_id text NOT NULL REFERENCES arc_batches(batch_id),
  fill_index integer NOT NULL CHECK (fill_index >= 0),
  buy_order_hash text NOT NULL REFERENCES arc_orders(order_hash),
  sell_order_hash text NOT NULL REFERENCES arc_orders(order_hash),
  quantity numeric(78,0) NOT NULL CHECK (quantity > 0),
  buy_filled_before numeric(78,0) NOT NULL CHECK (buy_filled_before >= 0),
  sell_filled_before numeric(78,0) NOT NULL CHECK (sell_filled_before >= 0),
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  PRIMARY KEY (batch_id, fill_index),
  CHECK (buy_order_hash <> sell_order_hash)
);
CREATE INDEX IF NOT EXISTS arc_batch_fills_chunk_idx ON arc_batch_fills (batch_id, chunk_index, fill_index);

CREATE TABLE IF NOT EXISTS arc_batch_chunks (
  batch_id text NOT NULL REFERENCES arc_batches(batch_id),
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  first_fill_index integer NOT NULL CHECK (first_fill_index >= 0),
  last_fill_index integer NOT NULL CHECK (last_fill_index >= first_fill_index),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  tx_hash text,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (batch_id, chunk_index)
);

ALTER TABLE arc_orders
  ADD COLUMN IF NOT EXISTS accepted_sequence bigint,
  ADD COLUMN IF NOT EXISTS assigned_batch_id text REFERENCES arc_batches(batch_id),
  ADD COLUMN IF NOT EXISTS cancellation_nonce numeric(78,0),
  ADD COLUMN IF NOT EXISTS cancellation_deadline timestamptz,
  ADD COLUMN IF NOT EXISTS cancellation_signature text,
  ADD COLUMN IF NOT EXISTS cancellation_digest text;
CREATE UNIQUE INDEX IF NOT EXISTS arc_orders_accepted_sequence_uidx
  ON arc_orders (accepted_sequence) WHERE accepted_sequence IS NOT NULL;
CREATE INDEX IF NOT EXISTS arc_orders_batch_assignment_idx
  ON arc_orders (status, assigned_batch_id, market_id, outcome, expiry);

CREATE TABLE IF NOT EXISTS arc_worker_cursors (
  worker_name text PRIMARY KEY,
  sequence bigint NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- An immutable database-to-contract binding prevents a non-upgradeable exchange
-- deployment from accidentally consuming orders signed for a previous address.
CREATE TABLE IF NOT EXISTS arc_deployment_binding (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  chain_id bigint NOT NULL CHECK (chain_id = 5042002),
  exchange_address text NOT NULL CHECK (exchange_address ~ '^0x[0-9a-fA-F]{40}$'),
  bound_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

DROP TRIGGER IF EXISTS arc_deployment_binding_immutable ON arc_deployment_binding;
CREATE TRIGGER arc_deployment_binding_immutable
BEFORE UPDATE OR DELETE ON arc_deployment_binding
FOR EACH ROW EXECUTE FUNCTION arc_reject_immutable_mutation();

INSERT INTO arc_order_events(order_hash, event_type, payload, event_key, payload_hash, occurred_at)
SELECT o.order_hash,
       'LEGACY_IMPORTED',
       jsonb_build_object('status', o.status, 'createdAt', o.created_at),
       '0x' || encode(digest(convert_to(o.order_hash || ':LEGACY_IMPORTED', 'UTF8'), 'sha256'), 'hex')::text,
       '0x' || encode(digest(convert_to(o.order_hash || ':LEGACY_IMPORTED:' || o.status, 'UTF8'), 'sha256'), 'hex')::text,
       o.created_at
  FROM arc_orders o
 WHERE NOT EXISTS (
   SELECT 1 FROM arc_order_events e WHERE e.order_hash = o.order_hash
 );
