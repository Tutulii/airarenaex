import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import {
  decodeEventLog,
  concatHex,
  encodeAbiParameters,
  getAddress,
  isHex,
  keccak256,
  parseAbiItem,
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
import {
  bindDatabaseToExchange,
  createDatabase,
  databaseReady,
  migrateDatabase,
  type Database,
  type DatabaseClient,
} from "./db.js";
import {
  claimNextJob,
  completeJob,
  enqueueJob,
  failJob,
  recoverAbandonedJobs,
  requeueRestartableJob,
  type ArcJob,
} from "./jobs.js";
import type { Logger } from "./logger.js";
import { createMetrics } from "./metrics.js";
import { resultWatcherReady, runResultWatcher, runTxlineSseWatcher } from "./settlement-watcher.js";
import { runProtocolLiquidityAgent } from "./liquidity-agent.js";
import { ORACLE_ADAPTERS } from "./oracle-adapter.js";
import {
  assignActiveOrderToBatch,
  failAndReleaseBatch,
  finalizeExecutedBatch,
  loadPendingBatchChunks,
  markBatchChunk,
  sealNextBatch,
} from "./batches.js";
import { appendExchangeEvent } from "./exchange-events.js";
import { appendOrderEvent, payloadHash } from "./order-intake.js";
import { activateHalt, recordRecoveryObservation } from "./risk-controls.js";

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
const CancelOrderPayload = z.object({
  cancellationHash: Hex32,
  signature: z.string().refine((value) => isHex(value, { strict: true })),
  cancellation: z.object({
    maker: z.string(),
    orderHash: Hex32,
    nonce: UintString,
    deadline: UintString,
  }),
});
const ExecuteBatchPayload = z.object({
  batchId: Hex32,
  fencingToken: UintString,
  resultHash: Hex32,
});
const CreateMarketPayload = z.object({
  marketId: Hex32,
  specHash: Hex32,
  externalIdHash: Hex32,
  fixtureId: z.string().min(1),
  outcomeCount: z.number().int().min(2).max(3),
  closeTime: UintString,
  resolutionRule: z.object({
    primarySourceId: Hex32,
    witnessSourceId: Hex32,
    sourceEventId: Hex32,
    primarySigner: z.string(),
    witnessSigner: z.string(),
    maxReportAgeSeconds: UintString,
    maxSourceTimestampSkewSeconds: UintString,
    graceSeconds: UintString,
  }),
});
const ResolutionReportPayload = z.object({
  sourceId: Hex32,
  sourceEventId: Hex32,
  observedAt: UintString,
  publishedAt: UintString,
  finalResult: z.boolean(),
  normalizedOutcome: z.number().int().min(0).max(2),
  rawPayloadHash: Hex32,
  signatureEvidence: z.string().refine((value) => isHex(value, { strict: true }) && value.length > 2),
});
const ResolveMarketPayload = z.object({
  marketId: Hex32,
  primary: ResolutionReportPayload,
  witness: ResolutionReportPayload,
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

type LegacyMatch = { buyOrderHash: Hex; sellOrderHash: Hex; quantity: bigint };

function legacyBatchCommitment(
  marketId: Hex,
  outcome: number,
  clearingPricePpm: bigint,
  matches: LegacyMatch[],
): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: "string" },
      { type: "bytes32" },
      { type: "uint8" },
      { type: "uint64" },
      {
        type: "tuple[]",
        components: [
          { name: "buyOrderHash", type: "bytes32" },
          { name: "sellOrderHash", type: "bytes32" },
          { name: "quantity", type: "uint128" },
        ],
      },
    ],
    ["AIR_ARENA_LEGACY_BATCH_V1", marketId, outcome, clearingPricePpm, matches],
  ));
}

async function ensureLegacyBatchCommitment(
  publicClient: ReturnType<typeof createArcPublicClient>,
  walletClient: ReturnType<typeof createArcWalletClient>,
  exchangeAddress: Hex,
  account: NonNullable<ReturnType<typeof createArcWalletClient>["account"]>,
  commitment: Hex,
): Promise<void> {
  let publishedAt = await publicClient.readContract({
    address: exchangeAddress,
    abi: arenaExchangeAbi,
    functionName: "publishedDataCommitments",
    args: [commitment],
  });
  if (publishedAt === 0n) {
    const simulation = await publicClient.simulateContract({
      account,
      address: exchangeAddress,
      abi: arenaExchangeAbi,
      functionName: "publishDataCommitment",
      args: [commitment],
    });
    const hash = await walletClient.writeContract(simulation.request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 30_000 });
    if (receipt.status !== "success") throw new Error(`commitment_transaction_reverted:${hash}`);
    publishedAt = receipt.blockNumber;
  }
  const deadline = Date.now() + 30_000;
  while (await publicClient.getBlockNumber() <= publishedAt) {
    if (Date.now() >= deadline) throw new Error("commitment_prior_block_timeout");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const batchStatusEvent = parseAbiItem(
  "event BatchStatusChanged(bytes32 indexed batchId, bytes32 indexed marketId, uint64 indexed sequence, uint8 status)",
);

function hashPair(left: Hex, right: Hex): Hex {
  return keccak256(concatHex(left.toLowerCase() <= right.toLowerCase() ? [left, right] : [right, left]));
}

function merkleTree(leaves: Hex[]): { root: Hex; proofs: Hex[][] } {
  if (!leaves.length) throw new Error("empty_onchain_match_tree");
  const layers: Hex[][] = [[...leaves]];
  while (layers[layers.length - 1]!.length > 1) {
    const current = layers[layers.length - 1]!;
    const next: Hex[] = [];
    for (let index = 0; index < current.length; index += 2) {
      next.push(hashPair(current[index]!, current[index + 1] ?? current[index]!));
    }
    layers.push(next);
  }
  const proofs = leaves.map((_leaf, leafIndex) => {
    const proof: Hex[] = [];
    let index = leafIndex;
    for (let layer = 0; layer < layers.length - 1; layer += 1) {
      const values = layers[layer]!;
      const sibling = index ^ 1;
      proof.push(values[sibling] ?? values[index]!);
      index = Math.floor(index / 2);
    }
    return proof;
  });
  return { root: layers[layers.length - 1]![0]!, proofs };
}

async function latestBatchStatus(
  publicClient: ReturnType<typeof createArcPublicClient>,
  exchangeAddress: Hex,
  batchId: Hex,
  fromBlock: bigint,
): Promise<number> {
  const logs = await publicClient.getLogs({
    address: exchangeAddress,
    event: batchStatusEvent,
    args: { batchId },
    fromBlock,
    toBlock: "latest",
  });
  return logs.length ? Number(logs[logs.length - 1]!.args.status) : 0;
}

async function sendChecked(
  publicClient: ReturnType<typeof createArcPublicClient>,
  walletClient: ReturnType<typeof createArcWalletClient>,
  request: Parameters<typeof walletClient.writeContract>[0],
): Promise<Hex> {
  const hash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 30_000 });
  if (receipt.status !== "success") throw new Error(`transaction_reverted:${hash}`);
  return hash;
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

