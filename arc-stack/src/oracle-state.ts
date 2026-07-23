import { getAddress, hashTypedData, keccak256, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ArcConfig } from "./config.js";
import type { Database, DatabaseClient } from "./db.js";
import { activateHalt, recoverHalt } from "./risk-controls.js";
import {
  ORACLE_ADAPTERS,
  adapterRegistration,
  type OracleAdapterId,
  verifySportmonksFixture,
  type NormalizedOracleReport,
} from "./oracle-adapter.js";

export type OracleHealthState = "HEALTHY" | "STALE" | "DIVERGENT" | "UNAVAILABLE" | "MALFORMED";

export type OracleQuorum = {
  state: OracleHealthState;
  primary: NormalizedOracleReport | null;
  witness: NormalizedOracleReport | null;
  outcome: 0 | 1 | 2 | null;
  detail: string;
};

export type WitnessBinding = {
  adapterId: typeof ORACLE_ADAPTERS.SPORTMONKS_V1 | typeof ORACLE_ADAPTERS.OFFICIAL_COMPETITION_V1;
  fixtureIdentity: string;
  accessTier: "FREE" | "TRIAL";
  authenticated: true;
};

export function assertQualifyingWitness(binding: WitnessBinding, config: Pick<ArcConfig, "sportmonksApiToken">): void {
  const registration = adapterRegistration(binding.adapterId);
  if (!registration.enabled || registration.role !== "WITNESS" || registration.paid) {
    throw new Error("oracle_witness_not_qualified");
  }
  if (!binding.authenticated || !binding.fixtureIdentity.trim()) throw new Error("oracle_witness_not_qualified");
  if (binding.adapterId === ORACLE_ADAPTERS.SPORTMONKS_V1 && !config.sportmonksApiToken) {
    throw new Error("oracle_witness_credential_unavailable");
  }
}

export async function verifyQualifyingWitness(
  binding: WitnessBinding,
  config: Pick<ArcConfig, "sportmonksApiToken" | "sportmonksApiUrl">,
): Promise<{ rawPayloadHash: Hex; observedAt: string }> {
  assertQualifyingWitness(binding, config);
  if (binding.adapterId !== ORACLE_ADAPTERS.SPORTMONKS_V1 || !config.sportmonksApiToken) {
    throw new Error("oracle_witness_not_qualified");
  }
  return verifySportmonksFixture(
    config.sportmonksApiUrl,
    config.sportmonksApiToken,
    binding.fixtureIdentity,
    binding.accessTier,
  );
}

export function evaluateOracleQuorum(
  primary: NormalizedOracleReport | null,
  witness: NormalizedOracleReport | null,
  options: { nowMs: number; maxAgeSeconds: number; maxSkewSeconds: number },
): OracleQuorum {
  if (!primary || !witness) {
    return { state: "UNAVAILABLE", primary, witness, outcome: null, detail: "primary_or_witness_missing" };
  }
  if (primary.adapterId === witness.adapterId) {
    return { state: "MALFORMED", primary, witness, outcome: null, detail: "sources_not_independent" };
  }
  if (primary.normalizedOutcome === null || witness.normalizedOutcome === null) {
    return { state: "MALFORMED", primary, witness, outcome: null, detail: "outcome_missing" };
  }
  const primaryMs = Date.parse(primary.timestamp);
  const witnessMs = Date.parse(witness.timestamp);
  if (!Number.isFinite(primaryMs) || !Number.isFinite(witnessMs)) {
    return { state: "MALFORMED", primary, witness, outcome: null, detail: "invalid_timestamp" };
  }
  const maxAgeMs = options.maxAgeSeconds * 1_000;
  if (primaryMs > options.nowMs || witnessMs > options.nowMs
      || options.nowMs - primaryMs > maxAgeMs || options.nowMs - witnessMs > maxAgeMs) {
    return { state: "STALE", primary, witness, outcome: null, detail: "source_stale_or_future" };
  }
  if (Math.abs(primaryMs - witnessMs) > options.maxSkewSeconds * 1_000) {
    return { state: "STALE", primary, witness, outcome: null, detail: "source_timestamp_skew" };
  }
  if (!primary.finalResult || !witness.finalResult) {
    return { state: "UNAVAILABLE", primary, witness, outcome: null, detail: "final_result_unavailable" };
  }
  if (primary.normalizedOutcome !== witness.normalizedOutcome) {
    return { state: "DIVERGENT", primary, witness, outcome: null, detail: "normalized_outcomes_disagree" };
  }
  return { state: "HEALTHY", primary, witness, outcome: primary.normalizedOutcome, detail: "quorum_agrees" };
}

