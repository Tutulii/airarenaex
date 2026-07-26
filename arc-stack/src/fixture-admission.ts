import { getAddress, keccak256, stringToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import type { ArcConfig } from "./config.js";
import { ARC_CHAIN_ID, ARC_USDC_ADDRESS } from "./config.js";
import type { Database, DatabaseClient } from "./db.js";
import { enqueueJob } from "./jobs.js";
import type { Logger } from "./logger.js";
import {
  ARC_EXCHANGE_V3_ADDRESS,
  canonicalizeArcJson,
  finalizeArcMarketSpec,
  type ArcMarketSpecDraft,
  type FinalizedArcMarketSpec,
} from "./market-spec.js";
import { canonicalOracleJson, ORACLE_ADAPTERS, sportmonksAccessTier } from "./oracle-adapter.js";
import { verifyQualifyingWitness, type WitnessBinding } from "./oracle-state.js";
import { assertActiveMarketCap } from "./risk-controls.js";

const PRIMARY_SOURCE_ID = "sportmonks-primary";
const WITNESS_SOURCE_ID = "sportmonks-confirmation";
const PRIMARY_SOURCE_ID_HASH = keccak256(stringToHex("air-arena/oracle/sportmonks-primary/v1"));
const WITNESS_SOURCE_ID_HASH = keccak256(stringToHex("air-arena/oracle/sportmonks-confirmation/v1"));
const TRADING_WINDOW_SECONDS = 365 * 24 * 60 * 60;
const TRADING_CLOSE_OFFSET_SECONDS = 119 * 60;
const RESOLUTION_EARLIEST_OFFSET_SECONDS = 120 * 60;
const RESOLUTION_GRACE_SECONDS = 900;
const LEADERSHIP_RETRY_MS = 5_000;

const SportmonksParticipantSchema = z.object({
  id: z.union([z.string(), z.number()]),
  name: z.string().trim().min(1),
  meta: z.object({ location: z.enum(["home", "away"]) }).passthrough().optional(),
}).passthrough();

const SportmonksFixtureSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  starting_at: z.string(),
  participants: z.array(SportmonksParticipantSchema).default([]),
}).passthrough();

const SportmonksDateEnvelopeSchema = z.object({
  data: z.array(SportmonksFixtureSchema),
  subscription: z.array(z.unknown()).min(1),
  pagination: z.object({
    current_page: z.number().int().positive().optional(),
    next_page: z.union([z.number().int().positive(), z.string().url()]).nullable().optional(),
    has_more: z.boolean().optional(),
  }).passthrough().optional(),
}).passthrough();

export type AdmissionRuntimeState = {
  stopping: boolean;
  fixtureAdmissionLeader: boolean;
  lastFixtureAdmissionAt: string | null;
  lastFixtureAdmissionError: string | null;
  fixtureAdmissionScanned: number;
  fixtureAdmissionAdmitted: number;
};

export type SportmonksFixture = {
  fixtureIdentity: string;
  homeTeam: string;
  awayTeam: string;
  startsAt: string;
  accessTier: "FREE" | "TRIAL";
  raw: unknown;
};

