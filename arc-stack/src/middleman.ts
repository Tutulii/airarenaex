import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import {
  decodeEventLog,
  getAddress,
  isHex,
  type Hex,
  type Log,
} from "viem";
import { z } from "zod";
import {
  arenaExchangeAbi,
  createArcPublicClient,
  createArcWalletClient,
  transactionUrl,
  type ArcOrder,
} from "./chain.js";
import type { ArcConfig } from "./config.js";
import { createDatabase, databaseReady, migrateDatabase, type Database } from "./db.js";
import { claimNextJob, completeJob, enqueueJob, failJob, recoverAbandonedJobs, type ArcJob } from "./jobs.js";
import type { Logger } from "./logger.js";
import { createMetrics } from "./metrics.js";
import { resultWatcherReady, runResultWatcher } from "./settlement-watcher.js";

const Hex32 = z.string().refine((value) => isHex(value, { strict: true }) && value.length === 66);
const UintString = z.string().regex(/^(0|[1-9][0-9]*)$/);
const SubmitOrderPayload = z.object({
  orderHash: Hex32,
  signature: z.string().refine((value) => isHex(value, { strict: true })),
  order: z.object({
    maker: z.string(),
    marketId: Hex32,
    outcome: z.number().int().min(0).max(2),
    isBuy: z.boolean(),
    pricePpm: UintString,
    quantity: UintString,
    expiry: UintString,
    nonce: UintString,
    clientOrderId: Hex32,
  }),
});
const CreateMarketPayload = z.object({
  marketId: Hex32,
  externalIdHash: Hex32,
  fixtureId: z.string().min(1),
  outcomeCount: z.number().int().min(2).max(3),
  closeTime: UintString,
});
const ResolveMarketPayload = z.object({
  marketId: Hex32,
  winningOutcome: z.number().int().min(0).max(2),
  fixtureId: z.string().min(1).optional(),
  evidenceHash: Hex32.optional(),
});
const InvalidateMarketPayload = z.object({ marketId: Hex32 });
const ExecuteMatchPayload = z.object({
  marketId: Hex32,
  outcome: z.number().int().min(0).max(2),
  clearingPricePpm: UintString,
  buyOrderHash: Hex32,
  sellOrderHash: Hex32,
  quantity: UintString,
  buyFilledBefore: UintString,
  sellFilledBefore: UintString,
});

type RuntimeState = {
  startedAt: string;
  lastRpcOkAt: string | null;
  lastJobAt: string | null;
  lastIndexedBlock: string | null;
  indexerLeader: boolean;
  resultWatcherLeader: boolean;
  lastResultPollAt: string | null;
  lastResultSourceOkAt: string | null;
  lastResultError: string | null;
  stopping: boolean;
};

function serialize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function projectExecutedMatch(db: Database, job: ArcJob, payload: z.infer<typeof ExecuteMatchPayload>) {
  const buyTarget = BigInt(payload.buyFilledBefore) + BigInt(payload.quantity);
  const sellTarget = BigInt(payload.sellFilledBefore) + BigInt(payload.quantity);
  await db.query(
    `UPDATE arc_orders
     SET filled_quantity = GREATEST(filled_quantity, $2::numeric),
         status = CASE WHEN GREATEST(filled_quantity, $2::numeric) >= quantity THEN 'FILLED' ELSE 'ACTIVE' END,
         match_job_id = NULL, updated_at = now()
     WHERE order_hash = $1 AND match_job_id = $3`,
    [payload.buyOrderHash, buyTarget.toString(), job.id],
  );
  await db.query(
    `UPDATE arc_orders
     SET filled_quantity = GREATEST(filled_quantity, $2::numeric),
         status = CASE WHEN GREATEST(filled_quantity, $2::numeric) >= quantity THEN 'FILLED' ELSE 'ACTIVE' END,
         match_job_id = NULL, updated_at = now()
     WHERE order_hash = $1 AND match_job_id = $3`,
    [payload.sellOrderHash, sellTarget.toString(), job.id],
  );
}

