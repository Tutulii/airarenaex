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

const PRIMARY_SOURCE_ID = "txline-primary";
const WITNESS_SOURCE_ID = "approved-result-witness";
const PRIMARY_SOURCE_ID_HASH = keccak256(stringToHex("air-arena/oracle/txline-primary/v1"));
const WITNESS_SOURCE_ID_HASH = keccak256(stringToHex("air-arena/oracle/sportmonks-witness/v1"));
const TRADING_WINDOW_SECONDS = 365 * 24 * 60 * 60;
const TRADING_CLOSE_OFFSET_SECONDS = 119 * 60;
const RESOLUTION_EARLIEST_OFFSET_SECONDS = 120 * 60;
const RESOLUTION_GRACE_SECONDS = 900;

const TxlineFixtureSchema = z.object({
  fixtureId: z.union([z.string(), z.number()]).transform(String),
  sport: z.string(),
  homeTeam: z.string().trim().min(1),
  awayTeam: z.string().trim().min(1),
  startsAt: z.string(),
  status: z.string(),
  marketTypes: z.array(z.string()).default([]),
  raw: z.unknown().optional(),
}).passthrough();

const TxlineFixtureEnvelopeSchema = z.object({
  data: z.union([
    z.array(TxlineFixtureSchema),
    z.object({ data: z.array(TxlineFixtureSchema) }).passthrough(),
  ]),
}).passthrough();

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
}).passthrough();

export type AdmissionRuntimeState = {
  stopping: boolean;
  fixtureAdmissionLeader: boolean;
  lastFixtureAdmissionAt: string | null;
  lastFixtureAdmissionError: string | null;
  fixtureAdmissionScanned: number;
  fixtureAdmissionAdmitted: number;
};

export type PrimaryFixture = z.infer<typeof TxlineFixtureSchema>;

export type WitnessFixture = {
  fixtureIdentity: string;
  homeTeam: string;
  awayTeam: string;
  startsAt: string;
  accessTier: "FREE" | "TRIAL";
  raw: unknown;
};

export type WitnessMatch =
  | { kind: "MATCH"; witness: WitnessFixture }
  | { kind: "NONE"; reason: string }
  | { kind: "AMBIGUOUS"; reason: string; candidates: WitnessFixture[] };

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

function sameUtcDate(left: string, right: string): boolean {
  const leftDate = new Date(left);
  const normalizedRight = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(right)
    ? `${right.replace(" ", "T")}Z`
    : right;
  const rightDate = new Date(normalizedRight);
  return Number.isFinite(leftDate.getTime())
    && Number.isFinite(rightDate.getTime())
    && leftDate.toISOString().slice(0, 10) === rightDate.toISOString().slice(0, 10);
}

export function primaryFixtureEligibility(
  fixture: PrimaryFixture,
  options: { nowMs: number; horizonDays: number; minLeadSeconds: number },
): { eligible: true; startsAt: Date } | { eligible: false; reason: string } {
  if (fixture.sport.trim().toLowerCase() !== "football") return { eligible: false, reason: "unsupported_sport" };
  if (!fixture.marketTypes.includes("1X2_PARTICIPANT_RESULT")) {
    return { eligible: false, reason: "unsupported_market_template" };
  }
  const status = fixture.status.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!["upcoming", "scheduled", "not_started", "notstarted", "pre_match"].includes(status)) {
    return { eligible: false, reason: `fixture_not_upcoming:${status}` };
  }
  if (normalizeTeam(fixture.homeTeam) === normalizeTeam(fixture.awayTeam)) {
    return { eligible: false, reason: "fixture_participants_not_distinct" };
  }
  const startsAt = new Date(fixture.startsAt);
  if (!Number.isFinite(startsAt.getTime())) return { eligible: false, reason: "fixture_start_time_invalid" };
  if (startsAt.getTime() < options.nowMs + options.minLeadSeconds * 1_000) {
    return { eligible: false, reason: "fixture_inside_minimum_lead_window" };
  }
  if (startsAt.getTime() > options.nowMs + options.horizonDays * 86_400_000) {
    return { eligible: false, reason: "fixture_outside_admission_horizon" };
  }
  return { eligible: true, startsAt };
}