export type AdmissionCycleResult = {
  scanned: number;
  eligible: number;
  admitted: number;
  skipped: number;
  failed: number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function hashJson(value: unknown): Hex {
  return keccak256(stringToHex(canonicalOracleJson(value)));
}

function normalizeTeam(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function canonicalUtcSecond(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new Error("fixture_start_time_invalid");
  return date.toISOString().replace(".000Z", "Z");
}

function parseProviderUtc(value: string): Date {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) throw new Error("fixture_start_time_invalid");
  return date;
}

function participantAt(fixture: z.infer<typeof SportmonksFixtureSchema>, location: "home" | "away"): string | null {
  const participants = fixture.participants.filter((participant) => participant.meta?.location === location);
  return participants.length === 1 ? participants[0]!.name : null;
}

export function normalizeSportmonksFixturePage(payload: unknown): {
  fixtures: SportmonksFixture[];
  nextPage: number | null;
} {
  const parsed = SportmonksDateEnvelopeSchema.parse(payload);
  const accessTier = sportmonksAccessTier(parsed.subscription);
  if (!accessTier) throw new Error("fixture_admission_paid_subscription_forbidden");
  const fixtures = parsed.data.flatMap((fixture) => {
    const homeTeam = participantAt(fixture, "home");
    const awayTeam = participantAt(fixture, "away");
    if (!homeTeam || !awayTeam) return [];
    return [{
      fixtureIdentity: fixture.id,
      homeTeam,
      awayTeam,
      startsAt: fixture.starting_at,
      accessTier,
      raw: fixture,
    }];
  }).sort((left, right) => {
    const time = parseProviderUtc(left.startsAt).getTime() - parseProviderUtc(right.startsAt).getTime();
    return time || left.fixtureIdentity.localeCompare(right.fixtureIdentity);
  });
  const pagination = parsed.pagination;
  const providerNextPage = typeof pagination?.next_page === "string"
    ? Number(new URL(pagination.next_page).searchParams.get("page"))
    : pagination?.next_page;
  const validProviderNextPage = Number.isInteger(providerNextPage) && Number(providerNextPage) > 0
    ? Number(providerNextPage)
    : null;
  const nextPage = validProviderNextPage
    ?? (pagination?.has_more ? (pagination.current_page ?? 1) + 1 : null);
  return { fixtures, nextPage };
}

export function sportmonksFixtureEligibility(
  fixture: SportmonksFixture,
  options: { nowMs: number; horizonDays: number; minLeadSeconds: number },
): { eligible: true; startsAt: Date } | { eligible: false; reason: string } {
  if (normalizeTeam(fixture.homeTeam) === normalizeTeam(fixture.awayTeam)) {
    return { eligible: false, reason: "fixture_participants_not_distinct" };
  }
  const startsAt = parseProviderUtc(fixture.startsAt);
  if (startsAt.getTime() < options.nowMs + options.minLeadSeconds * 1_000) {
    return { eligible: false, reason: "fixture_inside_minimum_lead_window" };
  }
  if (startsAt.getTime() > options.nowMs + options.horizonDays * 86_400_000) {
    return { eligible: false, reason: "fixture_outside_admission_horizon" };
  }
  return { eligible: true, startsAt };
}

export function buildAutomaticMarketSpec(
  config: Pick<ArcConfig,
    "chainId" | "usdcAddress" | "exchangeAddress" | "oraclePrimarySignerPrivateKey" | "oracleWitnessSignerPrivateKey">,
  primary: SportmonksFixture,
): FinalizedArcMarketSpec {
  if (config.chainId !== ARC_CHAIN_ID || config.usdcAddress !== getAddress(ARC_USDC_ADDRESS)) {
    throw new Error("fixture_admission_chain_or_collateral_mismatch");
  }
  if (!config.exchangeAddress || config.exchangeAddress !== ARC_EXCHANGE_V3_ADDRESS) {
    throw new Error("fixture_admission_exchange_v3_required");
  }
  if (!config.oraclePrimarySignerPrivateKey || !config.oracleWitnessSignerPrivateKey) {
    throw new Error("fixture_admission_oracle_signers_missing");
  }
  const startsAt = parseProviderUtc(primary.startsAt);
  const startSeconds = Math.floor(startsAt.getTime() / 1_000);
  const draft: ArcMarketSpecDraft = {
    schemaVersion: "arc-market-spec-v1",
    chain: {
      family: "EVM",
      network: "arc-testnet",
      chainId: ARC_CHAIN_ID,
      exchangeAddress: ARC_EXCHANGE_V3_ADDRESS,
      contractVersion: "arena-exchange-v3",
    },
    marketNonce: "1",
    category: "SPORTS",
    templateId: "sports.result.1x2.v1",
    collateral: {
      tokenAddress: getAddress(ARC_USDC_ADDRESS),
      symbol: "USDC",
      decimals: 6,
      payoutAtoms: "1000000",
    },
    outcomes: [
      { index: 0, id: "home", label: `${primary.homeTeam} win` },
      { index: 1, id: "draw", label: "Draw" },
      { index: 2, id: "away", label: `${primary.awayTeam} win` },
    ],
    scheduledStartAt: canonicalUtcSecond(new Date(startSeconds * 1_000)),
    tradingOpensAt: canonicalUtcSecond(new Date((startSeconds - TRADING_WINDOW_SECONDS) * 1_000)),
    tradingClosesAt: canonicalUtcSecond(new Date((startSeconds + TRADING_CLOSE_OFFSET_SECONDS) * 1_000)),
    resolutionEarliestAt: canonicalUtcSecond(new Date((startSeconds + RESOLUTION_EARLIEST_OFFSET_SECONDS) * 1_000)),
    parameters: {
      version: "arc.launch-v1",
      collateralAllowlistVersion: "arc.collateral-v1",
      batch: {
        version: "arc.batch-v1",
        intervalMs: 2000,
        cancelCutoffMs: 200,
        priceScalePpm: 1_000_000,
        minPricePpm: 1000,
        maxPricePpm: 999000,
        minQuantityAtoms: "10000",
        quantityStepAtoms: "10000",
        maxOrdersPerBatch: 10000,
        allocationMethod: "PRO_RATA_AT_CLEARING_PRICE_V1",
        tieBreakMethod: "ORDER_HASH_ASC_V1",
      },
      fees: {
        version: "arc.fees-v1",
        tradeFeeBps: 25,
        rounding: "CEIL",
        minimumFeeAtoms: "1",
        collector: "PROTOCOL_FEE_VAULT",
      },
      caps: {
        version: "arc.caps-v1",
        walletCollateralAtoms: "1000000000",
        walletOpenOrderReserveAtoms: "500000000",
        marketCollateralAtoms: "10000000000",
        treasuryMarketBudgetAtoms: "1000000000",
        globalCollateralAtoms: "50000000000",
        maxOrderQuantityAtoms: "100000000",
        maxOpenOrdersPerWallet: 100,
      },
      oracle: {
        version: "arc.oracle-v1",
        // The V3 contract has a frozen two-envelope interface. Both envelopes
        // bind one Sportmonks payload and are signed by separate AIR Arena
        // keys; this value does not represent two external providers.
        minimumIndependentSources: 2,
        maxReportAgeSeconds: 120,
        maxSourceTimestampSkewSeconds: 30,
        minimumArcConfirmations: 2,
        onIntegrityFailure: "HALT",
      },
      referenceData: {
        version: "arc.reference-v1",
        liveOddsExecution: "NEVER",
        staleDataAction: "SUSPEND_MATCHING",
      },
    },
    resolutionRule: {
      version: "sportmonks.football.1x2-v1",
      adapter: "sportmonks.football.v3",
      fixtureId: primary.fixtureIdentity,
      sport: "football",
      settlementBasis: "REGULATION_TIME",
      primarySourceId: PRIMARY_SOURCE_ID,
      witnessSourceId: WITNESS_SOURCE_ID,
      fieldMapping: {
        fixtureId: "data.id",
        status: "data.state.short_name",
        homeScore: "normalized.regulationHomeScore",
        awayScore: "normalized.regulationAwayScore",
        action: "data.result_info",
      },
      finalStatuses: ["ft", "aet", "ft_pen", "final"],
      finalActions: ["result_final"],
      graceSeconds: RESOLUTION_GRACE_SECONDS,
      onDivergence: "INVALID",
      onUnavailable: "INVALID",
      correctionPolicy: "ACCEPT_BEFORE_FINALIZATION_ONLY",
    },
    invalidation: {
      version: "arc.invalidation-v1",
      payoutMethod: "EQUAL_PER_OUTCOME",
      rounding: "FLOOR",
      remainderDestination: "PROTOCOL_DUST_VAULT",
    },
  };
  return finalizeArcMarketSpec(draft);
}

type AdmissionCursor = { windowStart: string; page: number };
const ADMISSION_WINDOW_DAYS = 7;
const MAX_PROVIDER_PAGES_PER_CYCLE = 10;

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function nextWindow(cursor: AdmissionCursor): AdmissionCursor {
  return {
    windowStart: utcDate(Date.parse(`${cursor.windowStart}T00:00:00Z`) + ADMISSION_WINDOW_DAYS * 86_400_000),
    page: 1,
  };
}

async function readAdmissionCursor(db: Database, config: ArcConfig, nowMs: number): Promise<AdmissionCursor> {
  const today = utcDate(nowMs);
  const horizonEnd = utcDate(nowMs + config.fixtureAdmission.horizonDays * 86_400_000);
  const result = await db.query<{ value: { windowStart?: unknown; page?: unknown } }>(
    "SELECT value FROM arc_runtime_state WHERE key = 'sportmonks_admission_cursor'",
  );
  const stored = result.rows[0]?.value;
  const windowStart = typeof stored?.windowStart === "string" ? stored.windowStart : today;
  const page = typeof stored?.page === "number" && Number.isInteger(stored.page) && stored.page > 0 ? stored.page : 1;
  if (windowStart < today || windowStart > horizonEnd) return { windowStart: today, page: 1 };
  return { windowStart, page };
}

async function writeAdmissionCursor(db: Database, cursor: AdmissionCursor): Promise<void> {
  await db.query(
    `INSERT INTO arc_runtime_state(key, value, updated_at)
     VALUES ('sportmonks_admission_cursor', $1::jsonb, clock_timestamp())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = clock_timestamp()`,
    [JSON.stringify(cursor)],
  );
}

async function fetchSportmonksFixturePage(
  config: ArcConfig,
  cursor: AdmissionCursor,
): Promise<{ fixtures: SportmonksFixture[]; nextPage: number | null }> {
  if (!config.sportmonksApiToken) throw new Error("fixture_admission_primary_token_missing");
  const end = utcDate(Date.parse(`${cursor.windowStart}T00:00:00Z`) + (ADMISSION_WINDOW_DAYS - 1) * 86_400_000);
  const url = new URL(`${config.sportmonksApiUrl}/fixtures/between/${cursor.windowStart}/${end}`);
  url.searchParams.set("api_token", config.sportmonksApiToken);
  url.searchParams.set("include", "participants;state");
  url.searchParams.set("per_page", "50");
  url.searchParams.set("page", String(cursor.page));
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "airarena-arc-fixture-admission/1" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`fixture_admission_primary_http_${response.status}`);
  const raw = await response.text();
  if (raw.length > 5_000_000) throw new Error("fixture_admission_primary_payload_too_large");
  return normalizeSportmonksFixturePage(JSON.parse(raw) as unknown);
}