async function scheduleCrossingMatch(db: Database): Promise<boolean> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{
      market_id: string;
      outcome: number;
      buy_order_hash: string;
      sell_order_hash: string;
      quantity: string;
      clearing_price_ppm: string;
      buy_filled_before: string;
      sell_filled_before: string;
    }>(
      `SELECT b.market_id, b.outcome, b.order_hash AS buy_order_hash, s.order_hash AS sell_order_hash,
              LEAST(b.quantity - b.filled_quantity, s.quantity - s.filled_quantity)::text AS quantity,
              CASE WHEN (b.created_at, b.order_hash) <= (s.created_at, s.order_hash)
                   THEN b.price_ppm ELSE s.price_ppm END::text AS clearing_price_ppm,
              b.filled_quantity::text AS buy_filled_before,
              s.filled_quantity::text AS sell_filled_before
       FROM arc_orders b
       JOIN arc_orders s ON s.market_id = b.market_id AND s.outcome = b.outcome
       JOIN arc_markets m ON m.market_id = b.market_id
       WHERE b.side = 'BUY' AND s.side = 'SELL'
         AND b.status IN ('ACTIVE','SUBMITTED') AND s.status IN ('ACTIVE','SUBMITTED')
         AND b.maker <> s.maker
         AND b.price_ppm >= s.price_ppm
         AND b.quantity > b.filled_quantity AND s.quantity > s.filled_quantity
         AND b.expiry > now() AND s.expiry > now()
         AND m.status = 'OPEN' AND m.close_time > now()
       ORDER BY b.price_ppm DESC, b.created_at, s.price_ppm, s.created_at
       FOR UPDATE OF b, s SKIP LOCKED
       LIMIT 1`,
    );
    const row = result.rows[0];
    if (!row) {
      await client.query("COMMIT");
      return false;
    }
    const idempotencyKey = [
      "execute-match",
      row.buy_order_hash,
      row.sell_order_hash,
      row.buy_filled_before,
      row.sell_filled_before,
      row.quantity,
    ].join(":");
    const job = await enqueueJob(client, "EXECUTE_MATCH", {
      marketId: row.market_id,
      outcome: row.outcome,
      clearingPricePpm: row.clearing_price_ppm,
      buyOrderHash: row.buy_order_hash,
      sellOrderHash: row.sell_order_hash,
      quantity: row.quantity,
      buyFilledBefore: row.buy_filled_before,
      sellFilledBefore: row.sell_filled_before,
    }, idempotencyKey);
    await client.query(
      `UPDATE arc_orders SET status = 'MATCHING', match_job_id = $3, updated_at = now()
       WHERE order_hash IN ($1, $2)`,
      [row.buy_order_hash, row.sell_order_hash, job.id],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function sendContractTransaction(
  job: ArcJob,
  config: ArcConfig,
  db: Database,
  logger: Logger,
): Promise<Hex | null> {
  if (!config.exchangeAddress) throw new Error("exchange_not_configured");
  const publicClient = createArcPublicClient(config);
  const signerKey = job.kind === "CREATE_MARKET"
    ? config.marketAdminPrivateKey
    : job.kind === "EXECUTE_MATCH"
      ? config.matcherPrivateKey
    : job.kind === "RESOLVE_MARKET" || job.kind === "INVALIDATE_MARKET"
      ? config.resolverPrivateKey
      : config.relayerPrivateKey;
  const walletClient = createArcWalletClient(config, signerKey);
  const account = walletClient.account;
  if (!account) throw new Error("relayer_account_unavailable");

  let hash: Hex;
  switch (job.kind) {
    case "SUBMIT_ORDER": {
      const payload = SubmitOrderPayload.parse(job.payload);
      const stored = await publicClient.readContract({
        address: config.exchangeAddress,
        abi: arenaExchangeAbi,
        functionName: "getOrder",
        args: [payload.orderHash as Hex],
      });
      if (Number(stored.status) !== 0) {
        const recoveredStatus = ["NONE", "ACTIVE", "FILLED", "CANCELLED"][Number(stored.status)] ?? "SUBMITTED";
        await db.query(
          "UPDATE arc_orders SET status = $2, updated_at = now() WHERE order_hash = $1",
          [payload.orderHash, recoveredStatus],
        );
        logger.warn({ jobId: job.id, orderHash: payload.orderHash, recoveredStatus }, "arc_job_recovered_from_chain_state");
        return null;
      }
      const order: ArcOrder = {
        maker: getAddress(payload.order.maker),
        marketId: payload.order.marketId as Hex,
        outcome: payload.order.outcome,
        isBuy: payload.order.isBuy,
        pricePpm: BigInt(payload.order.pricePpm),
        quantity: BigInt(payload.order.quantity),
        expiry: BigInt(payload.order.expiry),
        nonce: BigInt(payload.order.nonce),
        clientOrderId: payload.order.clientOrderId as Hex,
      };
      const simulation = await publicClient.simulateContract({
        account,
        address: config.exchangeAddress,
        abi: arenaExchangeAbi,
        functionName: "submitOrder",
        args: [order, payload.signature as Hex],
      });
      hash = await walletClient.writeContract(simulation.request);
      break;
    }
    case "EXECUTE_MATCH": {
      const payload = ExecuteMatchPayload.parse(job.payload);
      const [buy, sell] = await Promise.all([
        publicClient.readContract({
          address: config.exchangeAddress,
          abi: arenaExchangeAbi,
          functionName: "getOrder",
          args: [payload.buyOrderHash as Hex],
        }),
        publicClient.readContract({
          address: config.exchangeAddress,
          abi: arenaExchangeAbi,
          functionName: "getOrder",
          args: [payload.sellOrderHash as Hex],
        }),
      ]);
      const buyTarget = BigInt(payload.buyFilledBefore) + BigInt(payload.quantity);
      const sellTarget = BigInt(payload.sellFilledBefore) + BigInt(payload.quantity);
      if (buy.filledQuantity >= buyTarget && sell.filledQuantity >= sellTarget) {
        await projectExecutedMatch(db, job, payload);
        logger.warn({ jobId: job.id, buyOrderHash: payload.buyOrderHash, sellOrderHash: payload.sellOrderHash }, "arc_job_recovered_from_chain_state");
        return null;
      }
      if (buy.filledQuantity !== BigInt(payload.buyFilledBefore) || sell.filledQuantity !== BigInt(payload.sellFilledBefore)) {
        throw new Error("match_prestate_changed");
      }
      if (Number(buy.status) !== 1 || Number(sell.status) !== 1) throw new Error("match_order_not_active");
      const simulation = await publicClient.simulateContract({
        account,
        address: config.exchangeAddress,
        abi: arenaExchangeAbi,
        functionName: "executeBatch",
        args: [
          payload.marketId as Hex,
          payload.outcome,
          BigInt(payload.clearingPricePpm),
          [{
            buyOrderHash: payload.buyOrderHash as Hex,
            sellOrderHash: payload.sellOrderHash as Hex,
            quantity: BigInt(payload.quantity),
          }],
        ],
      });
      hash = await walletClient.writeContract(simulation.request);
      break;
    }
    case "CREATE_MARKET": {
      const payload = CreateMarketPayload.parse(job.payload);
      const market = await publicClient.readContract({
        address: config.exchangeAddress,
        abi: arenaExchangeAbi,
        functionName: "markets",
        args: [payload.marketId as Hex],
      });
      if (Number(market[3]) !== 0) {
        if (
          market[0].toLowerCase() !== payload.externalIdHash.toLowerCase()
          || Number(market[1]) !== payload.outcomeCount
          || market[2] !== BigInt(payload.closeTime)
        ) throw new Error("market_id_conflicts_with_onchain_state");
        await db.query(
          "UPDATE arc_markets SET status = $2, updated_at = now() WHERE market_id = $1",
          [payload.marketId, Number(market[3]) === 1 ? "OPEN" : Number(market[3]) === 2 ? "RESOLVED" : "INVALID"],
        );
        logger.warn({ jobId: job.id, marketId: payload.marketId }, "arc_job_recovered_from_chain_state");
        return null;
      }
      const simulation = await publicClient.simulateContract({
        account,
        address: config.exchangeAddress,
        abi: arenaExchangeAbi,
        functionName: "createMarket",
        args: [
          payload.marketId as Hex,
          payload.externalIdHash as Hex,
          payload.outcomeCount,
          BigInt(payload.closeTime),
        ],
      });
      hash = await walletClient.writeContract(simulation.request);
      break;
    }
    case "RESOLVE_MARKET": {
      const payload = ResolveMarketPayload.parse(job.payload);
      const market = await publicClient.readContract({
        address: config.exchangeAddress,
        abi: arenaExchangeAbi,
        functionName: "markets",
        args: [payload.marketId as Hex],
      });
      if (Number(market[3]) === 2) {
        if (Number(market[4]) !== payload.winningOutcome) throw new Error("market_resolved_with_different_outcome");
        await db.query(
          "UPDATE arc_markets SET status = 'RESOLVED', winning_outcome = $2, updated_at = now() WHERE market_id = $1",
          [payload.marketId, payload.winningOutcome],
        );
        logger.warn({ jobId: job.id, marketId: payload.marketId }, "arc_job_recovered_from_chain_state");
        return null;
      }
      if (Number(market[3]) === 3) throw new Error("market_already_invalidated");
      const simulation = await publicClient.simulateContract({
        account,
        address: config.exchangeAddress,
        abi: arenaExchangeAbi,
        functionName: "resolveMarket",
        args: [payload.marketId as Hex, payload.winningOutcome],
      });
      hash = await walletClient.writeContract(simulation.request);
      break;
    }
    case "INVALIDATE_MARKET": {
      const payload = InvalidateMarketPayload.parse(job.payload);
      const market = await publicClient.readContract({
        address: config.exchangeAddress,
        abi: arenaExchangeAbi,
        functionName: "markets",
        args: [payload.marketId as Hex],
      });
      if (Number(market[3]) === 3) {
        await db.query(
          "UPDATE arc_markets SET status = 'INVALID', updated_at = now() WHERE market_id = $1",
          [payload.marketId],
        );
        logger.warn({ jobId: job.id, marketId: payload.marketId }, "arc_job_recovered_from_chain_state");
        return null;
      }
      if (Number(market[3]) === 2) throw new Error("market_already_resolved");
      const simulation = await publicClient.simulateContract({
        account,
        address: config.exchangeAddress,
        abi: arenaExchangeAbi,
        functionName: "invalidateMarket",
        args: [payload.marketId as Hex],
      });
      hash = await walletClient.writeContract(simulation.request);
      break;
    }
  }

  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 30_000 });
  if (receipt.status !== "success") throw new Error(`transaction_reverted:${hash}`);
  logger.info({ jobId: job.id, kind: job.kind, txHash: hash, explorerUrl: transactionUrl(hash) }, "arc_job_transaction_confirmed");

  if (job.kind === "SUBMIT_ORDER") {
    const payload = SubmitOrderPayload.parse(job.payload);
    await db.query(
      "UPDATE arc_orders SET status = 'ACTIVE', tx_hash = $2, updated_at = now() WHERE order_hash = $1",
      [payload.orderHash, hash],
    );
  } else if (job.kind === "EXECUTE_MATCH") {
    await projectExecutedMatch(db, job, ExecuteMatchPayload.parse(job.payload));
  } else if (job.kind === "CREATE_MARKET") {
    const payload = CreateMarketPayload.parse(job.payload);
    await db.query(
      "UPDATE arc_markets SET status = 'OPEN', create_tx_hash = $2, updated_at = now() WHERE market_id = $1",
      [payload.marketId, hash],
    );
  } else if (job.kind === "RESOLVE_MARKET") {
    const payload = ResolveMarketPayload.parse(job.payload);
    await db.query(
      `UPDATE arc_markets SET status = 'RESOLVED', winning_outcome = $2,
       resolution_tx_hash = $3, updated_at = now() WHERE market_id = $1`,
      [payload.marketId, payload.winningOutcome, hash],
    );
  } else {
    const payload = InvalidateMarketPayload.parse(job.payload);
    await db.query(
      `UPDATE arc_markets SET status = 'INVALID', resolution_tx_hash = $2,
       updated_at = now() WHERE market_id = $1`,
      [payload.marketId, hash],
    );
  }
  return hash;
}

