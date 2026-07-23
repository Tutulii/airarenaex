import { TextDecoder } from "node:util";
import { isHex, keccak256, stringToHex, type Hex } from "viem";
import { z } from "zod";

export const ORACLE_ADAPTERS = {
  TXLINE_V1: "txline.sports-result.v1",
  SPORTMONKS_V1: "sportmonks.football.v3",
  OFFICIAL_COMPETITION_V1: "official.competition.v1",
  PYTH_V1: "pyth.price.v1",
  ELECTION_V1: "election.result.v1",
} as const;

export type OracleAdapterId = (typeof ORACLE_ADAPTERS)[keyof typeof ORACLE_ADAPTERS];
export type OracleAdapterRegistration = {
  id: OracleAdapterId;
  enabled: boolean;
  category: "SPORTS" | "CRYPTO" | "POLITICS";
  role: "PRIMARY" | "WITNESS" | "RESERVED";
  paid: boolean;
};

export const ORACLE_ADAPTER_REGISTRY: readonly OracleAdapterRegistration[] = [
  { id: ORACLE_ADAPTERS.TXLINE_V1, enabled: true, category: "SPORTS", role: "PRIMARY", paid: false },
  { id: ORACLE_ADAPTERS.SPORTMONKS_V1, enabled: true, category: "SPORTS", role: "WITNESS", paid: false },
  { id: ORACLE_ADAPTERS.OFFICIAL_COMPETITION_V1, enabled: false, category: "SPORTS", role: "WITNESS", paid: false },
  { id: ORACLE_ADAPTERS.PYTH_V1, enabled: false, category: "CRYPTO", role: "RESERVED", paid: false },
  { id: ORACLE_ADAPTERS.ELECTION_V1, enabled: false, category: "POLITICS", role: "RESERVED", paid: false },
] as const;

export type NormalizedOracleReport = {
  adapterId: OracleAdapterId;
  fixtureIdentity: string;
  sequence: bigint;
  timestamp: string;
  observedAt: string;
  rawResponse: string;
  rawPayloadHash: Hex;
  proof: Record<string, unknown>;
  finalResult: boolean;
  normalizedOutcome: 0 | 1 | 2 | null;
  homeScore: number | null;
  awayScore: number | null;
  correctionRank: number;
  reportHash: Hex;
};

const TxlineEnvelope = z.object({
  success: z.literal(true),
  data: z.object({
    fixtureId: z.union([z.string().min(1), z.number().int().nonnegative()]),
    status: z.string().min(1),
    homeScore: z.number().int().nonnegative(),
    awayScore: z.number().int().nonnegative(),
    winner: z.enum(["part1", "draw", "part2"]),
    sourceUpdateId: z.string().min(1).nullish(),
    sourceTimestamp: z.string().datetime({ offset: true }),
    sequence: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).nullish(),
    correction: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).nullish(),
    proof: z.record(z.string(), z.unknown()).nullish(),
    source: z.string().min(1).optional(),
    settlementRule: z.record(z.string(), z.unknown()).nullish(),
  }).passthrough(),
}).passthrough();

const SportmonksEnvelope = z.object({
  data: z.object({
    id: z.union([z.string().min(1), z.number().int().nonnegative()]),
    state: z.object({
      short_name: z.string().optional(),
      short_state: z.string().optional(),
      state: z.string().optional(),
      name: z.string().optional(),
    }).passthrough(),
    scores: z.array(z.object({
      description: z.string().optional(),
      participant_id: z.union([z.string(), z.number()]).optional(),
      score: z.object({
        participant: z.enum(["home", "away"]).optional(),
        goals: z.number().int().nonnegative().optional(),
      }).passthrough(),
    }).passthrough()).default([]),
    participants: z.array(z.object({
      id: z.union([z.string(), z.number()]),
      meta: z.object({ location: z.enum(["home", "away"]).optional() }).passthrough().optional(),
    }).passthrough()).default([]),
    starting_at: z.string().optional(),
  }).passthrough(),
  subscription: z.array(z.object({ type: z.string().optional() }).passthrough()).optional(),
  rate_limit: z.object({ resets_in_seconds: z.number().optional() }).passthrough().optional(),
}).passthrough();

