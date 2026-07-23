import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ArcConfig } from "./config.js";
import type { Database } from "./db.js";
import { enqueueJob } from "./jobs.js";
import type { Logger } from "./logger.js";
import type { createMetrics } from "./metrics.js";
import { cancelProtocolLiquidityOrders } from "./liquidity-agent.js";
import {
  fetchSportmonksOracleReport,
  fetchTxlineOracleReport,
  ORACLE_ADAPTERS,
  parseOracleSse,
  parseTxlineScoreSseReports,
} from "./oracle-adapter.js";
import {
  evaluateOracleQuorum,
  evaluateOracleLiveHealth,
  readSelectedOracleReport,
  recordResolutionDecision,
  signOracleReport,
  storeOracleReport,
  updateMarketOracleHealth,
} from "./oracle-state.js";

export type ResultWatcherState = {
  stopping: boolean;
  resultWatcherLeader: boolean;
  lastResultPollAt: string | null;
  lastResultSourceOkAt: string | null;
  lastResultError: string | null;
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Optional TxLINE SSE ingestion. REST remains the authoritative poll used for
 * quorum construction; SSE supplies lower-latency append-only evidence. Both
 * paths use the same parser, deterministic selector, and Day 18 verifier.
 */
export async function runTxlineSseWatcher(
  config: ArcConfig,
  db: Database,
  logger: Logger,
  state: ResultWatcherState,
): Promise<void> {
  if (!config.txlineSseUrl) return;
  if (!config.txlineApiToken) throw new Error("oracle_txline_sse_token_missing");
  let lastEventId: string | null = null;
  let retryMs = 1_000;
  let guestJwt = config.txlineGuestJwt ?? null;
  while (!state.stopping) {
    const controller = new AbortController();
    const stopTimer = setInterval(() => {
      if (state.stopping) controller.abort();
    }, 500);
    try {
      if (!guestJwt) {
        const authUrl = new URL("/auth/guest/start", config.txlineSseUrl);
        const authResponse = await fetch(authUrl, {
          method: "POST",
          headers: { accept: "application/json", "user-agent": "airarena-arc-oracle-adapter/1" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!authResponse.ok) throw new Error(`oracle_txline_guest_auth_http_${authResponse.status}`);
        const authPayload = await authResponse.json() as { token?: unknown };
        if (typeof authPayload.token !== "string" || !authPayload.token.trim()) {
          throw new Error("oracle_txline_guest_auth_token_missing");
        }
        guestJwt = authPayload.token;
      }
      const headers: Record<string, string> = {
        accept: "text/event-stream",
        "cache-control": "no-cache",
        "user-agent": "airarena-arc-oracle-adapter/1",
        authorization: `Bearer ${guestJwt}`,
        "x-api-token": config.txlineApiToken,
      };
      if (lastEventId) headers["last-event-id"] = lastEventId;
      const response = await fetch(config.txlineSseUrl, { headers, signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`oracle_txline_sse_http_${response.status}`);
      retryMs = 1_000;
      for await (const event of parseOracleSse(response.body)) {
        if (state.stopping) break;
        if (event.id) lastEventId = event.id;
        // TxLINE sends `event: heartbeat` frames containing only `{ Ts }`.
        // They prove transport liveness, not fixture evidence, and therefore
        // must never enter the immutable evidence log or oracle-health quorum.
        if (event.event === "heartbeat") continue;
        try {
          const raw = JSON.stringify(event.data);
          const reports = parseTxlineScoreSseReports(event.data, raw, new Date().toISOString(), event.id);
          for (const report of reports) {
            const markets = await db.query<{ market_id: Hex }>(
              `SELECT market_id FROM arc_markets
                WHERE primary_adapter_id = $1 AND primary_fixture_identity = $2
                  AND status IN ('QUEUED','OPEN')
                ORDER BY market_id`,
              [ORACLE_ADAPTERS.TXLINE_V1, report.fixtureIdentity],
            );
            if (markets.rows.length === 0) {
              await storeOracleReport(db, report, null);
            } else {
              // A report hash is globally immutable. Associate it with the first
              // canonical market; all markets select it by adapter + fixture.
              await storeOracleReport(db, report, markets.rows[0]!.market_id);
            }
          }
          state.lastResultSourceOkAt = new Date().toISOString();
        } catch (error) {
          logger.warn({ err: error, eventId: event.id }, "arc_txline_sse_event_rejected");
        }
      }
    } catch (error) {
      // Guest JWTs are short-lived. Force a fresh one on any disconnect unless
      // an explicitly managed JWT was configured.
      if (!config.txlineGuestJwt) guestJwt = null;
      if (!state.stopping) logger.warn({ err: error, retryMs }, "arc_txline_sse_disconnected");
    } finally {
      clearInterval(stopTimer);
    }
    if (!state.stopping) {
      await delay(retryMs);
      retryMs = Math.min(retryMs * 2, 30_000);
    }
  }
}

type ResolutionRule = {
  primarySourceId: Hex;
  witnessSourceId: Hex;
  sourceEventId: Hex;
  primarySigner: string;
  witnessSigner: string;
  maxReportAgeSeconds: string;
  maxSourceTimestampSkewSeconds: string;
  graceSeconds: string;
};

type CandidateMarket = {
  market_id: Hex;
  fixture_id: string;
  spec_hash: Hex;
  close_time: Date;
  resolution_rule: ResolutionRule;
  primary_adapter_id: string;
  primary_fixture_identity: string;
  witness_adapter_id: string;
  witness_fixture_identity: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function candidates(db: Database): Promise<CandidateMarket[]> {
  const result = await db.query<CandidateMarket>(
    `SELECT market_id, fixture_id, spec_hash, close_time, resolution_rule,
            primary_adapter_id, primary_fixture_identity,
            witness_adapter_id, witness_fixture_identity
       FROM arc_markets
      WHERE status = 'OPEN'
        AND settlement_policy = 'TXLINE_1X2_REGULATION'
        AND outcome_count = 3
        AND resolution_job_id IS NULL
        AND witness_qualified_at IS NOT NULL
      ORDER BY close_time ASC
      LIMIT 50`,
  );
  return result.rows;
}

async function scheduleGraceInvalidation(db: Database, market: CandidateMarket): Promise<string | null> {
  const graceSeconds = Number(market.resolution_rule.graceSeconds);
  if (Date.now() < market.close_time.getTime() + graceSeconds * 1_000) return null;
  const job = await enqueueJob(
    db,
    "INVALIDATE_AFTER_GRACE",
    { marketId: market.market_id },
    `invalidate-after-grace:${market.market_id}`,
  );
  await db.query(
    `UPDATE arc_markets SET resolution_job_id = $2, updated_at = clock_timestamp()
      WHERE market_id = $1 AND status = 'OPEN' AND resolution_job_id IS NULL`,
    [market.market_id, job.id],
  );
  return job.id;
}

async function observeAndSchedule(
  config: ArcConfig,
  db: Database,
  market: CandidateMarket,
): Promise<{ kind: "PENDING" | "QUORUM" | "INVALIDATION"; jobId?: string }> {
  if (!config.exchangeAddress || !config.sportmonksApiToken
      || !config.oraclePrimarySignerPrivateKey || !config.oracleWitnessSignerPrivateKey) {
    throw new Error("oracle_runtime_not_configured");
  }
  if (market.primary_adapter_id !== ORACLE_ADAPTERS.TXLINE_V1
      || market.witness_adapter_id !== ORACLE_ADAPTERS.SPORTMONKS_V1) {
    throw new Error("oracle_market_adapter_binding_unsupported");
  }
  const [primaryRest, witness] = await Promise.all([
    fetchTxlineOracleReport(config.txlineSourceUrl, market.primary_fixture_identity),
    fetchSportmonksOracleReport(
      config.sportmonksApiUrl,
      config.sportmonksApiToken,
      market.witness_fixture_identity,
      10_000,
      false,
    ),
  ]);
  const selectedPrimary = primaryRest
    ? { report: primaryRest, conflicted: false }
    : await readSelectedOracleReport(db, ORACLE_ADAPTERS.TXLINE_V1, market.primary_fixture_identity);
  const primary = selectedPrimary.report;
  const primaryStored = primary ? await storeOracleReport(db, primary, market.market_id) : null;
  const witnessStored = witness ? await storeOracleReport(db, witness, market.market_id) : null;
  const sourceWindow = {
    nowMs: Date.now(),
    maxAgeSeconds: Number(market.resolution_rule.maxReportAgeSeconds),
    maxSkewSeconds: Number(market.resolution_rule.maxSourceTimestampSkewSeconds),
  };
  const resolutionDue = Date.now() >= market.close_time.getTime();
  let quorum = resolutionDue
    ? evaluateOracleQuorum(primary, witness, sourceWindow)
    : evaluateOracleLiveHealth(primary, witness, sourceWindow);
  if (selectedPrimary.conflicted || primaryStored?.conflicted || witnessStored?.conflicted) {
    quorum = {
      state: "MALFORMED",
      primary,
      witness,
      outcome: null,
      detail: "conflicting_source_identity",
    };
  }
  const health = await updateMarketOracleHealth(
    db,
    market.market_id,
    quorum,
    config.oracleRecoveryObservations,
  );
  if (quorum.state !== "HEALTHY" || !health.healthy || !primary || !witness) {
    if (config.liquidityAgentPrivateKey) {
      await cancelProtocolLiquidityOrders({ config, marketId: market.market_id }).catch(() => ({ submitted: 0, skipped: 0 }));
    }
    const jobId = await scheduleGraceInvalidation(db, market);
    await recordResolutionDecision(db, {
      marketId: market.market_id,
      primaryReportHash: primary?.reportHash ?? null,
      witnessReportHash: witness?.reportHash ?? null,
      decision: jobId ? "INVALIDATE" : "PENDING",
      reason: jobId ? `grace_expired:${quorum.detail}` : quorum.detail,
      normalizedOutcome: null,
    });
    return jobId ? { kind: "INVALIDATION", jobId } : { kind: "PENDING" };
  }
  const primaryAccount = privateKeyToAccount(config.oraclePrimarySignerPrivateKey);
  const witnessAccount = privateKeyToAccount(config.oracleWitnessSignerPrivateKey);
  if (getAddress(market.resolution_rule.primarySigner) !== primaryAccount.address
      || getAddress(market.resolution_rule.witnessSigner) !== witnessAccount.address) {
    throw new Error("oracle_signer_market_binding_mismatch");
  }
  const [primaryEnvelope, witnessEnvelope] = await Promise.all([
    signOracleReport({
      privateKey: config.oraclePrimarySignerPrivateKey,
      chainId: config.chainId,
      exchangeAddress: config.exchangeAddress,
      marketId: market.market_id,
      specHash: market.spec_hash,
      sourceId: market.resolution_rule.primarySourceId,
      sourceEventId: market.resolution_rule.sourceEventId,
      report: primary,
    }),
    signOracleReport({
      privateKey: config.oracleWitnessSignerPrivateKey,
      chainId: config.chainId,
      exchangeAddress: config.exchangeAddress,
      marketId: market.market_id,
      specHash: market.spec_hash,
      sourceId: market.resolution_rule.witnessSourceId,
      sourceEventId: market.resolution_rule.sourceEventId,
      report: witness,
    }),
  ]);
  const serialized = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, item: unknown) => (
    typeof item === "bigint" ? item.toString() : item
  ))) as Record<string, unknown>;
  const job = await enqueueJob(
    db,
    "RESOLVE_MARKET",
    {
      marketId: market.market_id,
      primary: serialized(primaryEnvelope),
      witness: serialized(witnessEnvelope),
    },
    `resolve-market:auto:${market.market_id}:${primary.reportHash}:${witness.reportHash}`,
  );
  await db.query(
    `UPDATE arc_markets SET resolution_job_id = $2, updated_at = clock_timestamp()
      WHERE market_id = $1 AND status = 'OPEN' AND resolution_job_id IS NULL`,
    [market.market_id, job.id],
  );
  await recordResolutionDecision(db, {
    marketId: market.market_id,
    primaryReportHash: primary.reportHash,
    witnessReportHash: witness.reportHash,
    decision: "QUORUM",
    reason: quorum.detail,
    normalizedOutcome: quorum.outcome,
  });
  return { kind: "QUORUM", jobId: job.id };
}

async function writeHeartbeat(db: Database, state: ResultWatcherState, candidateCount: number): Promise<void> {
  await db.query(
    `INSERT INTO arc_runtime_state(key, value, updated_at)
     VALUES ('result_watcher_heartbeat', jsonb_build_object(
       'lastPollAt', $1::text,
       'lastSourceOkAt', $2::text,
       'lastError', $3::text,
       'candidateCount', $4::integer
     ), clock_timestamp())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = clock_timestamp()`,
    [state.lastResultPollAt, state.lastResultSourceOkAt, state.lastResultError, candidateCount],
  );
}

export async function resultWatcherReady(db: Database, intervalMs: number): Promise<boolean> {
  const maxAgeMs = Math.max(60_000, intervalMs * 4);
  const result = await db.query<{ fresh: boolean }>(
    `SELECT updated_at > clock_timestamp() - ($1::bigint * interval '1 millisecond') AS fresh
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
      await delay(Math.max(1_000, config.resultPollIntervalMs));
    }
    if (state.stopping) return;
    state.resultWatcherLeader = true;
    metrics.resultWatcherLeader.set(1);
    logger.info({ intervalMs: config.resultPollIntervalMs }, "arc_oracle_quorum_watcher_started");

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
            const result = await observeAndSchedule(config, db, market);
            state.lastResultSourceOkAt = new Date().toISOString();
            metrics.resultObservations.inc({ result: result.kind.toLowerCase() });
            if (result.kind !== "PENDING") metrics.autoSettlementsEnqueued.inc();
            logger.info({ marketId: market.market_id, fixtureId: market.fixture_id, ...result }, "arc_oracle_quorum_observed");
          } catch (error) {
            state.lastResultError = errorMessage(error);
            metrics.resultObservations.inc({ result: "rejected_or_failed" });
            logger.warn({ err: error, marketId: market.market_id }, "arc_oracle_observation_failed_closed");
            const jobId = await scheduleGraceInvalidation(db, market).catch(() => null);
            if (jobId) metrics.autoSettlementsEnqueued.inc();
          }
        }
        await writeHeartbeat(db, state, candidateCount);
      } catch (error) {
        state.lastResultPollAt = new Date().toISOString();
        state.lastResultError = errorMessage(error);
        logger.error({ err: error }, "arc_oracle_watcher_iteration_failed");
        await writeHeartbeat(db, state, candidateCount).catch(() => undefined);
      }
      await delay(config.resultPollIntervalMs);
    }
  } finally {
    state.resultWatcherLeader = false;
    metrics.resultWatcherLeader.set(0);
    await lockClient.query("SELECT pg_advisory_unlock(hashtext('airarena_arc_result_watcher'))").catch(() => undefined);
    lockClient.release();
  }
}