async function processJobs(
  config: ArcConfig,
  db: Database,
  logger: Logger,
  state: RuntimeState,
  metrics: ReturnType<typeof createMetrics>,
): Promise<void> {
  const workerId = `${process.env.RAILWAY_REPLICA_ID ?? "local"}:${process.pid}:${randomUUID()}`;
  const recovered = await recoverAbandonedJobs(db);
  if (recovered) logger.warn({ recovered }, "arc_abandoned_jobs_recovered");

  while (!state.stopping) {
    let job: ArcJob | null = null;
    try {
      job = await claimNextJob(db, workerId);
      if (!job) {
        if (await scheduleCrossingMatch(db)) continue;
        await new Promise((resolve) => setTimeout(resolve, config.jobPollIntervalMs));
        continue;
      }
      const txHash = await sendContractTransaction(job, config, db, logger);
      await completeJob(db, job.id, txHash);
      state.lastJobAt = new Date().toISOString();
      metrics.jobsProcessed.inc({ kind: job.kind, result: "success" });
    } catch (error) {
      logger.error({ err: error, jobId: job?.id, kind: job?.kind }, "arc_job_failed");
      if (job) {
        const dead = await failJob(db, job, errorMessage(error)).catch((failure) => {
          logger.fatal({ err: failure, jobId: job?.id }, "arc_job_failure_state_write_failed");
          return false;
        });
        if (dead && job.kind === "EXECUTE_MATCH") {
          await db.query(
            `UPDATE arc_orders SET status = 'ACTIVE', match_job_id = NULL, updated_at = now()
             WHERE match_job_id = $1 AND status = 'MATCHING'`,
            [job.id],
          ).catch((failure) => logger.error({ err: failure, jobId: job?.id }, "arc_match_release_failed"));
        }
        metrics.jobsProcessed.inc({ kind: job.kind, result: "failure" });
      }
      await new Promise((resolve) => setTimeout(resolve, config.jobPollIntervalMs));
    }
  }
}