function participantAt(fixture: z.infer<typeof SportmonksFixtureSchema>, location: "home" | "away"): string | null {
  const participants = fixture.participants.filter((participant) => participant.meta?.location === location);
  return participants.length === 1 ? participants[0]!.name : null;
}

export function matchWitnessFixture(primary: PrimaryFixture, payload: unknown): WitnessMatch {
  const parsed = SportmonksDateEnvelopeSchema.parse(payload);
  const accessTier = sportmonksAccessTier(parsed.subscription);
  if (!accessTier) return { kind: "NONE", reason: "witness_paid_subscription_forbidden" };
  const expectedHome = normalizeTeam(primary.homeTeam);
  const expectedAway = normalizeTeam(primary.awayTeam);
  const matches: WitnessFixture[] = parsed.data.flatMap((fixture) => {
    const home = participantAt(fixture, "home");
    const away = participantAt(fixture, "away");
    if (!home || !away) return [];
    if (normalizeTeam(home) !== expectedHome || normalizeTeam(away) !== expectedAway) return [];
    if (!sameUtcDate(primary.startsAt, fixture.starting_at)) return [];
    return [{
      fixtureIdentity: fixture.id,
      homeTeam: home,
      awayTeam: away,
      startsAt: fixture.starting_at,
      accessTier,
      raw: fixture,
    }];
  }).sort((left, right) => left.fixtureIdentity.localeCompare(right.fixtureIdentity));
  if (matches.length === 0) return { kind: "NONE", reason: "qualifying_witness_fixture_not_found" };
  if (matches.length > 1) {
    return { kind: "AMBIGUOUS", reason: "multiple_qualifying_witness_fixtures", candidates: matches };
  }
  return { kind: "MATCH", witness: matches[0]! };
}

