import type { ArcConfig } from "./config.js";
import type { Database } from "./db.js";
import { enqueueJob } from "./jobs.js";
import type { Logger } from "./logger.js";
import type { createMetrics } from "./metrics.js";
import { fetchTrustedTxlineOutcome, type TrustedTxlineOutcome } from "./txline-outcome.js";

export type ResultWatcherState = {
  stopping: boolean;
  resultWatcherLeader: boolean;
  lastResultPollAt: string | null;
  lastResultSourceOkAt: string | null;
  lastResultError: string | null;
};

type CandidateMarket = {
  market_id: string;
  fixture_id: string;
  outcome_count: number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function candidates(db: Database): Promise<CandidateMarket[]> {
  const result = await db.query<CandidateMarket>(
    `SELECT market_id, fixture_id, outcome_count
     FROM arc_markets
     WHERE status = 'OPEN'
       AND settlement_policy = 'TXLINE_1X2_REGULATION'
       AND outcome_count = 3
       AND close_time <= now()
       AND resolution_job_id IS NULL
     ORDER BY close_time ASC
     LIMIT 10`,
  );
  return result.rows;
}

export async function scheduleTrustedOutcome(
  db: Database,
  marketId: string,
  outcome: TrustedTxlineOutcome,
): Promise<{ scheduled: boolean; jobId?: string }> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const market = await client.query<{
      fixture_id: string;
      outcome_count: number;
      status: string;
      settlement_policy: string;
      resolution_job_id: string | null;
      close_time: Date;
    }>(
      `SELECT fixture_id, outcome_count, status, settlement_policy, resolution_job_id, close_time
       FROM arc_markets WHERE market_id = $1 FOR UPDATE`,
      [marketId],
    );
    const row = market.rows[0];
    if (
      !row
      || row.fixture_id !== outcome.fixtureId
      || row.outcome_count !== 3
      || row.status !== "OPEN"
      || row.settlement_policy !== "TXLINE_1X2_REGULATION"
      || row.resolution_job_id
      || row.close_time.getTime() > Date.now()
    ) {
      await client.query("COMMIT");
      return { scheduled: false };
    }

    await client.query(
      `INSERT INTO arc_result_observations(
         market_id, fixture_id, evidence_hash, source, source_update_id, source_timestamp,
         home_score, away_score, winner, winning_outcome, evidence
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
       ON CONFLICT (market_id, evidence_hash) DO NOTHING`,
      [
        marketId,
        outcome.fixtureId,
        outcome.evidenceHash,
        outcome.source,
        outcome.sourceUpdateId,
        outcome.sourceTimestamp,
        outcome.homeScore,
        outcome.awayScore,
        outcome.winner,
        outcome.winningOutcome,
        JSON.stringify(outcome.evidence),
      ],
    );
    const job = await enqueueJob(
      client,
      "RESOLVE_MARKET",
      {
        marketId,
        winningOutcome: outcome.winningOutcome,
        fixtureId: outcome.fixtureId,
        evidenceHash: outcome.evidenceHash,
      },
      `auto-resolve:${marketId}:${outcome.evidenceHash}`,
    );
    await client.query(
      `UPDATE arc_markets
       SET result_home_score = $2, result_away_score = $3, result_source = $4,
           result_source_update_id = $5, result_source_timestamp = $6,
           result_observed_at = now(), result_evidence_hash = $7, result_evidence = $8::jsonb,
           resolution_job_id = $9, updated_at = now()
       WHERE market_id = $1`,
      [
        marketId,
        outcome.homeScore,
        outcome.awayScore,
        outcome.source,
        outcome.sourceUpdateId,
        outcome.sourceTimestamp,
        outcome.evidenceHash,
        JSON.stringify(outcome.evidence),
        job.id,
      ],
    );
    await client.query("COMMIT");
    return { scheduled: true, jobId: job.id };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function writeHeartbeat(db: Database, state: ResultWatcherState, candidateCount: number): Promise<void> {
  await db.query(
    `INSERT INTO arc_runtime_state(key, value, updated_at)
     VALUES ('result_watcher_heartbeat', jsonb_build_object(
       'lastPollAt', $1::text,
       'lastSourceOkAt', $2::text,
       'lastError', $3::text,
       'candidateCount', $4::integer
     ), now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [state.lastResultPollAt, state.lastResultSourceOkAt, state.lastResultError, candidateCount],
  );
}

export async function resultWatcherReady(db: Database, intervalMs: number): Promise<boolean> {
  const maxAgeMs = Math.max(60_000, intervalMs * 4);
  const result = await db.query<{ fresh: boolean }>(
    `SELECT updated_at > now() - ($1::bigint * interval '1 millisecond') AS fresh
     FROM arc_runtime_state WHERE key = 'result_watcher_heartbeat'`,
    [maxAgeMs],
  );
  return result.rows[0]?.fresh === true;
}

export async function runResultWatcher(
  config: ArcConfig,
  db: Database,
  logger: Logger,
  state: ResultWatcherState,
  metrics: ReturnType<typeof createMetrics>,
): Promise<void> {
  const lockClient = await db.connect();
  try {
    while (!state.stopping) {
      const lock = await lockClient.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext('airarena_arc_result_watcher')) AS acquired",
      );
      if (lock.rows[0]?.acquired) break;
      logger.info("arc_result_watcher_waiting_for_leadership");
      await new Promise((resolve) => setTimeout(resolve, Math.max(1_000, config.resultPollIntervalMs)));
    }
    if (state.stopping) return;
    state.resultWatcherLeader = true;
    metrics.resultWatcherLeader.set(1);
    logger.info({ intervalMs: config.resultPollIntervalMs }, "arc_result_watcher_started");

    while (!state.stopping) {
      let candidateCount = 0;
      try {
        const due = await candidates(db);
        candidateCount = due.length;
        state.lastResultPollAt = new Date().toISOString();
        state.lastResultError = null;
        for (const market of due) {
          if (state.stopping) break;
          try {
            const fetched = await fetchTrustedTxlineOutcome(config.txlineSourceUrl, market.fixture_id);
            state.lastResultSourceOkAt = new Date().toISOString();
            if (fetched.kind === "pending") continue;
            metrics.resultObservations.inc({ result: "trusted_final" });
            const scheduled = await scheduleTrustedOutcome(db, market.market_id, fetched.outcome);
            if (scheduled.scheduled) {
              metrics.autoSettlementsEnqueued.inc();
              logger.info({
                marketId: market.market_id,
                fixtureId: market.fixture_id,
                winningOutcome: fetched.outcome.winningOutcome,
                evidenceHash: fetched.outcome.evidenceHash,
                jobId: scheduled.jobId,
              }, "arc_autonomous_resolution_enqueued");
            }
          } catch (error) {
            const message = errorMessage(error);
            state.lastResultError = message;
            metrics.resultObservations.inc({ result: "rejected_or_failed" });
            logger.warn({ err: error, marketId: market.market_id, fixtureId: market.fixture_id }, "arc_result_observation_failed_closed");
          }
        }
        await writeHeartbeat(db, state, candidateCount);
      } catch (error) {
        state.lastResultPollAt = new Date().toISOString();
        state.lastResultError = errorMessage(error);
        logger.error({ err: error }, "arc_result_watcher_iteration_failed");
        await writeHeartbeat(db, state, candidateCount).catch(() => undefined);
      }
      await new Promise((resolve) => setTimeout(resolve, config.resultPollIntervalMs));
    }
  } finally {
    state.resultWatcherLeader = false;
    metrics.resultWatcherLeader.set(0);
    await lockClient.query("SELECT pg_advisory_unlock(hashtext('airarena_arc_result_watcher'))").catch(() => undefined);
    lockClient.release();
  }
}