async function applyIndexedEvent(db: Database, eventName: string, args: Record<string, unknown>, txHash: Hex) {
  if (eventName === "MarketCreated") {
    await db.query(
      `UPDATE arc_markets SET status = 'OPEN', create_tx_hash = COALESCE(create_tx_hash, $2), updated_at = now()
       WHERE market_id = $1`,
      [args.marketId, txHash],
    );
  } else if (eventName === "MarketResolved") {
    await db.query(
      `UPDATE arc_markets SET status = 'RESOLVED', winning_outcome = $2,
       resolution_tx_hash = COALESCE(resolution_tx_hash, $3), updated_at = now() WHERE market_id = $1`,
      [args.marketId, Number(args.winningOutcome), txHash],
    );
  } else if (eventName === "MarketInvalidated") {
    await db.query(
      `UPDATE arc_markets SET status = 'INVALID', resolution_tx_hash = COALESCE(resolution_tx_hash, $2),
       updated_at = now() WHERE market_id = $1`,
      [args.marketId, txHash],
    );
  } else if (eventName === "OrderSubmitted") {
    await db.query(
      `UPDATE arc_orders SET status = 'ACTIVE', tx_hash = COALESCE(tx_hash, $2), updated_at = now()
       WHERE order_hash = $1`,
      [args.orderHash, txHash],
    );
  } else if (eventName === "OrderCancelled") {
    await db.query(
      `UPDATE arc_orders SET status = 'CANCELLED', match_job_id = NULL, updated_at = now()
       WHERE order_hash = $1`,
      [args.orderHash],
    );
  }
}