export function evaluateOracleLiveHealth(
  primary: NormalizedOracleReport | null,
  witness: NormalizedOracleReport | null,
  options: { nowMs: number; maxAgeSeconds: number; maxSkewSeconds: number },
): OracleQuorum {
  if (!primary || !witness) {
    return { state: "UNAVAILABLE", primary, witness, outcome: null, detail: "primary_or_witness_missing" };
  }
  const result = evaluateOracleQuorum(
    { ...primary, finalResult: true },
    { ...witness, finalResult: true },
    options,
  );
  return result.state === "HEALTHY" ? { ...result, detail: "live_sources_agree" } : result;
}

export async function readSelectedOracleReport(
  db: Database | DatabaseClient,
  adapterId: OracleAdapterId,
  fixtureIdentity: string,
): Promise<{ report: NormalizedOracleReport | null; conflicted: boolean }> {
  const result = await db.query<{
    report_hash: Hex;
    sequence: string;
    source_timestamp: Date;
    observed_at: Date;
    raw_response: string;
    raw_payload_hash: Hex;
    proof: Record<string, unknown>;
    final_result: boolean;
    normalized_outcome: 0 | 1 | 2 | null;
    home_score: number | null;
    away_score: number | null;
    correction_rank: number;
    conflicted: boolean;
  }>(
    `SELECT r.report_hash, r.sequence::text, r.source_timestamp, r.observed_at,
            r.raw_response, r.raw_payload_hash, r.proof, r.final_result,
            r.normalized_outcome, r.home_score, r.away_score, r.correction_rank, s.conflicted
       FROM arc_oracle_fixture_state s
       JOIN arc_oracle_reports r ON r.report_hash = s.selected_report_hash
      WHERE s.adapter_id = $1 AND s.fixture_identity = $2`,
    [adapterId, fixtureIdentity],
  );
  const row = result.rows[0];
  if (!row) return { report: null, conflicted: false };
  return {
    conflicted: row.conflicted,
    report: {
      adapterId,
      fixtureIdentity,
      sequence: BigInt(row.sequence),
      timestamp: row.source_timestamp.toISOString(),
      observedAt: row.observed_at.toISOString(),
      rawResponse: row.raw_response,
      rawPayloadHash: row.raw_payload_hash,
      proof: row.proof,
      finalResult: row.final_result,
      normalizedOutcome: row.normalized_outcome,
      homeScore: row.home_score,
      awayScore: row.away_score,
      correctionRank: row.correction_rank,
      reportHash: row.report_hash,
    },
  };
}