const SportmonksQualificationEnvelope = z.object({
  data: z.object({
    id: z.union([z.string().min(1), z.number().int().nonnegative()]),
  }).passthrough(),
  subscription: z.array(z.unknown()).min(1),
}).passthrough();

const FINAL_TOKENS = new Set(["ft", "final", "finished", "ended", "completed", "after_penalties"]);

export function canonicalOracleJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalOracleJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalOracleJson(record[key])}`).join(",")}}`;
}

function sourceSequence(value: string | number | null | undefined, fallback: string): bigint {
  if (value !== undefined && value !== null) return BigInt(value);
  const numeric = fallback.match(/\d+/g)?.join("");
  return numeric ? BigInt(numeric.slice(0, 30)) : 0n;
}

function outcome(homeScore: number, awayScore: number): 0 | 1 | 2 {
  return homeScore > awayScore ? 0 : homeScore === awayScore ? 1 : 2;
}

export function sportmonksAccessTier(subscription: readonly unknown[]): "FREE" | "TRIAL" | null {
  const descriptor = canonicalOracleJson(subscription).toLowerCase();
  if (descriptor.includes("trial")) return "TRIAL";
  if (descriptor.includes("free")) return "FREE";
  return null;
}

function buildReport(input: Omit<NormalizedOracleReport, "rawPayloadHash" | "reportHash">): NormalizedOracleReport {
  const rawPayloadHash = keccak256(stringToHex(input.rawResponse));
  const reportHash = keccak256(stringToHex(canonicalOracleJson({
    adapterId: input.adapterId,
    fixtureIdentity: input.fixtureIdentity,
    sequence: input.sequence.toString(),
    timestamp: input.timestamp,
    rawPayloadHash,
    proof: input.proof,
    finalResult: input.finalResult,
    normalizedOutcome: input.normalizedOutcome,
    homeScore: input.homeScore,
    awayScore: input.awayScore,
    correctionRank: input.correctionRank,
  })));
  return { ...input, rawPayloadHash, reportHash };
}

export function parseTxlineOracleReport(payload: unknown, rawResponse = canonicalOracleJson(payload), observedAt = new Date().toISOString()): NormalizedOracleReport {
  const parsed = TxlineEnvelope.parse(payload).data;
  const fixtureIdentity = String(parsed.fixtureId);
  const winner = parsed.homeScore > parsed.awayScore ? "part1" : parsed.homeScore === parsed.awayScore ? "draw" : "part2";
  if (winner !== parsed.winner) throw new Error("oracle_txline_score_winner_mismatch");
  const status = parsed.status.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const sourceUpdateId = parsed.sourceUpdateId ?? "0";
  return buildReport({
    adapterId: ORACLE_ADAPTERS.TXLINE_V1,
    fixtureIdentity,
    sequence: sourceSequence(parsed.sequence, sourceUpdateId),
    timestamp: parsed.sourceTimestamp,
    observedAt,
    rawResponse,
    proof: {
      kind: "TXLINE_AUTHENTICATED_HTTPS",
      source: parsed.source ?? null,
      sourceUpdateId,
      settlementRule: parsed.settlementRule ?? null,
      txlineProof: parsed.proof ?? null,
    },
    finalResult: FINAL_TOKENS.has(status),
    normalizedOutcome: outcome(parsed.homeScore, parsed.awayScore),
    homeScore: parsed.homeScore,
    awayScore: parsed.awayScore,
    correctionRank: Number(parsed.correction ?? 0),
  });
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nested(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => record(current)[key], value);
}

function firstText(value: unknown, paths: readonly string[]): string | null {
  for (const path of paths) {
    const candidate = nested(value, path);
    if ((typeof candidate === "string" || typeof candidate === "number") && String(candidate).trim()) {
      return String(candidate).trim();
    }
  }
  return null;
}

