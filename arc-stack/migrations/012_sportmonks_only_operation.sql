-- Sportmonks-only ARC operation.
-- The deployed V3 verifier still requires two separately signed envelopes;
-- the confirmation adapter attests the same immutable Sportmonks payload and
-- is not represented as an independent external provider.

INSERT INTO arc_oracle_adapters(adapter_id, adapter_version, category, adapter_role, enabled, paid)
VALUES ('sportmonks.football.v3.confirmation', 1, 'SPORTS', 'WITNESS', true, false)
ON CONFLICT (adapter_id) DO UPDATE SET
  adapter_role = EXCLUDED.adapter_role,
  enabled = EXCLUDED.enabled,
  paid = EXCLUDED.paid;

UPDATE arc_oracle_adapters
   SET adapter_role = 'RESERVED', enabled = false, paid = false
 WHERE adapter_id = 'txline.sports-result.v1';

ALTER TABLE arc_markets
  ADD COLUMN IF NOT EXISTS intake_enabled boolean NOT NULL DEFAULT true;

-- Existing TxLINE-bound market specs are immutable on-chain. Keep them
-- addressable for cancellation, withdrawal, redemption and eventual grace
-- invalidation, but stop accepting new orders and omit them from default
-- public listings.
UPDATE arc_markets
   SET intake_enabled = false
 WHERE settlement_policy <> 'SPORTMONKS_ONLY_1X2_REGULATION';

ALTER TABLE arc_markets DROP CONSTRAINT IF EXISTS arc_markets_sportmonks_only_1x2_outcomes_check;
ALTER TABLE arc_markets ADD CONSTRAINT arc_markets_sportmonks_only_1x2_outcomes_check
  CHECK (settlement_policy <> 'SPORTMONKS_ONLY_1X2_REGULATION' OR outcome_count = 3) NOT VALID;
ALTER TABLE arc_markets VALIDATE CONSTRAINT arc_markets_sportmonks_only_1x2_outcomes_check;

CREATE INDEX IF NOT EXISTS arc_markets_sportmonks_only_resolution_idx
  ON arc_markets (status, close_time)
  WHERE settlement_policy = 'SPORTMONKS_ONLY_1X2_REGULATION' AND resolution_job_id IS NULL;

CREATE INDEX IF NOT EXISTS arc_markets_public_intake_idx
  ON arc_markets (category, status, close_time)
  WHERE intake_enabled;

COMMENT ON COLUMN arc_markets.intake_enabled IS
  'Fail-closed order-intake switch. Legacy provider-bound markets remain readable and redeemable but cannot accept new orders.';
COMMENT ON COLUMN arc_markets.primary_adapter_id IS
  'Immutable external evidence adapter. New ARC sports markets use Sportmonks only.';
COMMENT ON COLUMN arc_markets.witness_adapter_id IS
  'Frozen V3 second-envelope adapter. sportmonks.football.v3.confirmation is an internal confirmation of the same Sportmonks payload, not another provider.';
