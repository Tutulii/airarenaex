ALTER TABLE arc_jobs DROP CONSTRAINT IF EXISTS arc_jobs_kind_check;
ALTER TABLE arc_jobs ADD CONSTRAINT arc_jobs_kind_check CHECK (kind IN (
  'SUBMIT_ORDER', 'CANCEL_ORDER', 'EXECUTE_MATCH', 'EXECUTE_BATCH',
  'CREATE_MARKET', 'RESOLVE_MARKET', 'INVALIDATE_MARKET', 'INVALIDATE_AFTER_GRACE'
));

UPDATE arc_jobs
   SET status = 'DEAD',
       last_error = 'legacy unproven invalidation job disabled by ArenaExchange V3',
       updated_at = clock_timestamp()
 WHERE kind = 'INVALIDATE_MARKET'
   AND status IN ('PENDING', 'RUNNING', 'FAILED');

ALTER TABLE arc_markets
  ADD COLUMN IF NOT EXISTS spec_hash text,
  ADD COLUMN IF NOT EXISTS resolution_rule_hash text,
  ADD COLUMN IF NOT EXISTS resolution_rule jsonb,
  ADD COLUMN IF NOT EXISTS primary_report jsonb,
  ADD COLUMN IF NOT EXISTS witness_report jsonb,
  ADD COLUMN IF NOT EXISTS primary_report_digest text,
  ADD COLUMN IF NOT EXISTS witness_report_digest text;

ALTER TABLE arc_batches
  ADD COLUMN IF NOT EXISTS chain_batch_id text,
  ADD COLUMN IF NOT EXISTS chain_sequence numeric(20,0),
  ADD COLUMN IF NOT EXISTS chain_prior_root text,
  ADD COLUMN IF NOT EXISTS chain_match_root text,
  ADD COLUMN IF NOT EXISTS chain_expected_ledger_root text,
  ADD COLUMN IF NOT EXISTS chain_data_commitment text;

CREATE UNIQUE INDEX IF NOT EXISTS arc_batches_chain_batch_id_uidx
  ON arc_batches (chain_batch_id) WHERE chain_batch_id IS NOT NULL;

ALTER TABLE arc_markets DROP CONSTRAINT IF EXISTS arc_markets_spec_hash_format_check;
ALTER TABLE arc_markets ADD CONSTRAINT arc_markets_spec_hash_format_check
  CHECK (spec_hash IS NULL OR spec_hash ~ '^0x[0-9a-fA-F]{64}$');

CREATE TABLE IF NOT EXISTS arc_resolution_reports (
  report_digest text PRIMARY KEY,
  market_id text NOT NULL REFERENCES arc_markets(market_id),
  source_index smallint NOT NULL CHECK (source_index IN (0, 1)),
  source_id text NOT NULL,
  source_event_id text NOT NULL,
  observed_at numeric(20,0) NOT NULL,
  published_at numeric(20,0) NOT NULL,
  final_result boolean NOT NULL,
  normalized_outcome smallint NOT NULL CHECK (normalized_outcome BETWEEN 0 AND 2),
  raw_payload_hash text NOT NULL,
  signature_evidence text NOT NULL,
  transaction_hash text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (market_id, source_index)
);
CREATE INDEX IF NOT EXISTS arc_resolution_reports_market_idx
  ON arc_resolution_reports (market_id, source_index);

DROP TRIGGER IF EXISTS arc_resolution_reports_immutable ON arc_resolution_reports;
CREATE TRIGGER arc_resolution_reports_immutable
BEFORE UPDATE OR DELETE ON arc_resolution_reports
FOR EACH ROW EXECUTE FUNCTION arc_reject_immutable_mutation();

COMMENT ON TABLE arc_resolution_reports IS
  'Append-only normalized evidence envelopes committed by ArenaExchange V3.';
