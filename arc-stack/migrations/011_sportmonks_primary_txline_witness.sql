-- Provider-role migration for newly admitted sports markets.
-- Existing market rows and their immutable on-chain spec hashes are preserved.

UPDATE arc_oracle_adapters
   SET adapter_role = 'PRIMARY', enabled = true, paid = false
 WHERE adapter_id = 'sportmonks.football.v3';

UPDATE arc_oracle_adapters
   SET adapter_role = 'WITNESS', enabled = true, paid = false
 WHERE adapter_id = 'txline.sports-result.v1';

ALTER TABLE arc_markets DROP CONSTRAINT IF EXISTS arc_markets_sportmonks_primary_1x2_outcomes_check;
ALTER TABLE arc_markets ADD CONSTRAINT arc_markets_sportmonks_primary_1x2_outcomes_check
  CHECK (settlement_policy <> 'SPORTMONKS_PRIMARY_1X2_REGULATION' OR outcome_count = 3) NOT VALID;
ALTER TABLE arc_markets VALIDATE CONSTRAINT arc_markets_sportmonks_primary_1x2_outcomes_check;

CREATE INDEX IF NOT EXISTS arc_markets_sportmonks_auto_resolution_idx
  ON arc_markets (status, close_time)
  WHERE settlement_policy = 'SPORTMONKS_PRIMARY_1X2_REGULATION' AND resolution_job_id IS NULL;

ALTER TABLE arc_fixture_admission_state DROP CONSTRAINT IF EXISTS arc_fixture_admission_state_status_check;
ALTER TABLE arc_fixture_admission_state ADD CONSTRAINT arc_fixture_admission_state_status_check CHECK (status IN (
  'DISCOVERED', 'INELIGIBLE', 'NO_WITNESS', 'AMBIGUOUS_WITNESS',
  'NO_PRIMARY', 'AMBIGUOUS_PRIMARY', 'ADMITTED', 'FAILED'
));

ALTER TABLE arc_fixture_admission_events DROP CONSTRAINT IF EXISTS arc_fixture_admission_events_event_type_check;
ALTER TABLE arc_fixture_admission_events ADD CONSTRAINT arc_fixture_admission_events_event_type_check CHECK (event_type IN (
  'DISCOVERED', 'INELIGIBLE', 'WITNESS_UNAVAILABLE', 'WITNESS_AMBIGUOUS',
  'PRIMARY_UNAVAILABLE', 'PRIMARY_AMBIGUOUS', 'WITNESS_QUALIFIED',
  'MARKET_ADMITTED', 'ADMISSION_FAILED'
));

COMMENT ON COLUMN arc_markets.primary_adapter_id IS
  'Immutable primary evidence adapter for this market; new sports markets use Sportmonks.';
COMMENT ON COLUMN arc_markets.witness_adapter_id IS
  'Immutable independent witness adapter for this market; new sports markets use TxLINE.';
