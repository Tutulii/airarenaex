import { createHash } from "node:crypto";
import { z } from "zod";

const FINAL_STATUSES = new Set([
  "final",
  "finished",
  "complete",
  "completed",
  "full_time",
  "fulltime",
  "ft",
  "finalised",
  "finalized",
  "game_finalised",
  "game_finalized",
]);

const TxlineOutcomeEnvelope = z.object({
  success: z.literal(true),
  data: z.object({
    fixtureId: z.union([z.string().min(1), z.number().int().nonnegative()]),
    status: z.string().min(1),
    homeScore: z.number().int().nonnegative(),
    awayScore: z.number().int().nonnegative(),
    winner: z.enum(["part1", "draw", "part2"]),
    source: z.string().min(1),
    sourceUpdateId: z.string().min(1).nullish(),
    sourceTimestamp: z.string().datetime({ offset: true }),
    settledAt: z.string().datetime({ offset: true }).nullish(),
    settlementRule: z.object({
      marketType: z.literal("1X2_PARTICIPANT_RESULT"),
      period: z.literal("regular_time_90_plus_stoppage"),
      includes: z.array(z.string()),
      excludes: z.array(z.string()),
    }),
  }),
});

export type TrustedTxlineOutcome = {
  fixtureId: string;
  status: string;
  homeScore: number;
  awayScore: number;
  winner: "part1" | "draw" | "part2";
  winningOutcome: 0 | 1 | 2;
  source: string;
  sourceUpdateId: string | null;
  sourceTimestamp: string;
  settledAt: string | null;
  evidenceHash: string;
  evidence: Record<string, unknown>;
};

export type TxlineOutcomeFetchResult =
  | { kind: "pending" }
  | { kind: "final"; outcome: TrustedTxlineOutcome };

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function winnerFromScore(homeScore: number, awayScore: number): "part1" | "draw" | "part2" {
  if (homeScore > awayScore) return "part1";
  if (awayScore > homeScore) return "part2";
  return "draw";
}

function outcomeIndex(winner: "part1" | "draw" | "part2"): 0 | 1 | 2 {
  return winner === "part1" ? 0 : winner === "draw" ? 1 : 2;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function parseTrustedTxlineOutcome(
  payload: unknown,
  expectedFixtureId: string,
  nowMs = Date.now(),
): TrustedTxlineOutcome {
  const parsed = TxlineOutcomeEnvelope.safeParse(payload);
  if (!parsed.success) throw new Error("txline_outcome_invalid_schema");
  const data = parsed.data.data;
  const fixtureId = String(data.fixtureId);
  if (fixtureId !== expectedFixtureId) throw new Error("txline_outcome_fixture_mismatch");

  const normalizedStatus = normalizeToken(data.status);
  if (!FINAL_STATUSES.has(normalizedStatus)) throw new Error("txline_outcome_not_final");
  const normalizedSource = normalizeToken(data.source);
  if (normalizedSource !== "txline" && !normalizedSource.startsWith("txline_")) {
    throw new Error("txline_outcome_source_not_trusted");
  }
  if (!data.settlementRule.includes.includes("stoppage_time")) {
    throw new Error("txline_outcome_rule_missing_stoppage_time");
  }
  if (
    !data.settlementRule.excludes.includes("extra_time")
    || !data.settlementRule.excludes.includes("penalty_shootout")
  ) {
    throw new Error("txline_outcome_rule_not_regulation_only");
  }

  const derivedWinner = winnerFromScore(data.homeScore, data.awayScore);
  if (derivedWinner !== data.winner) throw new Error("txline_outcome_winner_score_mismatch");
  const sourceTimeMs = Date.parse(data.sourceTimestamp);
  if (sourceTimeMs > nowMs + 5 * 60_000) throw new Error("txline_outcome_timestamp_in_future");

  const evidence = {
    fixtureId,
    status: normalizedStatus,
    homeScore: data.homeScore,
    awayScore: data.awayScore,
    winner: data.winner,
    source: data.source,
    sourceUpdateId: data.sourceUpdateId ?? null,
    sourceTimestamp: data.sourceTimestamp,
    settledAt: data.settledAt ?? null,
    settlementRule: data.settlementRule,
  };
  const evidenceHash = `0x${createHash("sha256").update(stableJson(evidence)).digest("hex")}`;
  return {
    fixtureId,
    status: normalizedStatus,
    homeScore: data.homeScore,
    awayScore: data.awayScore,
    winner: data.winner,
    winningOutcome: outcomeIndex(data.winner),
    source: data.source,
    sourceUpdateId: data.sourceUpdateId ?? null,
    sourceTimestamp: data.sourceTimestamp,
    settledAt: data.settledAt ?? null,
    evidenceHash,
    evidence,
  };
}

export async function fetchTrustedTxlineOutcome(
  sourceUrl: string,
  fixtureId: string,
  timeoutMs = 10_000,
): Promise<TxlineOutcomeFetchResult> {
  const response = await fetch(`${sourceUrl}/v1/txline/outcomes/${encodeURIComponent(fixtureId)}`, {
    headers: { accept: "application/json", "user-agent": "airarena-arc-settlement-watcher/0.1" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 404) return { kind: "pending" };
  if (!response.ok) throw new Error(`txline_outcome_http_${response.status}`);
  const body = await response.text();
  if (body.length > 1_000_000) throw new Error("txline_outcome_response_too_large");
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error("txline_outcome_invalid_json");
  }
  return { kind: "final", outcome: parseTrustedTxlineOutcome(payload, fixtureId) };
}
