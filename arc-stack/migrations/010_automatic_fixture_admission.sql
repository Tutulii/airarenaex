ALTER TABLE arc_markets
  ADD COLUMN IF NOT EXISTS market_spec jsonb,
  ADD COLUMN IF NOT EXISTS admission_source text;

ALTER TABLE arc_markets DROP CONSTRAINT IF EXISTS arc_markets_admission_source_check;
ALTER TABLE arc_markets ADD CONSTRAINT arc_markets_admission_source_check
  CHECK (admission_source IS NULL OR admission_source IN ('OPERATOR', 'AUTOMATIC_FIXTURE_WORKER'));

CREATE UNIQUE INDEX IF NOT EXISTS arc_markets_automatic_witness_uidx
  ON arc_markets (witness_adapter_id, witness_fixture_identity)
  WHERE admission_source = 'AUTOMATIC_FIXTURE_WORKER';

CREATE TABLE IF NOT EXISTS arc_fixture_admission_state (
  primary_fixture_identity text PRIMARY KEY,
  status text NOT NULL CHECK (status IN (
    'DISCOVERED', 'INELIGIBLE', 'NO_WITNESS', 'AMBIGUOUS_WITNESS',
    'ADMITTED', 'FAILED'
  )),
  candidate_hash text NOT NULL CHECK (candidate_hash ~ '^0x[0-9a-fA-F]{64}$'),
  primary_snapshot jsonb NOT NULL,
  witness_fixture_identity text,
  witness_candidate_hash text CHECK (
    witness_candidate_hash IS NULL OR witness_candidate_hash ~ '^0x[0-9a-fA-F]{64}$'
  ),
  witness_snapshot jsonb,
  market_id text REFERENCES arc_markets(market_id),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  next_attempt_at timestamptz,
  first_observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  admitted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (status = 'ADMITTED' AND market_id IS NOT NULL AND witness_fixture_identity IS NOT NULL AND admitted_at IS NOT NULL)
    OR status <> 'ADMITTED'
  )
);
CREATE INDEX IF NOT EXISTS arc_fixture_admission_retry_idx
  ON arc_fixture_admission_state (status, next_attempt_at, last_observed_at);

CREATE TABLE IF NOT EXISTS arc_fixture_admission_events (
  event_id bigserial PRIMARY KEY,
  primary_fixture_identity text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'DISCOVERED', 'INELIGIBLE', 'WITNESS_UNAVAILABLE', 'WITNESS_AMBIGUOUS',
    'WITNESS_QUALIFIED', 'MARKET_ADMITTED', 'ADMISSION_FAILED'
  )),
  candidate_hash text NOT NULL CHECK (candidate_hash ~ '^0x[0-9a-fA-F]{64}$'),
  market_id text,
  witness_fixture_identity text,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^0x[0-9a-fA-F]{64}$'),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS arc_fixture_admission_events_fixture_idx
  ON arc_fixture_admission_events (primary_fixture_identity, event_id);

DROP TRIGGER IF EXISTS arc_fixture_admission_events_immutable ON arc_fixture_admission_events;
CREATE TRIGGER arc_fixture_admission_events_immutable
BEFORE UPDATE OR DELETE ON arc_fixture_admission_events
FOR EACH ROW EXECUTE FUNCTION arc_reject_immutable_mutation();

COMMENT ON TABLE arc_fixture_admission_state IS
  'Crash-safe current state for deterministic automatic fixture admission.';
COMMENT ON TABLE arc_fixture_admission_events IS
  'Append-only audit log for every automatic fixture-admission decision.';