async function projectOrderChainActiveRecord(
  db: DatabaseClient,
  orderHash: Hex,
  txHash?: Hex,
): Promise<string | undefined> {
  const updated = await db.query<{ status: string }>(
    `UPDATE arc_orders
        SET status = CASE WHEN status = 'CANCEL_PENDING' THEN status ELSE 'ACTIVE' END,
            tx_hash = COALESCE($2, tx_hash), updated_at = clock_timestamp()
      WHERE order_hash = $1 AND status IN ('QUEUED','SUBMITTED','ACTIVE','CANCEL_PENDING','REJECTED')
      RETURNING status`,
    [orderHash, txHash ?? null],
  );
  await db.query(
    `UPDATE arc_nonce_claims SET state = 'CHAIN_ACTIVE', updated_at = clock_timestamp()
      WHERE namespace = 'ORDER' AND digest = $1 AND state = 'ACCEPTED'`,
    [orderHash],
  );
  await appendOrderEvent(db, orderHash, "ORDER_CHAIN_ACTIVE", { status: "ACTIVE" });
  return updated.rows[0]?.status;
}

async function projectOrderChainActive(
  db: Database,
  config: ArcConfig,
  orderHash: Hex,
  txHash?: Hex,
): Promise<void> {
  const client = await db.connect();
  let status: string | undefined;
  try {
    await client.query("BEGIN");
    status = await projectOrderChainActiveRecord(client, orderHash, txHash);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  if (status === "ACTIVE") await assignActiveOrderToBatch(db, config, orderHash);
}

async function projectOrderCancelledRecord(db: DatabaseClient, orderHash: Hex): Promise<void> {
  const current = await db.query<{ assigned_batch_id: Hex | null }>(
    "SELECT assigned_batch_id FROM arc_orders WHERE order_hash = $1 FOR UPDATE",
    [orderHash],
  );
  const batchId = current.rows[0]?.assigned_batch_id;
  if (batchId) {
    await db.query(
      `UPDATE arc_batch_orders SET released_at = clock_timestamp()
        WHERE batch_id = $1 AND order_hash = $2 AND released_at IS NULL`,
      [batchId, orderHash],
    );
  }
  await db.query(
    `UPDATE arc_orders SET status = 'CANCELLED', match_job_id = NULL,
            assigned_batch_id = NULL, updated_at = clock_timestamp()
      WHERE order_hash = $1`,
    [orderHash],
  );
  await db.query(
    `UPDATE arc_nonce_claims SET state = 'CONSUMED', updated_at = clock_timestamp()
      WHERE namespace = 'CANCEL'
        AND digest = (SELECT cancellation_digest FROM arc_orders WHERE order_hash = $1)
        AND state IN ('ACCEPTED','CHAIN_ACTIVE')`,
    [orderHash],
  );
  await appendOrderEvent(db, orderHash, "ORDER_CANCELLED", { status: "CANCELLED" });
}

async function projectOrderCancelled(db: Database, orderHash: Hex): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await projectOrderCancelledRecord(client, orderHash);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function rejectUnsubmittedOrder(db: Database, orderHash: Hex, reason: string): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE arc_orders SET status = 'REJECTED', updated_at = clock_timestamp()
        WHERE order_hash = $1 AND status IN ('QUEUED','SUBMITTED')`,
      [orderHash],
    );
    if ((updated.rowCount ?? 0) > 0) {
      await client.query(
        `UPDATE arc_nonce_claims SET state = 'REJECTED', updated_at = clock_timestamp()
          WHERE namespace = 'ORDER' AND digest = $1 AND state = 'ACCEPTED'`,
        [orderHash],
      );
      await appendOrderEvent(client, orderHash, "ORDER_REJECTED", { reason: reason.slice(0, 256) });
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
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

async function executePersistedBatch(
  job: ArcJob,
  config: ArcConfig,
  db: Database,
  logger: Logger,
): Promise<Hex | null> {
  if (!config.exchangeAddress) throw new Error("exchange_not_configured");
  const payload = ExecuteBatchPayload.parse(job.payload);
  const committed = await db.query<{ result_hash: string; status: string }>(
    "SELECT result_hash, status FROM arc_batches WHERE batch_id = $1 AND fencing_token = $2",
    [payload.batchId, payload.fencingToken],
  );
  const batchState = committed.rows[0];
  if (batchState?.result_hash.toLowerCase() !== payload.resultHash.toLowerCase()) {
    throw new Error("batch_result_commitment_mismatch");
  }
  if (batchState.status === "EXECUTED") {
    logger.warn({ batchId: payload.batchId, jobId: job.id }, "arc_batch_job_recovered_after_finalization");
    return null;
  }
  if (batchState.status !== "EXECUTING") throw new Error(`batch_not_executable:${batchState.status}`);
  const publicClient = createArcPublicClient(config);
  const walletClient = createArcWalletClient(config, config.sequencerPrivateKey);
  const account = walletClient.account;
  if (!account) throw new Error("sequencer_account_unavailable");
  const chunks = await loadPendingBatchChunks(db, payload.batchId as Hex, BigInt(payload.fencingToken));
  if (chunks.length > 1 || (chunks[0] && chunks[0].chunkIndex !== 0)) {
    throw new Error("non_atomic_batch_execution_rejected");
  }
  const chunk = chunks[0];
  if (!chunk) throw new Error("batch_chunk_missing");
  const publication = await db.query<{
    order_root: Hex;
    bundle_hash: Hex;
    chain_batch_id: Hex | null;
    chain_sequence: string | null;
    chain_prior_root: Hex | null;
  }>(
    `SELECT p.order_root, p.bundle_hash, b.chain_batch_id, b.chain_sequence::text, b.chain_prior_root
       FROM arc_batch_publications p JOIN arc_batches b ON b.batch_id = p.batch_id
      WHERE p.batch_id = $1`,
    [payload.batchId],
  );
  const published = publication.rows[0];
  if (!published) throw new Error("batch_publication_missing");

  const sequence = published.chain_sequence === null
    ? await publicClient.readContract({
      address: config.exchangeAddress, abi: arenaExchangeAbi, functionName: "nextBatchSequence", args: [chunk.marketId],
    })
    : BigInt(published.chain_sequence);
  const priorRoot = published.chain_prior_root ?? await publicClient.readContract({
    address: config.exchangeAddress, abi: arenaExchangeAbi, functionName: "lastFinalizedLedgerRoot", args: [chunk.marketId],
  });
  const derivedChainBatchId = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "bytes32" }],
    [chunk.marketId, sequence, priorRoot, published.bundle_hash],
  ));
  const chainBatchId = published.chain_batch_id ?? derivedChainBatchId;
  if (chainBatchId.toLowerCase() !== derivedChainBatchId.toLowerCase()) throw new Error("persisted_chain_batch_identity_mismatch");
  if (published.chain_batch_id === null) {
    const persisted = await db.query(
      `UPDATE arc_batches SET chain_batch_id = $2, chain_sequence = $3, chain_prior_root = $4,
              chain_data_commitment = $5, updated_at = clock_timestamp()
        WHERE batch_id = $1 AND chain_batch_id IS NULL`,
      [payload.batchId, chainBatchId, sequence.toString(), priorRoot, published.bundle_hash],
    );
    if ((persisted.rowCount ?? 0) !== 1) throw new Error("chain_batch_identity_persistence_race");
  }
  const matches = chunk.fills.map((fill) => ({
    buyOrderHash: fill.buyOrderHash,
    sellOrderHash: fill.sellOrderHash,
    quantity: fill.quantity,
  }));
  const leaves = matches.map((matched, index) => keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint128" }],
    [chainBatchId, index, matched.buyOrderHash, matched.sellOrderHash, matched.quantity],
  )));
  const tree = merkleTree(leaves);
  const feeBps = BigInt(await publicClient.readContract({
    address: config.exchangeAddress, abi: arenaExchangeAbi, functionName: "feeBps",
  }));
  let expectedDebits = 0n;
  let expectedCredits = 0n;
  let expectedFees = 0n;
  let expectedClaimAtoms = 0n;
  let expectedLedgerRoot = priorRoot;
  for (let index = 0; index < chunk.fills.length; index += 1) {
    const fill = chunk.fills[index]!;
    const buy = await publicClient.readContract({
      address: config.exchangeAddress, abi: arenaExchangeAbi, functionName: "getOrder", args: [fill.buyOrderHash],
    });
    const reserveBefore = (fill.buyFilledBefore * buy.order.pricePpm + 999_999n) / 1_000_000n;
    const reserveAfter = ((fill.buyFilledBefore + fill.quantity) * buy.order.pricePpm + 999_999n) / 1_000_000n;
    const debit = reserveAfter - reserveBefore;
    const quote = fill.quantity * chunk.clearingPricePpm / 1_000_000n;
    const fee = quote * feeBps / 10_000n;
    if (quote === 0n || debit < quote || quote < fee) throw new Error("invalid_batch_conservation_inputs");
    const credit = debit - fee;
    expectedDebits += debit;
    expectedCredits += credit;
    expectedFees += fee;
    expectedClaimAtoms += fill.quantity;
    expectedLedgerRoot = keccak256(encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint128" }],
      [expectedLedgerRoot, leaves[index]!, debit, credit, fee, fill.quantity],
    ));
  }
  await db.query(
    `UPDATE arc_batches SET chain_match_root = $2, chain_expected_ledger_root = $3,
            updated_at = clock_timestamp()
      WHERE batch_id = $1 AND chain_batch_id = $4`,
    [payload.batchId, tree.root, expectedLedgerRoot, chainBatchId],
  );

  await markBatchChunk(db, chunk.batchId, chunk.chunkIndex, "RUNNING");
  let lastHash: Hex | null = null;
  try {
    await ensureLegacyBatchCommitment(publicClient, walletClient, config.exchangeAddress, account, published.bundle_hash);
    const commitmentBlock = await publicClient.readContract({
      address: config.exchangeAddress, abi: arenaExchangeAbi, functionName: "publishedDataCommitments", args: [published.bundle_hash],
    });
    let status = await latestBatchStatus(publicClient, config.exchangeAddress, chainBatchId, commitmentBlock);
    if (status === 0) {
      const active = await publicClient.readContract({
        address: config.exchangeAddress, abi: arenaExchangeAbi, functionName: "activeBatchByMarket", args: [chunk.marketId],
      });
      if (active !== `0x${"00".repeat(32)}` && active.toLowerCase() !== chainBatchId.toLowerCase()) {
        throw new Error("conflicting_active_chain_batch");
      }
      const simulation = await publicClient.simulateContract({
        account, address: config.exchangeAddress, abi: arenaExchangeAbi, functionName: "openBatch",
        args: [chunk.marketId, sequence, priorRoot, published.bundle_hash],
      });
      lastHash = await sendChecked(publicClient, walletClient, simulation.request);
      status = 1;
    }
    if (status === 1) {
      const simulation = await publicClient.simulateContract({
        account, address: config.exchangeAddress, abi: arenaExchangeAbi, functionName: "sealBatch",
        args: [chainBatchId, published.order_root],
      });
      lastHash = await sendChecked(publicClient, walletClient, simulation.request);
      status = 2;
    }
    if (status === 2) {
      const simulation = await publicClient.simulateContract({
        account, address: config.exchangeAddress, abi: arenaExchangeAbi, functionName: "clearBatch",
        args: [
          chainBatchId, chunk.outcome, chunk.clearingPricePpm, tree.root, matches.length,
          expectedDebits, expectedCredits, expectedFees, expectedClaimAtoms, expectedLedgerRoot,
        ],
      });
      lastHash = await sendChecked(publicClient, walletClient, simulation.request);
      status = 3;
    }
    if (status === 3) {
      const simulation = await publicClient.simulateContract({
        account, address: config.exchangeAddress, abi: arenaExchangeAbi, functionName: "commitBatch", args: [chainBatchId],
      });
      lastHash = await sendChecked(publicClient, walletClient, simulation.request);
      status = 4;
    }
    if (status !== 4 && status !== 5 && status !== 6) throw new Error(`unexpected_chain_batch_status:${status}`);
    for (let index = 0; index < matches.length; index += 1) {
      const applied = await publicClient.readContract({
        address: config.exchangeAddress, abi: arenaExchangeAbi, functionName: "appliedBatchLeaves", args: [chainBatchId, index],
      });
      if (applied !== `0x${"00".repeat(32)}`) {
        if (applied.toLowerCase() !== leaves[index]!.toLowerCase()) throw new Error("conflicting_applied_batch_leaf");
        continue;
      }
      const simulation = await publicClient.simulateContract({
        account, address: config.exchangeAddress, abi: arenaExchangeAbi, functionName: "applyBatchMatch",
        args: [chainBatchId, index, matches[index]!, tree.proofs[index]!],
      });
      lastHash = await sendChecked(publicClient, walletClient, simulation.request);
    }
    const finalizedSequence = await publicClient.readContract({
      address: config.exchangeAddress, abi: arenaExchangeAbi, functionName: "nextBatchSequence", args: [chunk.marketId],
    });
    if (finalizedSequence === sequence) {
      const simulation = await publicClient.simulateContract({
        account, address: config.exchangeAddress, abi: arenaExchangeAbi, functionName: "finalizeBatch", args: [chainBatchId],
      });
      lastHash = await sendChecked(publicClient, walletClient, simulation.request);
    } else if (finalizedSequence !== sequence + 1n) {
      throw new Error("chain_batch_sequence_advanced_unexpectedly");
    }
    const finalizedRoot = await publicClient.readContract({
      address: config.exchangeAddress, abi: arenaExchangeAbi, functionName: "lastFinalizedLedgerRoot", args: [chunk.marketId],
    });
    if (finalizedRoot.toLowerCase() !== expectedLedgerRoot.toLowerCase()) throw new Error("finalized_ledger_root_mismatch");
    await markBatchChunk(db, chunk.batchId, chunk.chunkIndex, "SUCCEEDED", lastHash ?? undefined);
    logger.info({ batchId: chunk.batchId, chainBatchId, txHash: lastHash }, "arc_restartable_batch_finalized");
  } catch (error) {
    await markBatchChunk(db, chunk.batchId, chunk.chunkIndex, "FAILED", undefined, errorMessage(error));
    throw error;
  }

  const active = await finalizeExecutedBatch(db, payload.batchId as Hex, job.id);
  for (const orderHash of active) await assignActiveOrderToBatch(db, config, orderHash);
  return lastHash;
}

async function reconcileFailedBatch(
  db: Database,
  config: ArcConfig,
  job: ArcJob,
  payload: z.infer<typeof ExecuteBatchPayload>,
  reason: string,
): Promise<void> {
  if (!config.exchangeAddress) throw new Error("exchange_not_configured");
  const orders = await db.query<{ order_hash: Hex }>(
    `SELECT order_hash FROM arc_orders
      WHERE assigned_batch_id = $1 AND match_job_id = $2 ORDER BY order_hash`,
    [payload.batchId, job.id],
  );
  const publicClient = createArcPublicClient(config);
  const chainStates = await Promise.all(orders.rows.map(async ({ order_hash: orderHash }) => {
    const stored = await publicClient.readContract({
      address: config.exchangeAddress!,
      abi: arenaExchangeAbi,
      functionName: "getOrder",
      args: [orderHash],
    });
    const status = Number(stored.status);
    if (status < 1 || status > 3) throw new Error(`batch_order_chain_state_invalid:${orderHash}:${status}`);
    return {
      orderHash,
      status: (["", "ACTIVE", "FILLED", "CANCELLED"] as const)[status] as "ACTIVE" | "FILLED" | "CANCELLED",
      filledQuantity: stored.filledQuantity,
    };
  }));
  const active = await failAndReleaseBatch(
    db,
    payload.batchId as Hex,
    BigInt(payload.fencingToken),
    job.id,
    chainStates,
    reason,
  );
  for (const orderHash of active) await assignActiveOrderToBatch(db, config, orderHash);
}

async function sendContractTransaction(
  job: ArcJob,
  config: ArcConfig,
  db: Database,
  logger: Logger,
): Promise<Hex | null> {
  if (!config.exchangeAddress) throw new Error("exchange_not_configured");
  if (job.kind === "EXECUTE_BATCH") return executePersistedBatch(job, config, db, logger);
  const publicClient = createArcPublicClient(config);
  const signerKey = job.kind === "CREATE_MARKET"
    ? config.upgradeMultisigPrivateKey
    : job.kind === "EXECUTE_MATCH"
      ? config.sequencerPrivateKey
    : job.kind === "RESOLVE_MARKET" || job.kind === "INVALIDATE_AFTER_GRACE"
      ? config.resolverPrivateKey
      : config.relayerPrivateKey;
  const walletClient = createArcWalletClient(config, signerKey);
  const account = walletClient.account;
  if (!account) throw new Error("relayer_account_unavailable");

  let hash: Hex | undefined;
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
        if (recoveredStatus === "ACTIVE") {
          await projectOrderChainActive(db, config, payload.orderHash as Hex);
        } else if (recoveredStatus === "CANCELLED") {
          await projectOrderCancelled(db, payload.orderHash as Hex);
        } else {
          await db.query(
            "UPDATE arc_orders SET status = $2, updated_at = now() WHERE order_hash = $1",
            [payload.orderHash, recoveredStatus],
          );
        }
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
    case "CANCEL_ORDER": {
      const payload = CancelOrderPayload.parse(job.payload);
      const stored = await publicClient.readContract({
        address: config.exchangeAddress,
        abi: arenaExchangeAbi,
        functionName: "getOrder",
        args: [payload.cancellation.orderHash as Hex],
      });
      if (Number(stored.status) === 3) {
        await projectOrderCancelled(db, payload.cancellation.orderHash as Hex);
        logger.warn({ jobId: job.id, orderHash: payload.cancellation.orderHash }, "arc_job_recovered_from_chain_state");
        return null;
      }
      if (Number(stored.status) === 0) throw new Error("cancel_order_waiting_for_chain_activation");
      if (Number(stored.status) === 2) throw new Error("cancel_order_already_filled");
      if (Number(stored.status) !== 1) throw new Error("cancel_order_not_active");
      const simulation = await publicClient.simulateContract({
        account,
        address: config.exchangeAddress,
        abi: arenaExchangeAbi,
        functionName: "cancelOrderBySig",
        args: [{
          maker: getAddress(payload.cancellation.maker),
          orderHash: payload.cancellation.orderHash as Hex,
          nonce: BigInt(payload.cancellation.nonce),
          deadline: BigInt(payload.cancellation.deadline),
        }, payload.signature as Hex],
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
      const matches = [{
        buyOrderHash: payload.buyOrderHash as Hex,
        sellOrderHash: payload.sellOrderHash as Hex,
        quantity: BigInt(payload.quantity),
      }];
      const commitment = legacyBatchCommitment(
        payload.marketId as Hex,
        payload.outcome,
        BigInt(payload.clearingPricePpm),
        matches,
      );
      await ensureLegacyBatchCommitment(publicClient, walletClient, config.exchangeAddress, account, commitment);
      const simulation = await publicClient.simulateContract({
        account,
        address: config.exchangeAddress,
        abi: arenaExchangeAbi,
        functionName: "executeBatch",
        args: [
          payload.marketId as Hex,
          payload.outcome,
          BigInt(payload.clearingPricePpm),
          matches,
        ],
      });
      hash = await walletClient.writeContract(simulation.request);
      break;
    }
    case "CREATE_MARKET": {
      const payload = CreateMarketPayload.parse(job.payload);
      const qualified = await db.query<{
        primary_adapter_id: string | null;
        witness_adapter_id: string | null;
        witness_qualified_at: Date | null;
        witness_qualification_hash: Hex | null;
      }>(
        `SELECT primary_adapter_id, witness_adapter_id, witness_qualified_at, witness_qualification_hash
           FROM arc_markets WHERE market_id = $1`,
        [payload.marketId],
      );
      const binding = qualified.rows[0];
      if (!binding
          || binding.primary_adapter_id !== ORACLE_ADAPTERS.TXLINE_V1
          || binding.witness_adapter_id !== ORACLE_ADAPTERS.SPORTMONKS_V1
          || !binding.witness_qualified_at
          || !binding.witness_qualification_hash) {
        throw new Error("oracle_witness_not_qualified");
      }
      const market = await publicClient.readContract({
        address: config.exchangeAddress,
        abi: arenaExchangeAbi,
        functionName: "markets",
        args: [payload.marketId as Hex],
      });
      if (Number(market[5]) !== 0) {
        if (
          market[0].toLowerCase() !== payload.specHash.toLowerCase()
          || market[1].toLowerCase() !== payload.externalIdHash.toLowerCase()
          || Number(market[4]) !== payload.outcomeCount
          || market[3] !== BigInt(payload.closeTime)
        ) throw new Error("market_id_conflicts_with_onchain_state");
        await db.query(
          "UPDATE arc_markets SET status = $2, updated_at = now() WHERE market_id = $1",
          [payload.marketId, Number(market[5]) === 1 ? "OPEN" : Number(market[5]) === 2 ? "RESOLVED" : "INVALID"],
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
          payload.specHash as Hex,
          payload.externalIdHash as Hex,
          payload.outcomeCount,
          BigInt(payload.closeTime),
          {
            primarySourceId: payload.resolutionRule.primarySourceId as Hex,
            witnessSourceId: payload.resolutionRule.witnessSourceId as Hex,
            sourceEventId: payload.resolutionRule.sourceEventId as Hex,
            primarySigner: getAddress(payload.resolutionRule.primarySigner),
            witnessSigner: getAddress(payload.resolutionRule.witnessSigner),
            maxReportAgeSeconds: BigInt(payload.resolutionRule.maxReportAgeSeconds),
            maxSourceTimestampSkewSeconds: BigInt(payload.resolutionRule.maxSourceTimestampSkewSeconds),
            graceSeconds: BigInt(payload.resolutionRule.graceSeconds),
          },
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
      if (Number(market[5]) === 2 || Number(market[5]) === 3) {
        await db.query(
          "UPDATE arc_markets SET status = $2, winning_outcome = $3, updated_at = now() WHERE market_id = $1",
          [payload.marketId, Number(market[5]) === 2 ? "RESOLVED" : "INVALID", Number(market[5]) === 2 ? Number(market[6]) : null],
        );
        logger.warn({ jobId: job.id, marketId: payload.marketId }, "arc_job_recovered_from_chain_state");
        return null;
      }
      const report = (value: z.infer<typeof ResolutionReportPayload>) => ({
        sourceId: value.sourceId as Hex,
        sourceEventId: value.sourceEventId as Hex,
        observedAt: BigInt(value.observedAt),
        publishedAt: BigInt(value.publishedAt),
        finalResult: value.finalResult,
        normalizedOutcome: value.normalizedOutcome,
        rawPayloadHash: value.rawPayloadHash as Hex,
        signatureEvidence: value.signatureEvidence as Hex,
      });
      const simulation = await publicClient.simulateContract({
        account,
        address: config.exchangeAddress,
        abi: arenaExchangeAbi,
        functionName: "resolveMarket",
        args: [payload.marketId as Hex, report(payload.primary), report(payload.witness)],
      });
      hash = await walletClient.writeContract(simulation.request);
      break;
    }
    case "INVALIDATE_AFTER_GRACE": {
      const payload = InvalidateMarketPayload.parse(job.payload);
      const market = await publicClient.readContract({
        address: config.exchangeAddress,
        abi: arenaExchangeAbi,
        functionName: "markets",
        args: [payload.marketId as Hex],
      });
      if (Number(market[5]) === 3) {
        await db.query(
          "UPDATE arc_markets SET status = 'INVALID', updated_at = now() WHERE market_id = $1",
          [payload.marketId],
        );
        logger.warn({ jobId: job.id, marketId: payload.marketId }, "arc_job_recovered_from_chain_state");
        return null;
      }
      if (Number(market[5]) === 2) throw new Error("market_already_resolved");
      const simulation = await publicClient.simulateContract({
        account,
        address: config.exchangeAddress,
        abi: arenaExchangeAbi,
        functionName: "invalidateAfterGrace",
        args: [payload.marketId as Hex],
      });
      hash = await walletClient.writeContract(simulation.request);
      break;
    }
  }

  if (!hash) throw new Error("transaction_not_created");
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 30_000 });
  if (receipt.status !== "success") throw new Error(`transaction_reverted:${hash}`);
  logger.info({ jobId: job.id, kind: job.kind, txHash: hash, explorerUrl: transactionUrl(hash) }, "arc_job_transaction_confirmed");

  if (job.kind === "SUBMIT_ORDER") {
    const payload = SubmitOrderPayload.parse(job.payload);
    await projectOrderChainActive(db, config, payload.orderHash as Hex, hash);
  } else if (job.kind === "CANCEL_ORDER") {
    const payload = CancelOrderPayload.parse(job.payload);
    await projectOrderCancelled(db, payload.cancellation.orderHash as Hex);
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
    const market = await publicClient.readContract({
      address: config.exchangeAddress,
      abi: arenaExchangeAbi,
      functionName: "markets",
      args: [payload.marketId as Hex],
    });
    const status = Number(market[5]);
    if (status !== 2 && status !== 3) throw new Error("resolution_not_terminal_after_confirmation");
    await db.query(
      `UPDATE arc_markets SET status = $2, winning_outcome = $3,
       primary_report = $4::jsonb, witness_report = $5::jsonb,
       resolution_tx_hash = $6, updated_at = now() WHERE market_id = $1`,
      [
        payload.marketId,
        status === 2 ? "RESOLVED" : "INVALID",
        status === 2 ? Number(market[6]) : null,
        JSON.stringify(payload.primary),
        JSON.stringify(payload.witness),
        hash,
      ],
    );
    const storedReports = receipt.logs.flatMap((log) => {
      try {
        const decoded = decodeEventLog({ abi: arenaExchangeAbi, data: log.data, topics: log.topics });
        return decoded.eventName === "ResolutionReportStored"
          ? [decoded.args as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    });
    if (storedReports.length !== 2) throw new Error("resolution_report_events_missing");
    for (const [sourceIndex, report] of [payload.primary, payload.witness].entries()) {
      const event = storedReports.find((entry) => String(entry.sourceId).toLowerCase() === report.sourceId.toLowerCase());
      if (!event) throw new Error("resolution_report_event_source_mismatch");
      await db.query(
        `INSERT INTO arc_resolution_reports(
           report_digest, market_id, source_index, source_id, source_event_id, observed_at,
           published_at, final_result, normalized_outcome, raw_payload_hash, signature_evidence,
           transaction_hash
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (report_digest) DO NOTHING`,
        [
          event.reportDigest,
          payload.marketId,
          sourceIndex,
          report.sourceId,
          report.sourceEventId,
          report.observedAt,
          report.publishedAt,
          report.finalResult,
          report.normalizedOutcome,
          report.rawPayloadHash,
          report.signatureEvidence,
          hash,
        ],
      );
    }
    await db.query(
      `UPDATE arc_markets SET primary_report_digest = $2, witness_report_digest = $3 WHERE market_id = $1`,
      [
        payload.marketId,
        storedReports.find((entry) => String(entry.sourceId).toLowerCase() === payload.primary.sourceId.toLowerCase())?.reportDigest,
        storedReports.find((entry) => String(entry.sourceId).toLowerCase() === payload.witness.sourceId.toLowerCase())?.reportDigest,
      ],
    );
  } else if (job.kind === "INVALIDATE_AFTER_GRACE") {
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
        if (config.clearingMode === "batch_v1") {
          const sealed = await sealNextBatch(db, config, workerId);
          if (sealed) {
            for (const orderHash of sealed.releasedOrderHashes) {
              await assignActiveOrderToBatch(db, config, orderHash);
            }
            continue;
          }
        } else if (await scheduleCrossingMatch(db)) {
          continue;
        }
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
        const message = errorMessage(error);
        const dead = await failJob(db, job, message).catch((failure) => {
          logger.fatal({ err: failure, jobId: job?.id }, "arc_job_failure_state_write_failed");
          return false;
        });
        if (dead && job.kind === "EXECUTE_MATCH") {
          await db.query(
            `UPDATE arc_orders SET status = 'ACTIVE', match_job_id = NULL, updated_at = now()
             WHERE match_job_id = $1 AND status = 'MATCHING'`,
            [job.id],
          ).catch((failure) => logger.error({ err: failure, jobId: job?.id }, "arc_match_release_failed"));
        } else if (dead && job.kind === "SUBMIT_ORDER") {
          const payload = SubmitOrderPayload.safeParse(job.payload);
          if (payload.success) {
            await rejectUnsubmittedOrder(db, payload.data.orderHash as Hex, errorMessage(error)).catch((failure) =>
              logger.error({ err: failure, jobId: job?.id }, "arc_order_rejection_projection_failed"),
            );
          }
        } else if (dead && job.kind === "EXECUTE_BATCH") {
          const payload = ExecuteBatchPayload.safeParse(job.payload);
          if (payload.success) {
            const persisted = await db.query<{ chain_batch_id: string | null }>(
              "SELECT chain_batch_id FROM arc_batches WHERE batch_id = $1",
              [payload.data.batchId],
            );
            if (persisted.rows[0]?.chain_batch_id) {
              await requeueRestartableJob(db, job.id, `restartable_chain_batch:${message}`).catch((failure) =>
                logger.fatal({ err: failure, jobId: job?.id }, "arc_batch_restart_requeue_failed"),
              );
            } else {
              await reconcileFailedBatch(db, config, job, payload.data, message).catch((failure) =>
                logger.error({ err: failure, jobId: job?.id }, "arc_batch_failure_reconciliation_failed"),
              );
              await activateHalt(db, {
                haltKey: "reconciliation:batch",
                reason: "RECONCILIATION",
                detail: message,
              }).catch(() => undefined);
            }
          }
        } else if (dead && job.kind === "RESOLVE_MARKET") {
          const payload = ResolveMarketPayload.safeParse(job.payload);
          if (payload.success) {
            await db.query(
              `UPDATE arc_markets SET resolution_job_id = NULL, updated_at = now()
                WHERE market_id = $1 AND resolution_job_id = $2 AND status = 'OPEN'`,
              [payload.data.marketId, job.id],
            ).catch((failure) => logger.error({ err: failure, jobId: job?.id }, "arc_resolution_job_release_failed"));
          }
        }
        metrics.jobsProcessed.inc({ kind: job.kind, result: "failure" });
      }
      await new Promise((resolve) => setTimeout(resolve, config.jobPollIntervalMs));
    }
  }
}

async function applyIndexedEvent(
  db: DatabaseClient,
  eventName: string,
  args: Record<string, unknown>,
  txHash: Hex,
  eventKey: Hex,
): Promise<Hex | null> {
  let marketEvent: { marketId: string; eventType: string; payload: Record<string, unknown> } | null = null;
  if (eventName === "MarketCreated") {
    await db.query(
      `UPDATE arc_markets SET status = 'OPEN', spec_hash = $2, resolution_rule_hash = $3,
       create_tx_hash = COALESCE(create_tx_hash, $4), updated_at = now()
       WHERE market_id = $1`,
      [args.marketId, args.specHash, args.resolutionRuleHash, txHash],
    );
    marketEvent = {
      marketId: String(args.marketId),
      eventType: "MARKET_OPENED",
      payload: {
        marketId: String(args.marketId),
        specHash: String(args.specHash),
        resolutionRuleHash: String(args.resolutionRuleHash),
        status: "OPEN",
        transactionHash: txHash,
      },
    };
  } else if (eventName === "MarketResolved") {
    await db.query(
      `UPDATE arc_markets SET status = 'RESOLVED', winning_outcome = $2,
       resolution_tx_hash = COALESCE(resolution_tx_hash, $3), updated_at = now() WHERE market_id = $1`,
      [args.marketId, Number(args.winningOutcome), txHash],
    );
    marketEvent = {
      marketId: String(args.marketId),
      eventType: "MARKET_RESOLVED",
      payload: {
        marketId: String(args.marketId),
        status: "RESOLVED",
        winningOutcome: Number(args.winningOutcome),
        transactionHash: txHash,
      },
    };
  } else if (eventName === "MarketInvalidated") {
    await db.query(
      `UPDATE arc_markets SET status = 'INVALID', resolution_tx_hash = COALESCE(resolution_tx_hash, $2),
       updated_at = now() WHERE market_id = $1`,
      [args.marketId, txHash],
    );
    marketEvent = {
      marketId: String(args.marketId),
      eventType: "MARKET_INVALIDATED",
      payload: { marketId: String(args.marketId), status: "INVALID", transactionHash: txHash },
    };
  } else if (eventName === "OrderSubmitted") {
    const orderHash = args.orderHash as Hex;
    const status = await projectOrderChainActiveRecord(db, orderHash, txHash);
    return status === "ACTIVE" ? orderHash : null;
  } else if (eventName === "OrderCancelled") {
    await projectOrderCancelledRecord(db, args.orderHash as Hex);
  }
  if (marketEvent) {
    const hashedPayload = payloadHash(marketEvent.payload);
    await appendExchangeEvent(db, {
      topic: "MARKET",
      entityId: marketEvent.marketId,
      eventType: marketEvent.eventType,
      payload: marketEvent.payload,
      eventKey,
      payloadHash: hashedPayload,
      sourceRoot: txHash,
    });
  }
  return null;
}

async function persistLog(db: Database, config: ArcConfig, log: Log, eventName: string, args: Record<string, unknown>): Promise<void> {
  const txHash = log.transactionHash;
  const blockHash = log.blockHash;
  const blockNumber = log.blockNumber;
  if (!txHash || !blockHash || blockNumber === null || log.logIndex === null) return;
  const client = await db.connect();
  let orderToAssign: Hex | null = null;
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO arc_chain_events(tx_hash, log_index, block_number, block_hash, event_name, payload)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)
       ON CONFLICT (tx_hash, log_index) DO NOTHING`,
      [txHash, log.logIndex, blockNumber.toString(), blockHash, eventName, JSON.stringify(serialize(args))],
    );
    if ((result.rowCount ?? 0) > 0) {
      const eventKey = payloadHash({ logIndex: log.logIndex, transactionHash: txHash });
      orderToAssign = await applyIndexedEvent(client, eventName, args, txHash, eventKey);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  if (orderToAssign) await assignActiveOrderToBatch(db, config, orderToAssign);
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
    const witnessClient = createArcPublicClient({ rpcUrl: config.rpcWitnessUrl });
    let lastWitnessCheckAt = 0;
    while (!state.stopping) {
      try {
        const current = await publicClient.getBlockNumber();
        if (Date.now() - lastWitnessCheckAt >= 5_000) {
          lastWitnessCheckAt = Date.now();
          try {
            const [witnessChainId, witnessHead] = await Promise.all([
              witnessClient.getChainId(),
              witnessClient.getBlockNumber(),
            ]);
            if (witnessChainId !== config.chainId) throw new Error(`rpc_witness_chain_id_mismatch:${witnessChainId}`);
            const lag = current > witnessHead ? current - witnessHead : witnessHead - current;
            if (lag > BigInt(config.rpcMaxBlockLag)) throw new Error(`rpc_head_divergence:${lag.toString()}`);
            const common = current < witnessHead ? current : witnessHead;
            const [primaryBlock, witnessBlock] = await Promise.all([
              publicClient.getBlock({ blockNumber: common }),
              witnessClient.getBlock({ blockNumber: common }),
            ]);
            if (primaryBlock.hash !== witnessBlock.hash) throw new Error(`rpc_block_hash_divergence:${common.toString()}`);
            await recordRecoveryObservation(db, {
              haltKey: "rpc:disagreement",
              reason: "RPC",
              healthy: true,
              threshold: config.oracleRecoveryObservations,
              detail: `rpc_agreement:${common.toString()}`,
            });
          } catch (error) {
            await recordRecoveryObservation(db, {
              haltKey: "rpc:disagreement",
              reason: "RPC",
              healthy: false,
              threshold: config.oracleRecoveryObservations,
              detail: errorMessage(error),
            });
          }
        }
        state.lastRpcOkAt = new Date().toISOString();
        await recordRecoveryObservation(db, {
          haltKey: "rpc:indexer",
          reason: "RPC",
          healthy: true,
          threshold: config.oracleRecoveryObservations,
          detail: "rpc_healthy",
        });
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
              await persistLog(db, config, log, decoded.eventName, decoded.args as Record<string, unknown>);
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
        await recordRecoveryObservation(db, {
          haltKey: "rpc:indexer",
          reason: "RPC",
          healthy: false,
          threshold: config.oracleRecoveryObservations,
          detail: errorMessage(error),
        }).catch(() => undefined);
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
  if (!config.exchangeAddress) throw new Error("exchange_not_configured");
  await bindDatabaseToExchange(db, config.chainId, config.exchangeAddress);
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
      upgradeMultisig: Boolean(config.upgradeMultisigPrivateKey),
      sequencer: Boolean(config.sequencerPrivateKey),
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
    upgradeMultisig: createArcWalletClient(config, config.upgradeMultisigPrivateKey).account?.address,
    sequencer: createArcWalletClient(config, config.sequencerPrivateKey).account?.address,
    resolver: createArcWalletClient(config, config.resolverPrivateKey).account?.address,
  }, "arc_middleman_started");
  void processJobs(config, db, logger, state, metrics);
  void runIndexer(config, db, logger, state, metrics);
  void runResultWatcher(config, db, logger, state, metrics);
  void runTxlineSseWatcher(config, db, logger, state);
  void runProtocolLiquidityAgent(config, db, logger, state);
}