async function persistLog(db: Database, log: Log, eventName: string, args: Record<string, unknown>): Promise<void> {
  const txHash = log.transactionHash;
  const blockHash = log.blockHash;
  const blockNumber = log.blockNumber;
  if (!txHash || !blockHash || blockNumber === null || log.logIndex === null) return;
  const result = await db.query(
    `INSERT INTO arc_chain_events(tx_hash, log_index, block_number, block_hash, event_name, payload)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     ON CONFLICT (tx_hash, log_index) DO NOTHING`,
    [txHash, log.logIndex, blockNumber.toString(), blockHash, eventName, JSON.stringify(serialize(args))],
  );
  if ((result.rowCount ?? 0) > 0) await applyIndexedEvent(db, eventName, args, txHash);
}

async function runIndexer(
  config: ArcConfig,
  db: Database,
  logger: Logger,
  state: RuntimeState,
  metrics: ReturnType<typeof createMetrics>,
): Promise<void> {
  if (!config.exchangeAddress) throw new Error("exchange_not_configured");
  const lockClient = await db.connect();
  try {
    while (!state.stopping) {
      const lock = await lockClient.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(5042002) AS acquired");
      if (lock.rows[0]?.acquired) break;
      logger.info("arc_indexer_waiting_for_leadership");
      await new Promise((resolve) => setTimeout(resolve, Math.max(1_000, config.indexerPollIntervalMs)));
    }
    if (state.stopping) return;
    state.indexerLeader = true;
    const publicClient = createArcPublicClient(config);
    while (!state.stopping) {
      try {
        const current = await publicClient.getBlockNumber();
        state.lastRpcOkAt = new Date().toISOString();
        const stored = await db.query<{ value: { block?: string } }>(
          "SELECT value FROM arc_runtime_state WHERE key = 'indexer_cursor'",
        );
        const configuredStart = config.indexerStartBlock ?? current;
        let fromBlock = stored.rows[0]?.value.block ? BigInt(stored.rows[0].value.block) + 1n : configuredStart;
        while (fromBlock <= current && !state.stopping) {
          const toBlock = fromBlock + 499n < current ? fromBlock + 499n : current;
          const logs = await publicClient.getLogs({ address: config.exchangeAddress, fromBlock, toBlock });
          for (const log of logs) {
            try {
              const decoded = decodeEventLog({ abi: arenaExchangeAbi, data: log.data, topics: log.topics });
              await persistLog(db, log, decoded.eventName, decoded.args as Record<string, unknown>);
            } catch (error) {
              logger.debug({ err: error, txHash: log.transactionHash, logIndex: log.logIndex }, "arc_untracked_contract_event");
            }
          }
          await db.query(
            `INSERT INTO arc_runtime_state(key, value, updated_at)
             VALUES ('indexer_cursor', jsonb_build_object('block', $1::text), now())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
            [toBlock.toString()],
          );
          state.lastIndexedBlock = toBlock.toString();
          metrics.indexerBlock.set(Number(toBlock));
          fromBlock = toBlock + 1n;
        }
      } catch (error) {
        logger.error({ err: error }, "arc_indexer_iteration_failed");
      }
      await new Promise((resolve) => setTimeout(resolve, config.indexerPollIntervalMs));
    }
  } finally {
    state.indexerLeader = false;
    await lockClient.query("SELECT pg_advisory_unlock(5042002)").catch(() => undefined);
    lockClient.release();
  }
}

export async function startMiddleman(config: ArcConfig, logger: Logger): Promise<void> {
  const db = createDatabase(config);
  await migrateDatabase(db, logger);
  const metrics = createMetrics("airarena-arc-middleman");
  const state: RuntimeState = {
    startedAt: new Date().toISOString(),
    lastRpcOkAt: null,
    lastJobAt: null,
    lastIndexedBlock: null,
    indexerLeader: false,
    resultWatcherLeader: false,
    lastResultPollAt: null,
    lastResultSourceOkAt: null,
    lastResultError: null,
    stopping: false,
  };
  const publicClient = createArcPublicClient(config);
  const chainId = await publicClient.getChainId();
  if (chainId !== config.chainId) throw new Error(`rpc_chain_id_mismatch:${chainId}`);
  if (!config.exchangeAddress || !(await publicClient.getBytecode({ address: config.exchangeAddress }))) {
    throw new Error("arc_exchange_contract_not_deployed");
  }
  state.lastRpcOkAt = new Date().toISOString();

  const app = Fastify({ logger: false, trustProxy: true });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { max: 60, timeWindow: "1 minute", ban: 2 });
  app.get("/health/live", async () => ({ status: "ok", service: "airarena-arc-middleman", state }));
  app.get("/health/ready", async (_request, reply) => {
    const checks = {
      database: await databaseReady(db),
      rpc: state.lastRpcOkAt ? Date.now() - Date.parse(state.lastRpcOkAt) < 30_000 : false,
      contract: true,
      relayer: Boolean(config.relayerPrivateKey),
      marketAdmin: Boolean(config.marketAdminPrivateKey),
      matcher: Boolean(config.matcherPrivateKey),
      resolver: Boolean(config.resolverPrivateKey),
      resultWatcher: await resultWatcherReady(db, config.resultPollIntervalMs),
    };
    const ready = Object.values(checks).every(Boolean);
    return reply.status(ready ? 200 : 503).send({ status: ready ? "ready" : "not_ready", checks, state });
  });
  app.get("/metrics", async (_request, reply) => {
    reply.header("content-type", metrics.registry.contentType);
    return metrics.registry.metrics();
  });

  const stop = async (signal: string) => {
    if (state.stopping) return;
    state.stopping = true;
    logger.info({ signal }, "arc_middleman_stopping");
    await app.close().catch(() => undefined);
    await db.end().catch(() => undefined);
  };
  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));

  await app.listen({ host: "0.0.0.0", port: config.port });
  logger.info({
    port: config.port,
    relayer: createArcWalletClient(config, config.relayerPrivateKey).account?.address,
    marketAdmin: createArcWalletClient(config, config.marketAdminPrivateKey).account?.address,
    matcher: createArcWalletClient(config, config.matcherPrivateKey).account?.address,
    resolver: createArcWalletClient(config, config.resolverPrivateKey).account?.address,
  }, "arc_middleman_started");
  void processJobs(config, db, logger, state, metrics);
  void runIndexer(config, db, logger, state, metrics);
  void runResultWatcher(config, db, logger, state, metrics);
}
