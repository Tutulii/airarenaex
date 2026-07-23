import pg from "pg";
import { readFileSync } from "node:fs";
import { getAddress, type Address } from "viem";
import type { ArcConfig } from "./config.js";
import type { Logger } from "./logger.js";

const { Pool } = pg;

export type Database = pg.Pool;
export type DatabaseClient = pg.PoolClient;

export function createDatabase(config: Pick<ArcConfig, "databaseUrl">): Database {
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
  return new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: false,
    application_name: "airarena-arc",
  });
}

const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

      CREATE TABLE IF NOT EXISTS arc_auth_challenges (
        nonce text PRIMARY KEY,
        wallet text NOT NULL,
        message text NOT NULL,
        expires_at timestamptz NOT NULL,
        consumed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS arc_auth_challenges_wallet_idx
        ON arc_auth_challenges (wallet, created_at DESC);

      CREATE TABLE IF NOT EXISTS arc_api_tokens (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        wallet text NOT NULL,
        token_hash text NOT NULL UNIQUE,
        scopes text[] NOT NULL DEFAULT ARRAY['markets:read','orders:read','orders:write']::text[],
        created_at timestamptz NOT NULL DEFAULT now(),
        last_used_at timestamptz,
        revoked_at timestamptz
      );
      CREATE INDEX IF NOT EXISTS arc_api_tokens_wallet_idx ON arc_api_tokens (wallet, created_at DESC);

      CREATE TABLE IF NOT EXISTS arc_jobs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        kind text NOT NULL CHECK (kind IN ('SUBMIT_ORDER','CREATE_MARKET','RESOLVE_MARKET','INVALIDATE_MARKET')),
        payload jsonb NOT NULL,
        status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','SUCCEEDED','FAILED','DEAD')),
        attempts integer NOT NULL DEFAULT 0,
        max_attempts integer NOT NULL DEFAULT 8,
        available_at timestamptz NOT NULL DEFAULT now(),
        locked_at timestamptz,
        locked_by text,
        last_error text,
        tx_hash text,
        idempotency_key text NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS arc_jobs_claim_idx ON arc_jobs (status, available_at, created_at);

      CREATE TABLE IF NOT EXISTS arc_orders (
        order_hash text PRIMARY KEY,
        maker text NOT NULL,
        market_id text NOT NULL,
        outcome smallint NOT NULL,
        side text NOT NULL CHECK (side IN ('BUY','SELL')),
        price_ppm bigint NOT NULL,
        quantity numeric(78,0) NOT NULL,
        nonce numeric(78,0) NOT NULL,
        expiry timestamptz NOT NULL,
        client_order_id text NOT NULL,
        signature text NOT NULL,
        status text NOT NULL DEFAULT 'QUEUED',
        tx_hash text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (maker, nonce),
        UNIQUE (maker, client_order_id)
      );
      CREATE INDEX IF NOT EXISTS arc_orders_maker_idx ON arc_orders (maker, created_at DESC);
      CREATE INDEX IF NOT EXISTS arc_orders_market_idx ON arc_orders (market_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS arc_markets (
        market_id text PRIMARY KEY,
        fixture_id text NOT NULL UNIQUE,
        external_id_hash text NOT NULL,
        outcome_count smallint NOT NULL,
        close_time timestamptz NOT NULL,
        status text NOT NULL DEFAULT 'QUEUED',
        winning_outcome smallint,
        create_tx_hash text,
        resolution_tx_hash text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS arc_markets_status_idx ON arc_markets (status, close_time);

      CREATE TABLE IF NOT EXISTS arc_chain_events (
        tx_hash text NOT NULL,
        log_index integer NOT NULL,
        block_number bigint NOT NULL,
        block_hash text NOT NULL,
        event_name text NOT NULL,
        payload jsonb NOT NULL,
        observed_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tx_hash, log_index)
      );
      CREATE INDEX IF NOT EXISTS arc_chain_events_block_idx ON arc_chain_events (block_number, log_index);

      CREATE TABLE IF NOT EXISTS arc_runtime_state (
        key text PRIMARY KEY,
        value jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE arc_jobs ADD COLUMN IF NOT EXISTS owner_wallet text;
      CREATE INDEX IF NOT EXISTS arc_jobs_owner_idx ON arc_jobs (owner_wallet, created_at DESC);
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE arc_jobs DROP CONSTRAINT IF EXISTS arc_jobs_kind_check;
      ALTER TABLE arc_jobs ADD CONSTRAINT arc_jobs_kind_check
        CHECK (kind IN ('SUBMIT_ORDER','EXECUTE_MATCH','CREATE_MARKET','RESOLVE_MARKET','INVALIDATE_MARKET'));

      ALTER TABLE arc_orders ADD COLUMN IF NOT EXISTS filled_quantity numeric(78,0) NOT NULL DEFAULT 0;
      ALTER TABLE arc_orders ADD COLUMN IF NOT EXISTS match_job_id uuid REFERENCES arc_jobs(id);
      CREATE INDEX IF NOT EXISTS arc_orders_crossing_idx
        ON arc_orders (market_id, outcome, side, status, price_ppm, created_at);
    `,
  },
  {
    version: 4,
    sql: `
      ALTER TABLE arc_markets
        ADD COLUMN IF NOT EXISTS settlement_policy text NOT NULL DEFAULT 'TXLINE_1X2_REGULATION',
        ADD COLUMN IF NOT EXISTS result_home_score integer,
        ADD COLUMN IF NOT EXISTS result_away_score integer,
        ADD COLUMN IF NOT EXISTS result_source text,
        ADD COLUMN IF NOT EXISTS result_source_update_id text,
        ADD COLUMN IF NOT EXISTS result_source_timestamp timestamptz,
        ADD COLUMN IF NOT EXISTS result_observed_at timestamptz,
        ADD COLUMN IF NOT EXISTS result_evidence_hash text,
        ADD COLUMN IF NOT EXISTS result_evidence jsonb,
        ADD COLUMN IF NOT EXISTS resolution_job_id uuid REFERENCES arc_jobs(id);

      ALTER TABLE arc_markets DROP CONSTRAINT IF EXISTS arc_markets_txline_1x2_outcomes_check;
      ALTER TABLE arc_markets ADD CONSTRAINT arc_markets_txline_1x2_outcomes_check
        CHECK (settlement_policy <> 'TXLINE_1X2_REGULATION' OR outcome_count = 3) NOT VALID;
      ALTER TABLE arc_markets VALIDATE CONSTRAINT arc_markets_txline_1x2_outcomes_check;
      CREATE INDEX IF NOT EXISTS arc_markets_auto_resolution_idx
        ON arc_markets (status, close_time)
        WHERE settlement_policy = 'TXLINE_1X2_REGULATION' AND resolution_job_id IS NULL;

      CREATE TABLE IF NOT EXISTS arc_result_observations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        market_id text NOT NULL REFERENCES arc_markets(market_id),
        fixture_id text NOT NULL,
        evidence_hash text NOT NULL,
        source text NOT NULL,
        source_update_id text,
        source_timestamp timestamptz NOT NULL,
        home_score integer NOT NULL CHECK (home_score >= 0),
        away_score integer NOT NULL CHECK (away_score >= 0),
        winner text NOT NULL CHECK (winner IN ('part1','draw','part2')),
        winning_outcome smallint NOT NULL CHECK (winning_outcome BETWEEN 0 AND 2),
        evidence jsonb NOT NULL,
        observed_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (market_id, evidence_hash)
      );
      CREATE INDEX IF NOT EXISTS arc_result_observations_fixture_idx
        ON arc_result_observations (fixture_id, source_timestamp DESC);
    `,
  },
  {
    version: 5,
    sql: `
      ALTER TABLE arc_markets
        ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'SPORTS',
        ADD COLUMN IF NOT EXISTS oracle_source text NOT NULL DEFAULT 'TXLINE',
        ADD COLUMN IF NOT EXISTS oracle_reference text,
        ADD COLUMN IF NOT EXISTS display_title text,
        ADD COLUMN IF NOT EXISTS outcome_labels jsonb NOT NULL DEFAULT '["Home","Draw","Away"]'::jsonb,
        ADD COLUMN IF NOT EXISTS resolution_rules text NOT NULL DEFAULT 'Regulation-time 1X2 result';

      UPDATE arc_markets
         SET category = 'SPORTS',
             oracle_source = COALESCE(NULLIF(oracle_source, ''), 'TXLINE'),
             oracle_reference = COALESCE(oracle_reference, fixture_id),
             outcome_labels = COALESCE(outcome_labels, '["Home","Draw","Away"]'::jsonb),
             resolution_rules = COALESCE(NULLIF(resolution_rules, ''), 'Regulation-time 1X2 result');

      ALTER TABLE arc_markets ALTER COLUMN oracle_reference SET NOT NULL;

      ALTER TABLE arc_markets DROP CONSTRAINT IF EXISTS arc_markets_category_check;
      ALTER TABLE arc_markets ADD CONSTRAINT arc_markets_category_check
        CHECK (category IN ('SPORTS','CRYPTO','POLITICS'));

      ALTER TABLE arc_markets DROP CONSTRAINT IF EXISTS arc_markets_oracle_source_check;
      ALTER TABLE arc_markets ADD CONSTRAINT arc_markets_oracle_source_check
        CHECK (char_length(oracle_source) BETWEEN 1 AND 64);

      ALTER TABLE arc_markets DROP CONSTRAINT IF EXISTS arc_markets_outcome_labels_check;
      ALTER TABLE arc_markets ADD CONSTRAINT arc_markets_outcome_labels_check
        CHECK (
          jsonb_typeof(outcome_labels) = 'array'
          AND jsonb_array_length(outcome_labels) = outcome_count
        );

      CREATE INDEX IF NOT EXISTS arc_markets_category_status_idx
        ON arc_markets (category, status, close_time);
      CREATE INDEX IF NOT EXISTS arc_markets_oracle_source_idx
        ON arc_markets (oracle_source, oracle_reference);
    `,
  },
  {
    version: 6,
    sql: readFileSync(new URL("../migrations/006_signed_intake_and_batch_clearing.sql", import.meta.url), "utf8"),
  },
  {
    version: 7,
    sql: readFileSync(new URL("../migrations/007_days_11_14_exchange_surface.sql", import.meta.url), "utf8"),
  },
  {
    version: 8,
    sql: readFileSync(new URL("../migrations/008_days_15_18_evidence_exchange.sql", import.meta.url), "utf8"),
  },
];

export async function migrateDatabase(db: Database, logger: Logger): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('airarena_arc_migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS arc_schema_migrations (
        version integer PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const applied = await client.query<{ version: number }>("SELECT version FROM arc_schema_migrations");
    const versions = new Set(applied.rows.map((row) => row.version));
    for (const migration of MIGRATIONS) {
      if (versions.has(migration.version)) continue;
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query("INSERT INTO arc_schema_migrations(version) VALUES ($1)", [migration.version]);
        await client.query("COMMIT");
        logger.info({ version: migration.version }, "arc_database_migration_applied");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('airarena_arc_migrations'))").catch(() => undefined);
    client.release();
  }
}

export async function databaseReady(db: Database): Promise<boolean> {
  try {
    const result = await db.query<{ ok: number }>("SELECT 1 AS ok");
    return result.rows[0]?.ok === 1;
  } catch {
    return false;
  }
}

/** Permanently binds this database ledger to one non-upgradeable exchange deployment. */
export async function bindDatabaseToExchange(db: Database, chainId: number, exchangeAddress: Address): Promise<void> {
  const address = getAddress(exchangeAddress);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('airarena_arc_exchange_binding'))");
    await client.query(
      `INSERT INTO arc_deployment_binding(singleton, chain_id, exchange_address)
       VALUES (true, $1, $2) ON CONFLICT (singleton) DO NOTHING`,
      [chainId, address],
    );
    const binding = await client.query<{ chain_id: string; exchange_address: string }>(
      "SELECT chain_id::text, exchange_address FROM arc_deployment_binding WHERE singleton = true",
    );
    const row = binding.rows[0];
    if (!row || Number(row.chain_id) !== chainId || getAddress(row.exchange_address) !== address) {
      throw new Error("database_exchange_binding_mismatch");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