export async function storeOracleReport(
  db: Database | DatabaseClient,
  report: NormalizedOracleReport,
  marketId: string | null,
): Promise<{ inserted: boolean; selectedReportHash: Hex; conflicted: boolean }> {
  const inserted = await db.query(
    `INSERT INTO arc_oracle_reports(
       report_hash, market_id, adapter_id, fixture_identity, sequence, source_timestamp,
       observed_at, raw_response, raw_payload_hash, proof, final_result, normalized_outcome,
       home_score, away_score, correction_rank
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15)
     ON CONFLICT (report_hash) DO NOTHING`,
    [
      report.reportHash,
      marketId,
      report.adapterId,
      report.fixtureIdentity,
      report.sequence.toString(),
      report.timestamp,
      report.observedAt,
      report.rawResponse,
      report.rawPayloadHash,
      JSON.stringify(report.proof),
      report.finalResult,
      report.normalizedOutcome,
      report.homeScore,
      report.awayScore,
      report.correctionRank,
    ],
  );
  const selected = await db.query<{ report_hash: Hex; sequence: string; correction_rank: number; source_timestamp: Date }>(
    `SELECT report_hash, sequence::text, correction_rank, source_timestamp
       FROM arc_oracle_reports
      WHERE adapter_id = $1 AND fixture_identity = $2
      ORDER BY sequence DESC, correction_rank DESC, source_timestamp DESC, report_hash ASC
      LIMIT 1`,
    [report.adapterId, report.fixtureIdentity],
  );
  const row = selected.rows[0];
  if (!row) throw new Error("oracle_report_selection_failed");
  const conflicts = await db.query<{ conflicting: boolean }>(
    `SELECT count(DISTINCT report_hash) > 1 AS conflicting
       FROM arc_oracle_reports
      WHERE adapter_id = $1 AND fixture_identity = $2
        AND sequence = $3 AND correction_rank = $4`,
    [report.adapterId, report.fixtureIdentity, row.sequence, row.correction_rank],
  );
  const conflicted = conflicts.rows[0]?.conflicting === true;
  await db.query(
    `INSERT INTO arc_oracle_fixture_state(
       adapter_id, fixture_identity, selected_report_hash, selected_sequence,
       selected_correction_rank, selected_timestamp, conflicted, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp())
     ON CONFLICT (adapter_id, fixture_identity) DO UPDATE SET
       selected_report_hash = EXCLUDED.selected_report_hash,
       selected_sequence = EXCLUDED.selected_sequence,
       selected_correction_rank = EXCLUDED.selected_correction_rank,
       selected_timestamp = EXCLUDED.selected_timestamp,
       conflicted = EXCLUDED.conflicted,
       updated_at = clock_timestamp()`,
    [report.adapterId, report.fixtureIdentity, row.report_hash, row.sequence, row.correction_rank, row.source_timestamp, conflicted],
  );
  return { inserted: (inserted.rowCount ?? 0) === 1, selectedReportHash: row.report_hash, conflicted };
}

export async function updateMarketOracleHealth(
  db: Database | DatabaseClient,
  marketId: string,
  quorum: OracleQuorum,
  recoveryThreshold: number,
): Promise<{ healthy: boolean; consecutiveHealthy: number }> {
  const result = await db.query<{ consecutive_healthy: number }>(
    `INSERT INTO arc_market_oracle_health(
       market_id, state, primary_report_hash, witness_report_hash, consecutive_healthy, detail, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp())
     ON CONFLICT (market_id) DO UPDATE SET
       state = EXCLUDED.state,
       primary_report_hash = EXCLUDED.primary_report_hash,
       witness_report_hash = EXCLUDED.witness_report_hash,
       consecutive_healthy = CASE
         -- The single elected watcher records one independent authenticated
         -- poll per cycle. A stable final report is expected to retain the
         -- same hashes, so agreement must advance on consecutive successful
         -- polls rather than only on source mutations.
         WHEN EXCLUDED.state = 'HEALTHY' THEN arc_market_oracle_health.consecutive_healthy + 1
         ELSE 0
       END,
       detail = EXCLUDED.detail,
       updated_at = clock_timestamp()
     RETURNING consecutive_healthy`,
    [
      marketId,
      quorum.state,
      quorum.primary?.reportHash ?? null,
      quorum.witness?.reportHash ?? null,
      quorum.state === "HEALTHY" ? 1 : 0,
      quorum.detail,
    ],
  );
  const consecutiveHealthy = result.rows[0]?.consecutive_healthy ?? 0;
  const haltKey = `oracle:${marketId}`;
  if (quorum.state !== "HEALTHY") {
    await activateHalt(db, { haltKey, reason: "ORACLE_INTEGRITY", marketId, detail: quorum.detail });
  } else if (consecutiveHealthy >= recoveryThreshold) {
    await recoverHalt(db, haltKey);
  }
  return { healthy: quorum.state === "HEALTHY" && consecutiveHealthy >= recoveryThreshold, consecutiveHealthy };
}

