CREATE TABLE IF NOT EXISTS arc_oracle_adapters (
  adapter_id text PRIMARY KEY,
  adapter_version integer NOT NULL CHECK (adapter_version > 0),
  category text NOT NULL CHECK (category IN ('SPORTS','CRYPTO','POLITICS')),
  adapter_role text NOT NULL CHECK (adapter_role IN ('PRIMARY','WITNESS','RESERVED')),
  enabled boolean NOT NULL,
  paid boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO arc_oracle_adapters(adapter_id, adapter_version, category, adapter_role, enabled, paid) VALUES
  ('txline.sports-result.v1', 1, 'SPORTS', 'PRIMARY', true, false),
  ('sportmonks.football.v3', 3, 'SPORTS', 'WITNESS', true, false),
  ('official.competition.v1', 1, 'SPORTS', 'WITNESS', false, false),
  ('pyth.price.v1', 1, 'CRYPTO', 'RESERVED', false, false),
  ('election.result.v1', 1, 'POLITICS', 'RESERVED', false, false)
ON CONFLICT (adapter_id) DO UPDATE SET
  enabled = EXCLUDED.enabled,
  paid = EXCLUDED.paid,
  adapter_role = EXCLUDED.adapter_role;

ALTER TABLE arc_markets
  ADD COLUMN IF NOT EXISTS primary_adapter_id text REFERENCES arc_oracle_adapters(adapter_id),
  ADD COLUMN IF NOT EXISTS primary_fixture_identity text,
  ADD COLUMN IF NOT EXISTS witness_adapter_id text REFERENCES arc_oracle_adapters(adapter_id),
  ADD COLUMN IF NOT EXISTS witness_fixture_identity text,
  ADD COLUMN IF NOT EXISTS witness_access_tier text,
  ADD COLUMN IF NOT EXISTS witness_qualification_hash text CHECK (
    witness_qualification_hash IS NULL OR witness_qualification_hash ~ '^0x[0-9a-fA-F]{64}$'
  ),
  ADD COLUMN IF NOT EXISTS witness_qualification_observed_at timestamptz,
  ADD COLUMN IF NOT EXISTS witness_qualified_at timestamptz;

ALTER TABLE arc_markets DROP CONSTRAINT IF EXISTS arc_markets_oracle_binding_complete;
ALTER TABLE arc_markets ADD CONSTRAINT arc_markets_oracle_binding_complete CHECK (
  (
    primary_adapter_id IS NULL AND primary_fixture_identity IS NULL
    AND witness_adapter_id IS NULL AND witness_fixture_identity IS NULL
    AND witness_access_tier IS NULL AND witness_qualification_hash IS NULL
    AND witness_qualification_observed_at IS NULL AND witness_qualified_at IS NULL
  ) OR (
    primary_adapter_id IS NOT NULL AND length(primary_fixture_identity) > 0
    AND witness_adapter_id IS NOT NULL AND length(witness_fixture_identity) > 0
    AND witness_access_tier IN ('FREE','TRIAL')
    AND witness_qualification_hash IS NOT NULL
    AND witness_qualification_observed_at IS NOT NULL AND witness_qualified_at IS NOT NULL
  )
);

CREATE TABLE IF NOT EXISTS arc_oracle_reports (
  report_hash text PRIMARY KEY CHECK (report_hash ~ '^0x[0-9a-fA-F]{64}$'),
  market_id text REFERENCES arc_markets(market_id),
  adapter_id text NOT NULL REFERENCES arc_oracle_adapters(adapter_id),
  fixture_identity text NOT NULL,
  sequence numeric(78,0) NOT NULL CHECK (sequence >= 0),
  source_timestamp timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  raw_response text NOT NULL,
  raw_payload_hash text NOT NULL CHECK (raw_payload_hash ~ '^0x[0-9a-fA-F]{64}$'),
  proof jsonb NOT NULL,
  final_result boolean NOT NULL,
  normalized_outcome smallint CHECK (normalized_outcome BETWEEN 0 AND 2),
  home_score integer CHECK (home_score >= 0),
  away_score integer CHECK (away_score >= 0),
  correction_rank integer NOT NULL DEFAULT 0 CHECK (correction_rank >= 0),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (adapter_id, fixture_identity, sequence, correction_rank, report_hash)
);
CREATE INDEX IF NOT EXISTS arc_oracle_reports_fixture_idx
  ON arc_oracle_reports(adapter_id, fixture_identity, sequence DESC, correction_rank DESC, source_timestamp DESC);

DROP TRIGGER IF EXISTS arc_oracle_reports_immutable ON arc_oracle_reports;
CREATE TRIGGER arc_oracle_reports_immutable
BEFORE UPDATE OR DELETE ON arc_oracle_reports
FOR EACH ROW EXECUTE FUNCTION arc_reject_immutable_mutation();

CREATE TABLE IF NOT EXISTS arc_oracle_fixture_state (
  adapter_id text NOT NULL REFERENCES arc_oracle_adapters(adapter_id),
  fixture_identity text NOT NULL,
  selected_report_hash text NOT NULL REFERENCES arc_oracle_reports(report_hash),
  selected_sequence numeric(78,0) NOT NULL,
  selected_correction_rank integer NOT NULL,
  selected_timestamp timestamptz NOT NULL,
  conflicted boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (adapter_id, fixture_identity)
);

CREATE TABLE IF NOT EXISTS arc_market_oracle_health (
  market_id text PRIMARY KEY REFERENCES arc_markets(market_id),
  state text NOT NULL CHECK (state IN ('HEALTHY','STALE','DIVERGENT','UNAVAILABLE','MALFORMED')),
  primary_report_hash text REFERENCES arc_oracle_reports(report_hash),
  witness_report_hash text REFERENCES arc_oracle_reports(report_hash),
  consecutive_healthy integer NOT NULL DEFAULT 0 CHECK (consecutive_healthy >= 0),
  detail text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS arc_resolution_decisions (
  decision_hash text PRIMARY KEY CHECK (decision_hash ~ '^0x[0-9a-fA-F]{64}$'),
  market_id text NOT NULL REFERENCES arc_markets(market_id),
  primary_report_hash text REFERENCES arc_oracle_reports(report_hash),
  witness_report_hash text REFERENCES arc_oracle_reports(report_hash),
  decision text NOT NULL CHECK (decision IN ('PENDING','QUORUM','INVALIDATE')),
  reason text NOT NULL,
  normalized_outcome smallint CHECK (normalized_outcome BETWEEN 0 AND 2),
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
DROP TRIGGER IF EXISTS arc_resolution_decisions_immutable ON arc_resolution_decisions;
CREATE TRIGGER arc_resolution_decisions_immutable
BEFORE UPDATE OR DELETE ON arc_resolution_decisions
FOR EACH ROW EXECUTE FUNCTION arc_reject_immutable_mutation();

CREATE TABLE IF NOT EXISTS arc_exchange_halts (
  halt_key text PRIMARY KEY,
  reason text NOT NULL CHECK (reason IN ('ORACLE_INTEGRITY','RECONCILIATION','RPC','CAP','CUSTODY_SAFETY')),
  scope text NOT NULL CHECK (scope IN ('GLOBAL','MARKET')),
  market_id text REFERENCES arc_markets(market_id),
  active boolean NOT NULL DEFAULT true,
  detail text NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  recovered_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((scope = 'GLOBAL' AND market_id IS NULL) OR (scope = 'MARKET' AND market_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS arc_exchange_halts_active_idx ON arc_exchange_halts(active, reason, market_id);

CREATE TABLE IF NOT EXISTS arc_liquidity_accounts (
  wallet text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  vault_cap_atoms numeric(78,0) NOT NULL CHECK (vault_cap_atoms > 0),
  inventory_cap_atoms numeric(78,0) NOT NULL CHECK (inventory_cap_atoms > 0),
  notional_cap_atoms numeric(78,0) NOT NULL CHECK (notional_cap_atoms > 0),
  loss_cap_atoms numeric(78,0) NOT NULL CHECK (loss_cap_atoms >= 0),
  drawdown_cap_atoms numeric(78,0) NOT NULL CHECK (drawdown_cap_atoms >= 0),
  funded_atoms numeric(78,0) NOT NULL DEFAULT 0 CHECK (funded_atoms >= 0),
  realized_pnl_atoms numeric(78,0) NOT NULL DEFAULT 0,
  peak_equity_atoms numeric(78,0) NOT NULL DEFAULT 0 CHECK (peak_equity_atoms >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (notional_cap_atoms <= vault_cap_atoms),
  CHECK (loss_cap_atoms <= vault_cap_atoms),
  CHECK (drawdown_cap_atoms <= vault_cap_atoms),
  CHECK (funded_atoms <= vault_cap_atoms)
);

CREATE TABLE IF NOT EXISTS arc_liquidity_market_budgets (
  wallet text NOT NULL REFERENCES arc_liquidity_accounts(wallet),
  market_id text NOT NULL REFERENCES arc_markets(market_id),
  enabled boolean NOT NULL DEFAULT false,
  funded_atoms numeric(78,0) NOT NULL CHECK (funded_atoms >= 0),
  daily_volume_cap_atoms numeric(78,0) NOT NULL CHECK (daily_volume_cap_atoms > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (wallet, market_id)
);

CREATE TABLE IF NOT EXISTS arc_liquidity_quote_intents (
  intent_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet text NOT NULL REFERENCES arc_liquidity_accounts(wallet),
  market_id text NOT NULL REFERENCES arc_markets(market_id),
  outcome smallint NOT NULL CHECK (outcome BETWEEN 0 AND 2),
  side text NOT NULL CHECK (side IN ('BUY','SELL')),
  price_ppm bigint NOT NULL CHECK (price_ppm > 0 AND price_ppm < 1000000),
  quantity numeric(78,0) NOT NULL CHECK (quantity > 0),
  expiry_seconds integer NOT NULL CHECK (expiry_seconds BETWEEN 30 AND 3600),
  enabled boolean NOT NULL DEFAULT false,
  active_order_hash text,
  next_nonce numeric(78,0) NOT NULL DEFAULT 1 CHECK (next_nonce > 0),
  last_attempt_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (wallet, market_id, outcome, side, price_ppm, quantity)
);
CREATE INDEX IF NOT EXISTS arc_liquidity_quote_intents_enabled_idx
  ON arc_liquidity_quote_intents(enabled, market_id, updated_at);

CREATE TABLE IF NOT EXISTS arc_risk_events (
  event_id bigserial PRIMARY KEY,
  halt_key text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('HALT_ACTIVATED','HALT_RECOVERED','RECOVERY_OBSERVED')),
  reason text NOT NULL,
  detail text NOT NULL,
  observation_count integer NOT NULL DEFAULT 0 CHECK (observation_count >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
DROP TRIGGER IF EXISTS arc_risk_events_immutable ON arc_risk_events;
CREATE TRIGGER arc_risk_events_immutable
BEFORE UPDATE OR DELETE ON arc_risk_events
FOR EACH ROW EXECUTE FUNCTION arc_reject_immutable_mutation();

CREATE TABLE IF NOT EXISTS arc_ingress_windows (
  window_start timestamptz PRIMARY KEY,
  accepted_count integer NOT NULL CHECK (accepted_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMENT ON TABLE arc_oracle_reports IS
  'Append-only raw and normalized off-chain oracle evidence. It cannot resolve a market directly.';
COMMENT ON TABLE arc_exchange_halts IS
  'Operational intake/batching halts only; rows have no authority to resolve markets or move collateral.';