async function appendAdmissionEvent(
  db: Database | DatabaseClient,
  input: {
    fixtureId: string;
    eventType: string;
    candidateHash: Hex;
    marketId?: Hex;
    witnessFixtureIdentity?: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO arc_fixture_admission_events(
       primary_fixture_identity, event_type, candidate_hash, market_id,
       witness_fixture_identity, payload_hash, payload
     ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [
      input.fixtureId, input.eventType, input.candidateHash, input.marketId ?? null,
      input.witnessFixtureIdentity ?? null, hashJson(input.payload), JSON.stringify(input.payload),
    ],
  );
}

async function recordAdmissionDecision(
  db: Database,
  fixture: SportmonksFixture,
  input: {
    status: "DISCOVERED" | "INELIGIBLE" | "FAILED";
    eventType: "DISCOVERED" | "INELIGIBLE" | "ADMISSION_FAILED";
    error?: string;
    retrySeconds?: number;
  },
): Promise<void> {
  const stateIdentity = `sportmonks-only:${fixture.fixtureIdentity}`;
  const candidateHash = hashJson(fixture.raw);
  const payload = {
    status: input.status,
    reason: input.error ?? null,
    candidateHash,
  };
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO arc_fixture_admission_state(
         primary_fixture_identity, status, candidate_hash, primary_snapshot,
         witness_fixture_identity, witness_candidate_hash, witness_snapshot,
         attempt_count, last_error, next_attempt_at
       ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb,1,$8,
         CASE WHEN $9::integer IS NULL THEN NULL ELSE clock_timestamp() + ($9::integer * interval '1 second') END)
       ON CONFLICT (primary_fixture_identity) DO UPDATE SET
         status = EXCLUDED.status, candidate_hash = EXCLUDED.candidate_hash,
         primary_snapshot = EXCLUDED.primary_snapshot,
         witness_fixture_identity = EXCLUDED.witness_fixture_identity,
         witness_candidate_hash = EXCLUDED.witness_candidate_hash,
         witness_snapshot = EXCLUDED.witness_snapshot,
         attempt_count = arc_fixture_admission_state.attempt_count + 1,
         last_error = EXCLUDED.last_error, next_attempt_at = EXCLUDED.next_attempt_at,
         last_observed_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE arc_fixture_admission_state.status <> 'ADMITTED'`,
      [
        stateIdentity, input.status, candidateHash, JSON.stringify(fixture.raw),
        fixture.fixtureIdentity, candidateHash, JSON.stringify(fixture.raw),
        input.error?.slice(0, 1000) ?? null, input.retrySeconds ?? null,
      ],
    );
    const eventInput: Parameters<typeof appendAdmissionEvent>[1] = {
      fixtureId: stateIdentity,
      eventType: input.eventType,
      candidateHash,
      payload,
    };
    eventInput.witnessFixtureIdentity = fixture.fixtureIdentity;
    await appendAdmissionEvent(client, eventInput);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function shouldAttempt(db: Database, fixtureId: string): Promise<boolean> {
  const existingMarket = await db.query<{ present: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM arc_markets WHERE fixture_id = $1) AS present",
    [fixtureId],
  );
  if (existingMarket.rows[0]?.present) return false;
  const stateIdentity = `sportmonks-only:${fixtureId}`;
  const result = await db.query<{ status: string; due: boolean }>(
    `SELECT status, (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp()) AS due
       FROM arc_fixture_admission_state WHERE primary_fixture_identity = $1`,
    [stateIdentity],
  );
  const row = result.rows[0];
  return !row || (row.status !== "ADMITTED" && row.due);
}

async function admitMarket(
  config: ArcConfig,
  db: Database,
  primary: SportmonksFixture,
): Promise<{ marketId: Hex; jobId: string; created: boolean }> {
  const binding: WitnessBinding = {
    adapterId: ORACLE_ADAPTERS.SPORTMONKS_CONFIRMATION_V1,
    fixtureIdentity: primary.fixtureIdentity,
    accessTier: primary.accessTier,
    authenticated: true,
  };
  const qualification = await verifyQualifyingWitness(binding, config);
  const spec = buildAutomaticMarketSpec(config, primary);
  const externalIdHash = keccak256(stringToHex(`sportmonks:${primary.fixtureIdentity}`));
  const sourceEventId = keccak256(stringToHex(`sportmonks:${primary.fixtureIdentity}`));
  const primarySigner = privateKeyToAccount(config.oraclePrimarySignerPrivateKey!).address;
  const witnessSigner = privateKeyToAccount(config.oracleWitnessSignerPrivateKey!).address;
  const resolutionRule = {
    primarySourceId: PRIMARY_SOURCE_ID_HASH,
    witnessSourceId: WITNESS_SOURCE_ID_HASH,
    sourceEventId,
    primarySigner,
    witnessSigner,
    maxReportAgeSeconds: "120",
    maxSourceTimestampSkewSeconds: "30",
    graceSeconds: String(RESOLUTION_GRACE_SECONDS),
  };
  const closeTime = new Date(spec.tradingClosesAt);
  const candidateHash = hashJson(primary.raw);
  const witnessCandidateHash = candidateHash;
  const stateIdentity = `sportmonks-only:${primary.fixtureIdentity}`;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('airarena_arc_market_creation'))");
    const existing = await client.query<{ market_id: Hex; fixture_id: string; spec_hash: Hex | null }>(
      "SELECT market_id, fixture_id, spec_hash FROM arc_markets WHERE fixture_id = $1 OR market_id = $2 FOR UPDATE",
      [primary.fixtureIdentity, spec.marketId],
    );
    const existingMarket = existing.rows[0];
    if (existingMarket) {
      if (existingMarket.market_id.toLowerCase() !== spec.marketId.toLowerCase()
          || existingMarket.fixture_id !== primary.fixtureIdentity
          || existingMarket.spec_hash?.toLowerCase() !== spec.specHash.toLowerCase()) {
        throw new Error("fixture_admission_existing_market_conflict");
      }
    } else {
      const active = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM arc_markets WHERE status IN ('QUEUED','OPEN')",
      );
      assertActiveMarketCap(Number(active.rows[0]?.count ?? "0"), config.riskLimits.activeMarkets);
      await client.query(
        `INSERT INTO arc_markets(
           market_id, fixture_id, external_id_hash, outcome_count, close_time, status, settlement_policy,
           category, oracle_source, oracle_reference, display_title, outcome_labels, resolution_rules,
           spec_hash, resolution_rule, primary_adapter_id, primary_fixture_identity,
           witness_adapter_id, witness_fixture_identity, witness_access_tier, witness_qualified_at,
           witness_qualification_hash, witness_qualification_observed_at, market_spec, admission_source
         ) VALUES (
           $1,$2,$3,3,$4,'QUEUED','SPORTMONKS_ONLY_1X2_REGULATION',
           'SPORTS','SPORTMONKS',$2,$5,$6::jsonb,'Regulation-time 1X2 result',
           $7,$8::jsonb,$9,$2,$10,$11,$12,clock_timestamp(),$13,$14,$15::jsonb,'AUTOMATIC_FIXTURE_WORKER'
         )`,
        [
          spec.marketId, primary.fixtureIdentity, externalIdHash, closeTime,
          `${primary.homeTeam} vs ${primary.awayTeam}`,
          JSON.stringify([primary.homeTeam, "Draw", primary.awayTeam]),
          spec.specHash, JSON.stringify(resolutionRule), ORACLE_ADAPTERS.SPORTMONKS_V1,
          ORACLE_ADAPTERS.SPORTMONKS_CONFIRMATION_V1, primary.fixtureIdentity, primary.accessTier,
          qualification.rawPayloadHash, qualification.observedAt, canonicalizeArcJson(spec),
        ],
      );
    }
    const job = await enqueueJob(client, "CREATE_MARKET", {
      marketId: spec.marketId as Hex,
      specHash: spec.specHash,
      externalIdHash,
      fixtureId: primary.fixtureIdentity,
      outcomeCount: 3,
      closeTime: String(Math.floor(closeTime.getTime() / 1_000)),
      resolutionRule,
    }, `create-market:${spec.marketId}`);
    await client.query(
      `INSERT INTO arc_fixture_admission_state(
         primary_fixture_identity, status, candidate_hash, primary_snapshot,
         witness_fixture_identity, witness_candidate_hash, witness_snapshot,
         market_id, attempt_count, last_error, next_attempt_at, admitted_at
       ) VALUES ($1,'ADMITTED',$2,$3::jsonb,$4,$5,$6::jsonb,$7,1,NULL,NULL,clock_timestamp())
       ON CONFLICT (primary_fixture_identity) DO UPDATE SET
         status = 'ADMITTED', candidate_hash = EXCLUDED.candidate_hash,
         primary_snapshot = EXCLUDED.primary_snapshot,
         witness_fixture_identity = EXCLUDED.witness_fixture_identity,
         witness_candidate_hash = EXCLUDED.witness_candidate_hash,
         witness_snapshot = EXCLUDED.witness_snapshot, market_id = EXCLUDED.market_id,
         attempt_count = arc_fixture_admission_state.attempt_count + 1,
         last_error = NULL, next_attempt_at = NULL, admitted_at = clock_timestamp(),
         last_observed_at = clock_timestamp(), updated_at = clock_timestamp()`,
      [stateIdentity, candidateHash, JSON.stringify(primary.raw), primary.fixtureIdentity,
        witnessCandidateHash, JSON.stringify(primary.raw), spec.marketId],
    );
    await appendAdmissionEvent(client, {
      fixtureId: stateIdentity,
      eventType: "MARKET_ADMITTED",
      candidateHash,
      marketId: spec.marketId as Hex,
      witnessFixtureIdentity: primary.fixtureIdentity,
      payload: {
        marketId: spec.marketId,
        specHash: spec.specHash,
        jobId: job.id,
        witnessCandidateHash,
        witnessQualificationHash: qualification.rawPayloadHash,
      },
    });
    await client.query("COMMIT");
    return { marketId: spec.marketId as Hex, jobId: job.id, created: !existingMarket };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function writeAdmissionHeartbeat(db: Database, state: AdmissionRuntimeState, result: AdmissionCycleResult): Promise<void> {
  await db.query(
    `INSERT INTO arc_runtime_state(key, value, updated_at)
     VALUES ('fixture_admission_heartbeat', jsonb_build_object(
       'enabled', true, 'lastCycleAt', $1::text, 'lastError', $2::text,
       'scanned', $3::integer, 'eligible', $4::integer, 'admitted', $5::integer,
       'skipped', $6::integer, 'failed', $7::integer
     ), clock_timestamp())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = clock_timestamp()`,
    [state.lastFixtureAdmissionAt, state.lastFixtureAdmissionError, result.scanned,
      result.eligible, result.admitted, result.skipped, result.failed],
  );
}

export async function fixtureAdmissionReady(db: Database, config: ArcConfig): Promise<boolean> {
  if (!config.fixtureAdmission.enabled) return true;
  const maxAgeMs = Math.max(180_000, config.fixtureAdmission.intervalMs * 2);
  const result = await db.query<{ fresh: boolean }>(
    `SELECT updated_at > clock_timestamp() - ($1::bigint * interval '1 millisecond') AS fresh
       FROM arc_runtime_state WHERE key = 'fixture_admission_heartbeat'`,
    [maxAgeMs],
  );
  return result.rows[0]?.fresh === true;
}

export async function runFixtureAdmissionCycle(
  config: ArcConfig,
  db: Database,
  logger: Logger,
  state: AdmissionRuntimeState,
): Promise<AdmissionCycleResult> {
  const nowMs = Date.now();
  const today = utcDate(nowMs);
  const horizonEnd = utcDate(nowMs + config.fixtureAdmission.horizonDays * 86_400_000);
  let cursor = await readAdmissionCursor(db, config, nowMs);
  const result: AdmissionCycleResult = { scanned: 0, eligible: 0, admitted: 0, skipped: 0, failed: 0 };
  let providerPages = 0;
  let keepCurrentPage = false;

  while (!state.stopping
      && result.scanned < config.fixtureAdmission.scanLimit
      && providerPages < MAX_PROVIDER_PAGES_PER_CYCLE
      && cursor.windowStart <= horizonEnd) {
    const page = await fetchSportmonksFixturePage(config, cursor);
    providerPages += 1;
    keepCurrentPage = false;
    for (const fixture of page.fixtures) {
      if (state.stopping || result.scanned >= config.fixtureAdmission.scanLimit) {
        keepCurrentPage = true;
        break;
      }
      result.scanned += 1;
      const eligibility = sportmonksFixtureEligibility(fixture, {
        nowMs,
        horizonDays: config.fixtureAdmission.horizonDays,
        minLeadSeconds: config.fixtureAdmission.minLeadSeconds,
      });
      if (!eligibility.eligible) {
        result.skipped += 1;
        continue;
      }
      result.eligible += 1;
      if (!(await shouldAttempt(db, fixture.fixtureIdentity))) {
        result.skipped += 1;
        continue;
      }
      if (result.admitted >= config.fixtureAdmission.maxPerRun) {
        // Re-read this deterministic provider page next cycle. Already-admitted
        // fixtures are idempotently skipped, so no fixture is lost at the cap.
        keepCurrentPage = true;
        break;
      }
      try {
        const admitted = await admitMarket(config, db, fixture);
        result.admitted += 1;
        logger.info({
          fixtureId: fixture.fixtureIdentity,
          primaryFixtureId: fixture.fixtureIdentity,
          confirmationFixtureId: fixture.fixtureIdentity,
          marketId: admitted.marketId,
          jobId: admitted.jobId,
          created: admitted.created,
        }, "arc_fixture_market_admitted");
      } catch (error) {
        result.failed += 1;
        const message = errorMessage(error);
        await recordAdmissionDecision(db, fixture, {
          status: "FAILED",
          eventType: "ADMISSION_FAILED",
          error: message,
          retrySeconds: config.fixtureAdmission.retrySeconds,
        }).catch(() => undefined);
        logger.warn({ err: error, fixtureId: fixture.fixtureIdentity }, "arc_fixture_admission_failed_closed");
      }
    }
    if (keepCurrentPage) break;
    cursor = page.nextPage ? { ...cursor, page: page.nextPage } : nextWindow(cursor);
  }
  if (cursor.windowStart > horizonEnd) cursor = { windowStart: today, page: 1 };
  await writeAdmissionCursor(db, cursor);
  state.lastFixtureAdmissionAt = new Date().toISOString();
  state.fixtureAdmissionScanned = result.scanned;
  state.fixtureAdmissionAdmitted += result.admitted;
  await writeAdmissionHeartbeat(db, state, result);
  return result;
}

export async function runFixtureAdmissionWorker(
  config: ArcConfig,
  db: Database,
  logger: Logger,
  state: AdmissionRuntimeState,
): Promise<void> {
  if (!config.fixtureAdmission.enabled) {
    logger.info("arc_fixture_admission_disabled");
    return;
  }
  const lockClient = await db.connect();
  try {
    while (!state.stopping) {
      const lock = await lockClient.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext('airarena_arc_fixture_admission')) AS acquired",
      );
      if (lock.rows[0]?.acquired) break;
      // Railway performs rolling replacements, so the outgoing instance can
      // briefly retain this session lock. Leadership retry must stay short and
      // independent from the much longer provider polling interval.
      await delay(LEADERSHIP_RETRY_MS);
    }
    if (state.stopping) return;
    state.fixtureAdmissionLeader = true;
    logger.info({ fixtureAdmission: config.fixtureAdmission }, "arc_fixture_admission_started");
    while (!state.stopping) {
      try {
        state.lastFixtureAdmissionError = null;
        const result = await runFixtureAdmissionCycle(config, db, logger, state);
        logger.info(result, "arc_fixture_admission_cycle_completed");
      } catch (error) {
        state.lastFixtureAdmissionAt = new Date().toISOString();
        state.lastFixtureAdmissionError = errorMessage(error);
        logger.error({ err: error }, "arc_fixture_admission_cycle_failed_closed");
        await writeAdmissionHeartbeat(db, state, {
          scanned: 0, eligible: 0, admitted: 0, skipped: 0, failed: 1,
        }).catch(() => undefined);
      }
      await delay(config.fixtureAdmission.intervalMs);
    }
  } finally {
    state.fixtureAdmissionLeader = false;
    await lockClient.query("SELECT pg_advisory_unlock(hashtext('airarena_arc_fixture_admission'))").catch(() => undefined);
    lockClient.release();
  }
}