export function buildAutomaticMarketSpec(
  config: Pick<ArcConfig,
    "chainId" | "usdcAddress" | "exchangeAddress" | "oraclePrimarySignerPrivateKey" | "oracleWitnessSignerPrivateKey">,
  fixture: PrimaryFixture,
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
  const startsAt = new Date(fixture.startsAt);
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
      { index: 0, id: "home", label: `${fixture.homeTeam} win` },
      { index: 1, id: "draw", label: "Draw" },
      { index: 2, id: "away", label: `${fixture.awayTeam} win` },
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
      version: "txline.football.1x2-v1",
      adapter: "txline.sports-result.v1",
      fixtureId: fixture.fixtureId,
      sport: "football",
      settlementBasis: "REGULATION_TIME",
      primarySourceId: PRIMARY_SOURCE_ID,
      witnessSourceId: WITNESS_SOURCE_ID,
      fieldMapping: {
        fixtureId: "fixtureId",
        status: "status",
        homeScore: "homeScore",
        awayScore: "awayScore",
        action: "raw.Action",
      },
      finalStatuses: ["full_time", "final"],
      finalActions: ["game_finalised"],
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

async function fetchPrimaryFixtures(config: ArcConfig): Promise<PrimaryFixture[]> {
  const response = await fetch(`${config.txlineSourceUrl}/v1/txline/fixtures?limit=${config.fixtureAdmission.scanLimit}`, {
    headers: { accept: "application/json", "user-agent": "airarena-arc-fixture-admission/1" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`fixture_admission_primary_http_${response.status}`);
  const raw = await response.text();
  if (raw.length > 5_000_000) throw new Error("fixture_admission_primary_payload_too_large");
  const parsed = TxlineFixtureEnvelopeSchema.parse(JSON.parse(raw) as unknown);
  const fixtures = Array.isArray(parsed.data) ? parsed.data : parsed.data.data;
  const byId = new Map<string, PrimaryFixture>();
  for (const fixture of [...fixtures].sort((left, right) => {
    const id = left.fixtureId.localeCompare(right.fixtureId);
    return id || canonicalOracleJson(left).localeCompare(canonicalOracleJson(right));
  })) {
    const existing = byId.get(fixture.fixtureId);
    if (existing && hashJson(existing) !== hashJson(fixture)) throw new Error(`fixture_admission_primary_identity_conflict:${fixture.fixtureId}`);
    byId.set(fixture.fixtureId, fixture);
  }
  return [...byId.values()].sort((left, right) => {
    const time = Date.parse(left.startsAt) - Date.parse(right.startsAt);
    return time || left.fixtureId.localeCompare(right.fixtureId);
  });
}

async function fetchWitnessDate(config: ArcConfig, utcDate: string): Promise<unknown> {
  if (!config.sportmonksApiToken) throw new Error("fixture_admission_witness_token_missing");
  const url = new URL(`${config.sportmonksApiUrl}/fixtures/between/${utcDate}/${utcDate}`);
  url.searchParams.set("api_token", config.sportmonksApiToken);
  url.searchParams.set("include", "participants");
  url.searchParams.set("per_page", "50");
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "airarena-arc-fixture-admission/1" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`fixture_admission_witness_http_${response.status}`);
  const raw = await response.text();
  if (raw.length > 2_000_000) throw new Error("fixture_admission_witness_payload_too_large");
  return JSON.parse(raw) as unknown;
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
  fixture: PrimaryFixture,
  input: {
    status: "DISCOVERED" | "INELIGIBLE" | "NO_WITNESS" | "AMBIGUOUS_WITNESS" | "FAILED";
    eventType: "DISCOVERED" | "INELIGIBLE" | "WITNESS_UNAVAILABLE" | "WITNESS_AMBIGUOUS" | "ADMISSION_FAILED";
    error?: string;
    witness?: WitnessFixture;
    candidates?: WitnessFixture[];
    retrySeconds?: number;
  },
): Promise<void> {
  const candidateHash = hashJson(fixture);
  const witnessHash = input.witness ? hashJson(input.witness.raw) : null;
  const payload = {
    status: input.status,
    reason: input.error ?? null,
    candidateHash,
    witnessCandidates: input.candidates?.map((candidate) => ({
      fixtureIdentity: candidate.fixtureIdentity,
      candidateHash: hashJson(candidate.raw),
    })) ?? [],
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
        fixture.fixtureId, input.status, candidateHash, JSON.stringify(fixture),
        input.witness?.fixtureIdentity ?? null, witnessHash,
        input.witness ? JSON.stringify(input.witness.raw) : null,
        input.error?.slice(0, 1000) ?? null, input.retrySeconds ?? null,
      ],
    );
    const eventInput: Parameters<typeof appendAdmissionEvent>[1] = {
      fixtureId: fixture.fixtureId,
      eventType: input.eventType,
      candidateHash,
      payload,
    };
    if (input.witness) eventInput.witnessFixtureIdentity = input.witness.fixtureIdentity;
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
  const result = await db.query<{ status: string; due: boolean }>(
    `SELECT status, (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp()) AS due
       FROM arc_fixture_admission_state WHERE primary_fixture_identity = $1`,
    [fixtureId],
  );
  const row = result.rows[0];
  return !row || (row.status !== "ADMITTED" && row.due);
}

async function admitMarket(
  config: ArcConfig,
  db: Database,
  fixture: PrimaryFixture,
  witness: WitnessFixture,
): Promise<{ marketId: Hex; jobId: string; created: boolean }> {
  const binding: WitnessBinding = {
    adapterId: ORACLE_ADAPTERS.SPORTMONKS_V1,
    fixtureIdentity: witness.fixtureIdentity,
    accessTier: witness.accessTier,
    authenticated: true,
  };
  const qualification = await verifyQualifyingWitness(binding, config);
  const spec = buildAutomaticMarketSpec(config, fixture);
  const externalIdHash = keccak256(stringToHex(`txline:${fixture.fixtureId}`));
  const sourceEventId = keccak256(stringToHex(`fixture:${fixture.fixtureId}`));
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
  const candidateHash = hashJson(fixture);
  const witnessCandidateHash = hashJson(witness.raw);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('airarena_arc_market_creation'))");
    const existing = await client.query<{ market_id: Hex; fixture_id: string; spec_hash: Hex | null }>(
      "SELECT market_id, fixture_id, spec_hash FROM arc_markets WHERE fixture_id = $1 OR market_id = $2 FOR UPDATE",
      [fixture.fixtureId, spec.marketId],
    );
    const existingMarket = existing.rows[0];
    if (existingMarket) {
      if (existingMarket.market_id.toLowerCase() !== spec.marketId.toLowerCase()
          || existingMarket.fixture_id !== fixture.fixtureId
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
           $1,$2,$3,3,$4,'QUEUED','TXLINE_1X2_REGULATION',
           'SPORTS','TXLINE',$2,$5,$6::jsonb,'Regulation-time 1X2 result',
           $7,$8::jsonb,$9,$2,$10,$11,$12,clock_timestamp(),$13,$14,$15::jsonb,'AUTOMATIC_FIXTURE_WORKER'
         )`,
        [
          spec.marketId, fixture.fixtureId, externalIdHash, closeTime,
          `${fixture.homeTeam} vs ${fixture.awayTeam}`,
          JSON.stringify([fixture.homeTeam, "Draw", fixture.awayTeam]),
          spec.specHash, JSON.stringify(resolutionRule), ORACLE_ADAPTERS.TXLINE_V1,
          ORACLE_ADAPTERS.SPORTMONKS_V1, witness.fixtureIdentity, witness.accessTier,
          qualification.rawPayloadHash, qualification.observedAt, canonicalizeArcJson(spec),
        ],
      );
    }
    const job = await enqueueJob(client, "CREATE_MARKET", {
      marketId: spec.marketId as Hex,
      specHash: spec.specHash,
      externalIdHash,
      fixtureId: fixture.fixtureId,
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
      [fixture.fixtureId, candidateHash, JSON.stringify(fixture), witness.fixtureIdentity,
        witnessCandidateHash, JSON.stringify(witness.raw), spec.marketId],
    );
    await appendAdmissionEvent(client, {
      fixtureId: fixture.fixtureId,
      eventType: "MARKET_ADMITTED",
      candidateHash,
      marketId: spec.marketId as Hex,
      witnessFixtureIdentity: witness.fixtureIdentity,
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
  const fixtures = await fetchPrimaryFixtures(config);
  const result: AdmissionCycleResult = { scanned: fixtures.length, eligible: 0, admitted: 0, skipped: 0, failed: 0 };
  const witnessByDate = new Map<string, Promise<unknown>>();
  for (const fixture of fixtures) {
    if (state.stopping || result.admitted >= config.fixtureAdmission.maxPerRun) break;
    const eligibility = primaryFixtureEligibility(fixture, {
      nowMs: Date.now(),
      horizonDays: config.fixtureAdmission.horizonDays,
      minLeadSeconds: config.fixtureAdmission.minLeadSeconds,
    });
    if (!eligibility.eligible) continue;
    result.eligible += 1;
    if (!(await shouldAttempt(db, fixture.fixtureId))) {
      result.skipped += 1;
      continue;
    }
    try {
      const utcDate = eligibility.startsAt.toISOString().slice(0, 10);
      let witnessRequest = witnessByDate.get(utcDate);
      if (!witnessRequest) {
        witnessRequest = fetchWitnessDate(config, utcDate);
        witnessByDate.set(utcDate, witnessRequest);
      }
      const witnessMatch = matchWitnessFixture(fixture, await witnessRequest);
      if (witnessMatch.kind === "NONE") {
        await recordAdmissionDecision(db, fixture, {
          status: "NO_WITNESS",
          eventType: "WITNESS_UNAVAILABLE",
          error: witnessMatch.reason,
          retrySeconds: config.fixtureAdmission.retrySeconds,
        });
        result.skipped += 1;
        continue;
      }
      if (witnessMatch.kind === "AMBIGUOUS") {
        await recordAdmissionDecision(db, fixture, {
          status: "AMBIGUOUS_WITNESS",
          eventType: "WITNESS_AMBIGUOUS",
          error: witnessMatch.reason,
          candidates: witnessMatch.candidates,
          retrySeconds: config.fixtureAdmission.retrySeconds,
        });
        result.skipped += 1;
        continue;
      }
      const admitted = await admitMarket(config, db, fixture, witnessMatch.witness);
      result.admitted += 1;
      logger.info({
        fixtureId: fixture.fixtureId,
        witnessFixtureId: witnessMatch.witness.fixtureIdentity,
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
      logger.warn({ err: error, fixtureId: fixture.fixtureId }, "arc_fixture_admission_failed_closed");
    }
  }
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
      await delay(config.fixtureAdmission.intervalMs);
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