function firstInteger(value: unknown, paths: readonly string[]): number | null {
  for (const path of paths) {
    const candidate = nested(value, path);
    const parsed = typeof candidate === "number" ? candidate
      : typeof candidate === "string" && candidate.trim() ? Number(candidate) : Number.NaN;
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function txlineScoreRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  for (const path of ["scores", "data.scores", "items", "updates", "data"] as const) {
    const candidate = nested(payload, path);
    if (Array.isArray(candidate)) return candidate;
  }
  return [payload];
}

function parseTxlineScoreSseRow(
  payload: unknown,
  rawResponse: string,
  observedAt = new Date().toISOString(),
  eventId: string | null = null,
): NormalizedOracleReport {
  const fixtureIdentity = firstText(payload, [
    "FixtureId", "fixtureId", "fixture_id", "id.fixture", "matchId", "MatchId",
    "Data.New.FixtureId", "Data.FixtureId",
  ]);
  if (!fixtureIdentity) throw new Error("oracle_txline_sse_fixture_missing");
  const homeScore = firstInteger(payload, [
    "homeScore", "home_score", "score.home", "home.score", "Score.Participant1.Total.Goals",
    "Score.Home", "Score.home", "Data.New.Score.Participant1.Total.Goals",
    "Data.Score.Participant1.Total.Goals", "Data.New.homeScore", "Data.homeScore",
  ]);
  const awayScore = firstInteger(payload, [
    "awayScore", "away_score", "score.away", "away.score", "Score.Participant2.Total.Goals",
    "Score.Away", "Score.away", "Data.New.Score.Participant2.Total.Goals",
    "Data.Score.Participant2.Total.Goals", "Data.New.awayScore", "Data.awayScore",
  ]);
  if (homeScore === null || awayScore === null) throw new Error("oracle_txline_sse_score_missing");
  const sourceTimestamp = firstText(payload, ["Ts", "timestamp", "updatedAt", "sourceTimestamp", "time"])
    ?? observedAt;
  if (!Number.isFinite(Date.parse(sourceTimestamp))) throw new Error("oracle_txline_sse_timestamp_invalid");
  const status = (firstText(payload, [
    "status", "Status", "state", "normalizedScoreState.status", "Data.New.Status", "Data.Status",
  ]) ?? "live").toLowerCase().replace(/[\s-]+/g, "_");
  const sourceUpdateId = firstText(payload, ["UpdateId", "updateId", "sourceUpdateId", "id", "Id"])
    ?? eventId ?? `${fixtureIdentity}:${sourceTimestamp}`;
  return buildReport({
    adapterId: ORACLE_ADAPTERS.TXLINE_V1,
    fixtureIdentity,
    sequence: sourceSequence(undefined, sourceUpdateId),
    timestamp: sourceTimestamp,
    observedAt,
    rawResponse,
    proof: {
      kind: "TXLINE_AUTHENTICATED_SSE",
      source: "txline",
      sourceEndpoint: "/api/scores/stream",
      sourceUpdateId,
      eventId,
    },
    finalResult: FINAL_TOKENS.has(status),
    normalizedOutcome: outcome(homeScore, awayScore),
    homeScore,
    awayScore,
    correctionRank: 0,
  });
}

/** Normalize all reports carried by one authenticated TxLINE score SSE event. */
export function parseTxlineScoreSseReports(
  payload: unknown,
  rawResponse = canonicalOracleJson(payload),
  observedAt = new Date().toISOString(),
  eventId: string | null = null,
): NormalizedOracleReport[] {
  return txlineScoreRows(payload).map((row) => parseTxlineScoreSseRow(row, rawResponse, observedAt, eventId));
}

export function parseTxlineScoreSseReport(
  payload: unknown,
  rawResponse = canonicalOracleJson(payload),
  observedAt = new Date().toISOString(),
  eventId: string | null = null,
): NormalizedOracleReport {
  const reports = parseTxlineScoreSseReports(payload, rawResponse, observedAt, eventId);
  if (reports.length !== 1) throw new Error("oracle_txline_sse_multiple_reports");
  return reports[0]!;
}

function sportmonksScore(data: z.infer<typeof SportmonksEnvelope>["data"], location: "home" | "away"): number {
  const direct = data.scores.filter((entry) => entry.score.participant === location && entry.score.goals !== undefined);
  const preferred = direct.find((entry) => entry.description?.toUpperCase() === "CURRENT") ?? direct.at(-1);
  if (preferred?.score.goals !== undefined) return preferred.score.goals;
  const participant = data.participants.find((entry) => entry.meta?.location === location);
  const byId = data.scores.filter((entry) => participant && String(entry.participant_id) === String(participant.id));
  const matched = byId.find((entry) => entry.description?.toUpperCase() === "CURRENT") ?? byId.at(-1);
  if (matched?.score.goals === undefined) throw new Error(`oracle_sportmonks_${location}_score_missing`);
  return matched.score.goals;
}

export function parseSportmonksOracleReport(payload: unknown, rawResponse = canonicalOracleJson(payload), observedAt = new Date().toISOString()): NormalizedOracleReport {
  const parsed = SportmonksEnvelope.parse(payload);
  const accessTier = sportmonksAccessTier(parsed.subscription ?? []);
  if (!accessTier) throw new Error("oracle_witness_paid_subscription_forbidden");
  const data = parsed.data;
  const homeScore = sportmonksScore(data, "home");
  const awayScore = sportmonksScore(data, "away");
  const state = (data.state.short_name ?? data.state.short_state ?? data.state.state ?? data.state.name ?? "")
    .trim().toLowerCase().replace(/[\s-]+/g, "_");
  // Sportmonks does not expose a per-fixture update timestamp consistently. The
  // authenticated HTTPS observation time is therefore the publication time;
  // `starting_at` remains preserved byte-for-byte in rawResponse.
  const timestamp = observedAt;
  const sequence = BigInt(Math.floor(Date.parse(observedAt) / 1_000));
  return buildReport({
    adapterId: ORACLE_ADAPTERS.SPORTMONKS_V1,
    fixtureIdentity: String(data.id),
    sequence,
    timestamp,
    observedAt,
    rawResponse,
    proof: {
      kind: "SPORTMONKS_AUTHENTICATED_HTTPS",
      accessTier,
      subscription: parsed.subscription ?? [],
      rateLimit: parsed.rate_limit ?? null,
    },
    finalResult: FINAL_TOKENS.has(state),
    normalizedOutcome: outcome(homeScore, awayScore),
    homeScore,
    awayScore,
    correctionRank: 0,
  });
}

export function compareOracleReports(left: NormalizedOracleReport, right: NormalizedOracleReport): number {
  if (left.sequence !== right.sequence) return left.sequence < right.sequence ? -1 : 1;
  if (left.correctionRank !== right.correctionRank) return left.correctionRank - right.correctionRank;
  const time = Date.parse(left.timestamp) - Date.parse(right.timestamp);
  if (time !== 0) return time;
  return right.reportHash.localeCompare(left.reportHash);
}

export function reduceOracleReports(reports: readonly NormalizedOracleReport[]): NormalizedOracleReport | null {
  return reports.reduce<NormalizedOracleReport | null>((selected, candidate) => {
    if (!selected) return candidate;
    if (selected.adapterId !== candidate.adapterId || selected.fixtureIdentity !== candidate.fixtureIdentity) {
      throw new Error("oracle_reducer_mixed_identity");
    }
    return compareOracleReports(selected, candidate) < 0 ? candidate : selected;
  }, null);
}

export function validateOracleReport(
  report: NormalizedOracleReport,
  input: { adapterId: OracleAdapterId; fixtureIdentity: string; requireFinal: boolean },
): void {
  if (report.adapterId !== input.adapterId) throw new Error("oracle_adapter_identity_mismatch");
  if (report.fixtureIdentity !== input.fixtureIdentity) throw new Error("oracle_fixture_identity_mismatch");
  if (report.sequence < 0n || report.correctionRank < 0) throw new Error("oracle_sequence_invalid");
  if (!Number.isFinite(Date.parse(report.timestamp)) || !Number.isFinite(Date.parse(report.observedAt))) {
    throw new Error("oracle_timestamp_invalid");
  }
  if (keccak256(stringToHex(report.rawResponse)) !== report.rawPayloadHash) {
    throw new Error("oracle_raw_payload_hash_mismatch");
  }
  if (!report.proof || typeof report.proof.kind !== "string") throw new Error("oracle_proof_shape_invalid");
  if (input.requireFinal && (!report.finalResult || report.normalizedOutcome === null)) {
    throw new Error("oracle_final_result_required");
  }
}

export function adapterRegistration(id: string): OracleAdapterRegistration {
  const adapter = ORACLE_ADAPTER_REGISTRY.find((entry) => entry.id === id);
  if (!adapter) throw new Error("oracle_adapter_not_found");
  return adapter;
}

export async function fetchTxlineOracleReport(baseUrl: string, fixtureId: string, timeoutMs = 10_000): Promise<NormalizedOracleReport | null> {
  const response = await fetch(`${baseUrl}/v1/txline/outcomes/${encodeURIComponent(fixtureId)}`, {
    headers: { accept: "application/json", "user-agent": "airarena-arc-oracle-adapter/1" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`oracle_txline_http_${response.status}`);
  const raw = await response.text();
  if (raw.length > 1_000_000) throw new Error("oracle_txline_payload_too_large");
  const report = parseTxlineOracleReport(JSON.parse(raw) as unknown, raw);
  validateOracleReport(report, { adapterId: ORACLE_ADAPTERS.TXLINE_V1, fixtureIdentity: fixtureId, requireFinal: true });
  if (typeof report.proof.source !== "string" || !report.proof.source.toLowerCase().startsWith("txline")) {
    throw new Error("oracle_txline_source_not_authenticated");
  }
  return report;
}

export async function fetchSportmonksOracleReport(
  baseUrl: string,
  apiToken: string,
  fixtureId: string,
  timeoutMs = 10_000,
  requireFinal = true,
): Promise<NormalizedOracleReport | null> {
  const url = new URL(`${baseUrl}/fixtures/${encodeURIComponent(fixtureId)}`);
  url.searchParams.set("api_token", apiToken);
  url.searchParams.set("include", "state;scores;participants");
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "airarena-arc-witness-adapter/1" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`oracle_sportmonks_http_${response.status}`);
  const raw = await response.text();
  if (raw.length > 1_000_000) throw new Error("oracle_sportmonks_payload_too_large");
  const report = parseSportmonksOracleReport(JSON.parse(raw) as unknown, raw);
  validateOracleReport(report, { adapterId: ORACLE_ADAPTERS.SPORTMONKS_V1, fixtureIdentity: fixtureId, requireFinal });
  return report;
}

export async function verifySportmonksFixture(
  baseUrl: string,
  apiToken: string,
  fixtureId: string,
  expectedAccessTier: "FREE" | "TRIAL",
  timeoutMs = 10_000,
): Promise<{ rawPayloadHash: Hex; observedAt: string; accessTier: "FREE" | "TRIAL" }> {
  const url = new URL(`${baseUrl}/fixtures/${encodeURIComponent(fixtureId)}`);
  url.searchParams.set("api_token", apiToken);
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "airarena-arc-witness-qualification/1" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 404) throw new Error("oracle_witness_fixture_not_found");
  if (!response.ok) throw new Error(`oracle_witness_http_${response.status}`);
  const raw = await response.text();
  if (raw.length > 1_000_000) throw new Error("oracle_witness_payload_too_large");
  const parsed = SportmonksQualificationEnvelope.parse(JSON.parse(raw) as unknown);
  if (String(parsed.data.id) !== fixtureId) throw new Error("oracle_witness_fixture_mismatch");
  const accessTier = sportmonksAccessTier(parsed.subscription);
  if (!accessTier) throw new Error("oracle_witness_paid_subscription_forbidden");
  if (accessTier !== expectedAccessTier) throw new Error("oracle_witness_access_tier_mismatch");
  return { rawPayloadHash: keccak256(stringToHex(raw)), observedAt: new Date().toISOString(), accessTier };
}

export type OracleSseEvent = {
  id: string | null;
  event: string | null;
  data: unknown;
};

export async function* parseOracleSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<OracleSseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      let id: string | null = null;
      let event: string | null = null;
      const data: string[] = [];
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith("id:")) id = line.slice(3).trim();
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length) yield { id, event, data: JSON.parse(data.join("\n")) as unknown };
    }
    if (done) break;
  }
}

export function assertHexProof(value: unknown): Hex {
  if (typeof value !== "string" || !isHex(value, { strict: true })) throw new Error("oracle_proof_not_hex");
  return value;
}