export async function recordResolutionDecision(
  db: Database | DatabaseClient,
  input: {
    marketId: string;
    primaryReportHash: Hex | null;
    witnessReportHash: Hex | null;
    decision: "PENDING" | "QUORUM" | "INVALIDATE";
    reason: string;
    normalizedOutcome: 0 | 1 | 2 | null;
  },
): Promise<Hex> {
  const decisionHash = keccak256(stringToHex(JSON.stringify({
    marketId: input.marketId,
    primaryReportHash: input.primaryReportHash,
    witnessReportHash: input.witnessReportHash,
    decision: input.decision,
    reason: input.reason,
    normalizedOutcome: input.normalizedOutcome,
  })));
  await db.query(
    `INSERT INTO arc_resolution_decisions(
       decision_hash, market_id, primary_report_hash, witness_report_hash,
       decision, reason, normalized_outcome
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (decision_hash) DO NOTHING`,
    [
      decisionHash,
      input.marketId,
      input.primaryReportHash,
      input.witnessReportHash,
      input.decision,
      input.reason,
      input.normalizedOutcome,
    ],
  );
  return decisionHash;
}

export const resolutionReportTypes = {
  ResolutionReport: [
    { name: "marketId", type: "bytes32" },
    { name: "specHash", type: "bytes32" },
    { name: "sourceId", type: "bytes32" },
    { name: "sourceEventId", type: "bytes32" },
    { name: "observedAt", type: "uint64" },
    { name: "publishedAt", type: "uint64" },
    { name: "finalResult", type: "bool" },
    { name: "normalizedOutcome", type: "uint8" },
    { name: "rawPayloadHash", type: "bytes32" },
  ],
} as const;

export type SignedResolutionReport = {
  sourceId: Hex;
  sourceEventId: Hex;
  observedAt: bigint;
  publishedAt: bigint;
  finalResult: boolean;
  normalizedOutcome: 0 | 1 | 2;
  rawPayloadHash: Hex;
  signatureEvidence: Hex;
};

export async function signOracleReport(input: {
  privateKey: Hex;
  chainId: number;
  exchangeAddress: Address;
  marketId: Hex;
  specHash: Hex;
  sourceId: Hex;
  sourceEventId: Hex;
  report: NormalizedOracleReport;
}): Promise<SignedResolutionReport> {
  if (input.report.normalizedOutcome === null) throw new Error("oracle_report_outcome_missing");
  const account = privateKeyToAccount(input.privateKey);
  const message = {
    marketId: input.marketId,
    specHash: input.specHash,
    sourceId: input.sourceId,
    sourceEventId: input.sourceEventId,
    observedAt: BigInt(Math.floor(Date.parse(input.report.observedAt) / 1_000)),
    publishedAt: BigInt(Math.floor(Date.parse(input.report.timestamp) / 1_000)),
    finalResult: input.report.finalResult,
    normalizedOutcome: input.report.normalizedOutcome,
    rawPayloadHash: input.report.rawPayloadHash,
  } as const;
  const signatureEvidence = await account.signTypedData({
    domain: { name: "AIR Arena Arc", version: "1", chainId: input.chainId, verifyingContract: getAddress(input.exchangeAddress) },
    types: resolutionReportTypes,
    primaryType: "ResolutionReport",
    message,
  });
  const digest = hashTypedData({
    domain: { name: "AIR Arena Arc", version: "1", chainId: input.chainId, verifyingContract: getAddress(input.exchangeAddress) },
    types: resolutionReportTypes,
    primaryType: "ResolutionReport",
    message,
  });
  if (!digest) throw new Error("oracle_report_digest_failed");
  return { ...message, signatureEvidence };
}
