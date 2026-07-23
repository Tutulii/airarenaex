import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { BATCH_POLICY_VERSION, clearUniformPriceBatch, type ClearingOrder } from "./batch-clearing.js";
import { buildPublicBatchBundle, type PublicBatchOrder } from "./batch-bundle.js";
import { cancellationCutoffMs, cancellationWindowOpen } from "./cancellation-cutoff.js";
import type { ArcConfig } from "./config.js";
import type { Database } from "./db.js";
import { appendExchangeEvent } from "./exchange-events.js";
import { enqueueJob } from "./jobs.js";
import { appendOrderEvent, canonicalJson, payloadHash } from "./order-intake.js";

export const BATCH_POLICY_HASH = keccak256(stringToHex(BATCH_POLICY_VERSION));

async function appendBatchEvent(
  db: Parameters<typeof appendExchangeEvent>[0],
  batchId: Hex,
  eventType: string,
  payload: unknown,
  sourceRoot?: Hex | null,
): Promise<void> {
  const hashedPayload = payloadHash(payload);
  const eventKey = payloadHash({ batchId: batchId.toLowerCase(), eventType, payloadHash: hashedPayload });
  await appendExchangeEvent(db, {
    topic: "BATCH",
    entityId: batchId,
    eventType,
    payload,
    eventKey,
    payloadHash: hashedPayload,
    sourceRoot: sourceRoot ?? null,
  });
}

export function deterministicBatchId(
  chainId: number,
  exchangeAddress: Address,
  marketId: Hex,
  outcome: number,
  batchStartMs: bigint,
): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: "uint256" },
      { type: "address" },
      { type: "bytes32" },
      { type: "uint8" },
      { type: "bytes32" },
      { type: "uint64" },
    ],
    [BigInt(chainId), exchangeAddress, marketId, outcome, BATCH_POLICY_HASH, batchStartMs],
  ));
}

type BatchConfig = Pick<
  ArcConfig,
  "chainId" | "exchangeAddress" | "batchIntervalMs" | "batchMaxOrders" | "batchExecutionChunkSize"
>;

export async function assignActiveOrderToBatch(
  db: Database,
  config: BatchConfig,
  orderHash: Hex,
): Promise<Hex | null> {
  if (!config.exchangeAddress) throw new Error("exchange_not_configured");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const orderResult = await client.query<{
      market_id: Hex;
      outcome: number;
      accepted_sequence: string | null;
      assigned_batch_id: Hex | null;
      status: string;
      eligible: boolean;
    }>(
      `SELECT o.market_id, o.outcome, o.accepted_sequence::text, o.assigned_batch_id, o.status,
              (o.expiry > clock_timestamp() AND m.status = 'OPEN' AND m.close_time > clock_timestamp()) AS eligible
         FROM arc_orders o JOIN arc_markets m ON m.market_id = o.market_id
        WHERE o.order_hash = $1 FOR UPDATE OF o`,
      [orderHash],
    );
    const order = orderResult.rows[0];
    if (!order || !order.eligible || order.status !== "ACTIVE" || order.assigned_batch_id || !order.accepted_sequence) {
      await client.query("COMMIT");
      return order?.assigned_batch_id ?? null;
    }
    const clock = await client.query<{ now_ms: string }>(
      "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS now_ms",
    );
    const nowMs = BigInt(clock.rows[0]!.now_ms);
    const interval = BigInt(config.batchIntervalMs);
    let batchStartMs = nowMs - (nowMs % interval);
    let batchId: Hex | null = null;
    for (let offset = 0; offset < 2; offset += 1) {
      const candidateStart = batchStartMs + BigInt(offset) * interval;
      const candidateEnd = candidateStart + interval;
      const candidateCutoff = cancellationCutoffMs(candidateEnd);
      if (!cancellationWindowOpen(nowMs, candidateCutoff)) continue;
      const candidateId = deterministicBatchId(
        config.chainId,
        config.exchangeAddress,
        order.market_id,
        order.outcome,
        candidateStart,
      );
      await client.query(
        `INSERT INTO arc_batches(
           batch_id, market_id, outcome, policy_version, policy_hash, batch_start, batch_end,
           cancellation_cutoff, status
         ) VALUES (
           $1,$2,$3,$4,$5,to_timestamp($6::numeric / 1000),to_timestamp($7::numeric / 1000),
           to_timestamp($8::numeric / 1000),'OPEN'
         )
         ON CONFLICT (batch_id) DO NOTHING`,
        [
          candidateId,
          order.market_id,
          order.outcome,
          BATCH_POLICY_VERSION,
          BATCH_POLICY_HASH,
          candidateStart.toString(),
          candidateEnd.toString(),
          candidateCutoff.toString(),
        ],
      );
      const open = await client.query<{ status: string; before_cutoff: boolean }>(
        `SELECT status, cancellation_cutoff > clock_timestamp() AS before_cutoff
           FROM arc_batches WHERE batch_id = $1 FOR UPDATE`,
        [candidateId],
      );
      if (open.rows[0]?.status !== "OPEN" || !open.rows[0].before_cutoff) continue;
      const capacity = await client.query<{ accepted: string }>(
        `SELECT count(*)::text AS accepted FROM arc_batch_orders WHERE batch_id = $1 AND released_at IS NULL`,
        [candidateId],
      );
      if (Number(capacity.rows[0]?.accepted ?? "0") < config.batchMaxOrders) {
        batchId = candidateId;
        batchStartMs = candidateStart;
        break;
      }
    }
    if (!batchId) throw new Error("batch_capacity_exhausted");

    const assigned = await client.query(
      `UPDATE arc_orders SET assigned_batch_id = $2, updated_at = now()
        WHERE order_hash = $1 AND assigned_batch_id IS NULL AND status = 'ACTIVE'`,
      [orderHash, batchId],
    );
    if ((assigned.rowCount ?? 0) !== 1) {
      await client.query("COMMIT");
      return null;
    }
    await client.query(
      `INSERT INTO arc_batch_orders(batch_id, order_hash, accepted_sequence)
       VALUES ($1,$2,$3) ON CONFLICT (batch_id, order_hash) DO NOTHING`,
      [batchId, orderHash, order.accepted_sequence],
    );
    await appendOrderEvent(client, orderHash, "ORDER_BATCH_ASSIGNED", {
      batchId,
      batchStartMs: batchStartMs.toString(),
      cancellationCutoffMs: cancellationCutoffMs(batchStartMs + interval).toString(),
      policyHash: BATCH_POLICY_HASH,
    });
    await client.query("COMMIT");
    return batchId;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

type BatchOrderRow = {
  order_hash: Hex;
  maker: string;
  side: "BUY" | "SELL";
  price_ppm: string;
  quantity: string;
  filled_quantity: string;
  expiry_unix: string;
  nonce: string;
  client_order_id: Hex;
  signature: Hex;
  accepted_sequence: string;
};

export type SealedBatch = {
  batchId: Hex;
  executionJobCreated: boolean;
  releasedOrderHashes: Hex[];
};

export async function sealNextBatch(
  db: Database,
  config: BatchConfig,
  workerId: string,
): Promise<SealedBatch | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query<{
      batch_id: Hex;
      market_id: Hex;
      outcome: number;
      fencing_token: string;
      cutoff_unix: string;
      cancellation_cutoff_ms: string;
      market_orderable: boolean;
    }>(
      `SELECT b.batch_id, b.market_id, b.outcome, b.fencing_token::text,
              floor(extract(epoch FROM b.batch_end))::bigint::text AS cutoff_unix,
              floor(extract(epoch FROM b.cancellation_cutoff) * 1000)::bigint::text AS cancellation_cutoff_ms,
              (m.status = 'OPEN' AND m.close_time > clock_timestamp()) AS market_orderable
         FROM arc_batches b JOIN arc_markets m ON m.market_id = b.market_id
        WHERE b.status = 'OPEN' AND b.batch_end <= clock_timestamp()
        ORDER BY b.batch_end, b.batch_id
        FOR UPDATE OF b SKIP LOCKED LIMIT 1`,
    );
    const batch = selected.rows[0];
    if (!batch) {
      await client.query("COMMIT");
      return null;
    }
    if (!batch.market_orderable) {
      const released = await client.query<{ order_hash: Hex }>(
        `UPDATE arc_orders SET assigned_batch_id = NULL, updated_at = clock_timestamp()
          WHERE assigned_batch_id = $1 AND status = 'ACTIVE' RETURNING order_hash`,
        [batch.batch_id],
      );
      await client.query(
        `UPDATE arc_batch_orders SET released_at = clock_timestamp()
          WHERE batch_id = $1 AND released_at IS NULL`,
        [batch.batch_id],
      );
      await client.query(
        `UPDATE arc_batches SET status = 'NO_CROSS', executed_at = clock_timestamp(),
                updated_at = clock_timestamp() WHERE batch_id = $1`,
        [batch.batch_id],
      );
      for (const row of released.rows) {
        await appendOrderEvent(client, row.order_hash, "ORDER_BATCH_RELEASED", {
          batchId: batch.batch_id,
          reason: "MARKET_CLOSED",
        });
      }
      await appendBatchEvent(client, batch.batch_id, "BATCH_ABORTED", { reason: "MARKET_CLOSED" });
      await client.query("COMMIT");
      return {
        batchId: batch.batch_id,
        executionJobCreated: false,
        releasedOrderHashes: released.rows.map((row) => row.order_hash),
      };
    }
    const nextFence = BigInt(batch.fencing_token) + 1n;
    const leased = await client.query(
      `UPDATE arc_batches
          SET status = 'SEALED', fencing_token = $2, lease_owner = $3,
              lease_expires_at = clock_timestamp() + interval '2 minutes', sealed_at = clock_timestamp(),
              updated_at = clock_timestamp()
        WHERE batch_id = $1 AND status = 'OPEN' AND fencing_token = $4`,
      [batch.batch_id, nextFence.toString(), workerId, batch.fencing_token],
    );
    if ((leased.rowCount ?? 0) !== 1) throw new Error("batch_fencing_conflict");

    const rows = await client.query<BatchOrderRow>(
      `SELECT o.order_hash, o.maker, o.side, o.price_ppm::text, o.quantity::text,
              o.filled_quantity::text, floor(extract(epoch FROM o.expiry))::bigint::text AS expiry_unix,
              o.nonce::text, o.client_order_id, o.signature, o.accepted_sequence::text
         FROM arc_batch_orders bo
         JOIN arc_orders o ON o.order_hash = bo.order_hash
        WHERE bo.batch_id = $1 AND bo.released_at IS NULL
          AND o.assigned_batch_id = $1 AND o.status = 'ACTIVE'
        ORDER BY o.order_hash
        FOR UPDATE OF o`,
      [batch.batch_id],
    );
    if (rows.rows.length > config.batchMaxOrders) throw new Error("sealed_batch_order_limit_exceeded");
    const clearingOrders: ClearingOrder[] = rows.rows.map((row) => ({
      orderHash: row.order_hash,
      maker: getAddress(row.maker),
      side: row.side,
      pricePpm: BigInt(row.price_ppm),
      quantity: BigInt(row.quantity),
      filledQuantity: BigInt(row.filled_quantity),
      expiryUnix: BigInt(row.expiry_unix),
    }));
    const result = clearUniformPriceBatch(clearingOrders, BigInt(batch.cutoff_unix), { batchId: batch.batch_id });
    if (result.fills.length > config.batchExecutionChunkSize) {
      throw new Error("batch_atomic_fill_limit_exceeded");
    }
    const sealedInput = result.orderedEligibleOrders.map((order) => ({
      ...order,
      expiryUnix: order.expiryUnix.toString(),
      filledQuantity: order.filledQuantity.toString(),
      pricePpm: order.pricePpm.toString(),
      quantity: order.quantity.toString(),
    }));
    const resultJson = {
      clearingPricePpm: result.clearingPricePpm?.toString() ?? null,
      executableQuantity: result.executableQuantity.toString(),
      fills: result.fills.map((fill) => ({ ...fill, quantity: fill.quantity.toString() })),
      inputRoot: result.inputRoot,
      resultHash: result.resultHash,
    };
    if (!config.exchangeAddress) throw new Error("exchange_not_configured");
    const publicOrders: PublicBatchOrder[] = rows.rows.map((row) => ({
      orderHash: row.order_hash,
      maker: getAddress(row.maker),
      side: row.side,
      pricePpm: BigInt(row.price_ppm),
      quantity: BigInt(row.quantity),
      filledQuantity: BigInt(row.filled_quantity),
      expiryUnix: BigInt(row.expiry_unix),
      nonce: BigInt(row.nonce),
      clientOrderId: row.client_order_id,
      signature: row.signature,
      acceptedSequence: BigInt(row.accepted_sequence),
    }));
    const bundle = buildPublicBatchBundle({
      batchId: batch.batch_id,
      chainId: config.chainId,
      exchangeAddress: config.exchangeAddress,
      marketId: batch.market_id,
      outcome: batch.outcome,
      cutoffUnix: BigInt(batch.cutoff_unix),
      cancellationCutoffUnixMs: BigInt(batch.cancellation_cutoff_ms),
      policyHash: BATCH_POLICY_HASH,
      orders: publicOrders,
    });
    if (bundle.inputRoot !== result.inputRoot || bundle.resultHash !== result.resultHash) {
      throw new Error("batch_bundle_replay_mismatch");
    }
    await client.query(
      `UPDATE arc_batches
          SET input_root = $2, result_hash = $3, clearing_price_ppm = $4,
              executable_quantity = $5, sealed_input = $6::jsonb, result = $7::jsonb,
              updated_at = clock_timestamp()
        WHERE batch_id = $1 AND fencing_token = $8 AND lease_owner = $9`,
      [
        batch.batch_id,
        result.inputRoot,
        result.resultHash,
        result.clearingPricePpm?.toString() ?? null,
        result.executableQuantity.toString(),
        canonicalJson(sealedInput),
        canonicalJson(resultJson),
        nextFence.toString(),
        workerId,
      ],
    );
    await client.query(
      `INSERT INTO arc_batch_publications(
         batch_id, schema_version, order_root, fill_root, bundle_hash, bundle
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [
        batch.batch_id,
        bundle.schemaVersion,
        bundle.orderRoot,
        bundle.fillRoot,
        bundle.bundleHash,
        canonicalJson(bundle),
      ],
    );
    await appendBatchEvent(client, batch.batch_id, "BATCH_PUBLISHED", {
      bundleHash: bundle.bundleHash,
      executableQuantity: bundle.executableQuantity,
      fillRoot: bundle.fillRoot,
      inputRoot: bundle.inputRoot,
      orderRoot: bundle.orderRoot,
      resultHash: bundle.resultHash,
    }, bundle.bundleHash);

    const participating = new Set<string>();
    const buyFilled = new Map<string, bigint>(rows.rows.map((row) => [row.order_hash.toLowerCase(), BigInt(row.filled_quantity)]));
    const sellFilled = new Map(buyFilled);
    for (let index = 0; index < result.fills.length; index += 1) {
      const fill = result.fills[index]!;
      const buyKey = fill.buyOrderHash.toLowerCase();
      const sellKey = fill.sellOrderHash.toLowerCase();
      const buyBefore = buyFilled.get(buyKey) ?? 0n;
      const sellBefore = sellFilled.get(sellKey) ?? 0n;
      participating.add(buyKey);
      participating.add(sellKey);
      await client.query(
        `INSERT INTO arc_batch_fills(
           batch_id, fill_index, buy_order_hash, sell_order_hash, quantity,
           buy_filled_before, sell_filled_before, chunk_index
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          batch.batch_id,
          index,
          fill.buyOrderHash,
          fill.sellOrderHash,
          fill.quantity.toString(),
          buyBefore.toString(),
          sellBefore.toString(),
          0,
        ],
      );
      buyFilled.set(buyKey, buyBefore + fill.quantity);
      sellFilled.set(sellKey, sellBefore + fill.quantity);
    }

    const releasedOrderHashes = rows.rows
      .map((row) => row.order_hash)
      .filter((orderHash) => !participating.has(orderHash.toLowerCase()));
    for (const orderHash of rows.rows.map((row) => row.order_hash)) {
      await appendOrderEvent(client, orderHash, "ORDER_BATCH_SEALED", {
        batchId: batch.batch_id,
        fencingToken: nextFence.toString(),
        inputRoot: result.inputRoot,
        resultHash: result.resultHash,
      });
    }

    if (!result.fills.length) {
      await client.query(
        `UPDATE arc_batches SET status = 'NO_CROSS', executed_at = clock_timestamp(),
                lease_owner = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
          WHERE batch_id = $1 AND fencing_token = $2`,
        [batch.batch_id, nextFence.toString()],
      );
      await client.query(
        `UPDATE arc_orders SET assigned_batch_id = NULL, updated_at = clock_timestamp()
          WHERE assigned_batch_id = $1 AND status = 'ACTIVE'`,
        [batch.batch_id],
      );
      await client.query(
        "UPDATE arc_batch_orders SET released_at = clock_timestamp() WHERE batch_id = $1 AND released_at IS NULL",
        [batch.batch_id],
      );
      for (const orderHash of rows.rows.map((row) => row.order_hash)) {
        await appendOrderEvent(client, orderHash, "ORDER_BATCH_RELEASED", { batchId: batch.batch_id, reason: "NO_CROSS" });
      }
      await appendBatchEvent(client, batch.batch_id, "BATCH_NO_CROSS", {
        bundleHash: bundle.bundleHash,
        resultHash: result.resultHash,
      }, bundle.bundleHash);
      await client.query("COMMIT");
      return { batchId: batch.batch_id, executionJobCreated: false, releasedOrderHashes: rows.rows.map((row) => row.order_hash) };
    }

    await client.query(
      `INSERT INTO arc_batch_chunks(batch_id, chunk_index, first_fill_index, last_fill_index)
       VALUES ($1,0,0,$2)`,
      [batch.batch_id, result.fills.length - 1],
    );
    const job = await enqueueJob(
      client,
      "EXECUTE_BATCH",
      { batchId: batch.batch_id, fencingToken: nextFence.toString(), resultHash: result.resultHash },
      `execute-batch:${batch.batch_id}:${result.resultHash}`,
    );
    await appendBatchEvent(client, batch.batch_id, "BATCH_EXECUTION_QUEUED", {
      executionJobId: job.id,
      resultHash: result.resultHash,
    }, bundle.bundleHash);
    await client.query(
      `UPDATE arc_batches SET status = 'EXECUTING', execution_job_id = $2, updated_at = clock_timestamp()
        WHERE batch_id = $1 AND fencing_token = $3`,
      [batch.batch_id, job.id, nextFence.toString()],
    );
    await client.query(
      `UPDATE arc_orders SET status = 'MATCHING', match_job_id = $2, updated_at = clock_timestamp()
        WHERE assigned_batch_id = $1 AND lower(order_hash) = ANY($3::text[])`,
      [batch.batch_id, job.id, [...participating]],
    );
    if (releasedOrderHashes.length) {
      await client.query(
        `UPDATE arc_orders SET assigned_batch_id = NULL, updated_at = clock_timestamp()
          WHERE assigned_batch_id = $1 AND lower(order_hash) = ANY($2::text[])`,
        [batch.batch_id, releasedOrderHashes.map((hash) => hash.toLowerCase())],
      );
      await client.query(
        `UPDATE arc_batch_orders SET released_at = clock_timestamp()
          WHERE batch_id = $1 AND lower(order_hash) = ANY($2::text[])`,
        [batch.batch_id, releasedOrderHashes.map((hash) => hash.toLowerCase())],
      );
      for (const orderHash of releasedOrderHashes) {
        await appendOrderEvent(client, orderHash, "ORDER_BATCH_RELEASED", { batchId: batch.batch_id, reason: "NOT_ALLOCATED" });
      }
    }
    await client.query("COMMIT");
    return { batchId: batch.batch_id, executionJobCreated: job.created, releasedOrderHashes };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export type BatchExecutionChunk = {
  batchId: Hex;
  marketId: Hex;
  outcome: number;
  clearingPricePpm: bigint;
  fencingToken: bigint;
  chunkIndex: number;
  fills: Array<{
    fillIndex: number;
    buyOrderHash: Hex;
    sellOrderHash: Hex;
    quantity: bigint;
    buyFilledBefore: bigint;
    sellFilledBefore: bigint;
  }>;
};

export async function loadPendingBatchChunks(
  db: Database,
  batchId: Hex,
  fencingToken: bigint,
): Promise<BatchExecutionChunk[]> {
  const batch = await db.query<{ market_id: Hex; outcome: number; clearing_price_ppm: string; fencing_token: string; status: string }>(
    `SELECT market_id, outcome, clearing_price_ppm::text, fencing_token::text, status
       FROM arc_batches WHERE batch_id = $1`,
    [batchId],
  );
  const row = batch.rows[0];
  if (!row || row.status !== "EXECUTING" || BigInt(row.fencing_token) !== fencingToken) throw new Error("batch_execution_fence_invalid");
  const chunks = await db.query<{
    chunk_index: number;
    fill_index: number;
    buy_order_hash: Hex;
    sell_order_hash: Hex;
    quantity: string;
    buy_filled_before: string;
    sell_filled_before: string;
  }>(
    `SELECT c.chunk_index, f.fill_index, f.buy_order_hash, f.sell_order_hash, f.quantity::text,
            f.buy_filled_before::text, f.sell_filled_before::text
       FROM arc_batch_chunks c
       JOIN arc_batch_fills f ON f.batch_id = c.batch_id AND f.chunk_index = c.chunk_index
      WHERE c.batch_id = $1 AND c.status <> 'SUCCEEDED'
      ORDER BY c.chunk_index, f.fill_index`,
    [batchId],
  );
  const grouped = new Map<number, BatchExecutionChunk>();
  for (const fill of chunks.rows) {
    const chunk = grouped.get(fill.chunk_index) ?? {
      batchId,
      marketId: row.market_id,
      outcome: row.outcome,
      clearingPricePpm: BigInt(row.clearing_price_ppm),
      fencingToken,
      chunkIndex: fill.chunk_index,
      fills: [],
    };
    chunk.fills.push({
      fillIndex: fill.fill_index,
      buyOrderHash: fill.buy_order_hash,
      sellOrderHash: fill.sell_order_hash,
      quantity: BigInt(fill.quantity),
      buyFilledBefore: BigInt(fill.buy_filled_before),
      sellFilledBefore: BigInt(fill.sell_filled_before),
    });
    grouped.set(fill.chunk_index, chunk);
  }
  return [...grouped.values()].sort((left, right) => left.chunkIndex - right.chunkIndex);
}

export async function markBatchChunk(
  db: Database,
  batchId: Hex,
  chunkIndex: number,
  status: "RUNNING" | "SUCCEEDED" | "FAILED",
  txHash?: Hex,
  error?: string,
): Promise<void> {
  await db.query(
    `UPDATE arc_batch_chunks
        SET status = $3, attempts = attempts + CASE WHEN $3 = 'RUNNING' THEN 1 ELSE 0 END,
            tx_hash = COALESCE($4, tx_hash), last_error = $5, updated_at = clock_timestamp()
      WHERE batch_id = $1 AND chunk_index = $2`,
    [batchId, chunkIndex, status, txHash ?? null, error?.slice(0, 2000) ?? null],
  );
}

export async function finalizeExecutedBatch(db: Database, batchId: Hex, jobId: string): Promise<Hex[]> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ status: string }>(
      "SELECT status FROM arc_batches WHERE batch_id = $1 FOR UPDATE",
      [batchId],
    );
    if (locked.rows[0]?.status !== "EXECUTING") throw new Error("batch_not_executing");
    const pending = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM arc_batch_chunks WHERE batch_id = $1 AND status <> 'SUCCEEDED'`,
      [batchId],
    );
    if (pending.rows[0]?.count !== "0") throw new Error("batch_chunks_incomplete");
    const targets = await client.query<{ order_hash: Hex; target: string }>(
      `SELECT order_hash, max(target)::text AS target FROM (
         SELECT buy_order_hash AS order_hash, buy_filled_before + quantity AS target
           FROM arc_batch_fills WHERE batch_id = $1
         UNION ALL
         SELECT sell_order_hash AS order_hash, sell_filled_before + quantity AS target
           FROM arc_batch_fills WHERE batch_id = $1
       ) q GROUP BY order_hash ORDER BY order_hash`,
      [batchId],
    );
    const active: Hex[] = [];
    for (const target of targets.rows) {
      const updated = await client.query<{ status: string }>(
        `UPDATE arc_orders
            SET filled_quantity = GREATEST(filled_quantity, $2::numeric),
                status = CASE WHEN GREATEST(filled_quantity, $2::numeric) >= quantity THEN 'FILLED' ELSE 'ACTIVE' END,
                match_job_id = NULL, assigned_batch_id = NULL, updated_at = clock_timestamp()
          WHERE order_hash = $1 AND match_job_id = $3
          RETURNING status`,
        [target.order_hash, target.target, jobId],
      );
      const status = updated.rows[0]?.status;
      await appendOrderEvent(client, target.order_hash, status === "FILLED" ? "ORDER_FILLED" : "ORDER_BATCH_RELEASED", {
        batchId,
        filledQuantity: target.target,
      });
      if (status === "ACTIVE") active.push(target.order_hash);
    }
    await client.query(
      "UPDATE arc_batch_orders SET released_at = clock_timestamp() WHERE batch_id = $1 AND released_at IS NULL",
      [batchId],
    );
    await client.query(
      `UPDATE arc_batches SET status = 'EXECUTED', executed_at = clock_timestamp(),
              lease_owner = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
        WHERE batch_id = $1 AND status = 'EXECUTING'`,
      [batchId],
    );
    const publication = await client.query<{ bundle_hash: Hex }>(
      "SELECT bundle_hash FROM arc_batch_publications WHERE batch_id = $1",
      [batchId],
    );
    await appendBatchEvent(client, batchId, "BATCH_EXECUTED", {
      activeOrderHashes: active,
      executionJobId: jobId,
    }, publication.rows[0]?.bundle_hash ?? null);
    await client.query("COMMIT");
    return active;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export type BatchOrderChainState = {
  orderHash: Hex;
  status: "ACTIVE" | "FILLED" | "CANCELLED";
  filledQuantity: bigint;
};

/** Fail-closed release after an atomic batch is proven not to have executed. */
export async function failAndReleaseBatch(
  db: Database,
  batchId: Hex,
  fencingToken: bigint,
  jobId: string,
  chainStates: BatchOrderChainState[],
  reason: string,
): Promise<Hex[]> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ status: string; execution_job_id: string | null }>(
      "SELECT status, execution_job_id FROM arc_batches WHERE batch_id = $1 AND fencing_token = $2 FOR UPDATE",
      [batchId, fencingToken.toString()],
    );
    const batch = locked.rows[0];
    if (!batch || batch.execution_job_id !== jobId || !["EXECUTING", "FAILED"].includes(batch.status)) {
      throw new Error("batch_failure_fence_invalid");
    }

    const assigned = await client.query<{ order_hash: Hex }>(
      `SELECT order_hash FROM arc_orders
        WHERE assigned_batch_id = $1 AND match_job_id = $2
        ORDER BY order_hash FOR UPDATE`,
      [batchId, jobId],
    );
    const byHash = new Map(chainStates.map((state) => [state.orderHash.toLowerCase(), state]));
    if (assigned.rows.some((row) => !byHash.has(row.order_hash.toLowerCase()))) {
      throw new Error("batch_failure_chain_state_incomplete");
    }

    const active: Hex[] = [];
    for (const row of assigned.rows) {
      const state = byHash.get(row.order_hash.toLowerCase())!;
      await client.query(
        `UPDATE arc_orders
            SET status = $2, filled_quantity = $3, assigned_batch_id = NULL,
                match_job_id = NULL, updated_at = clock_timestamp()
          WHERE order_hash = $1 AND assigned_batch_id = $4 AND match_job_id = $5`,
        [row.order_hash, state.status, state.filledQuantity.toString(), batchId, jobId],
      );
      if (state.status === "ACTIVE") {
        active.push(row.order_hash);
        await appendOrderEvent(client, row.order_hash, "ORDER_BATCH_RELEASED", { batchId, reason });
      } else if (state.status === "FILLED") {
        await appendOrderEvent(client, row.order_hash, "ORDER_FILLED", {
          batchId,
          filledQuantity: state.filledQuantity.toString(),
          reason,
        });
      } else {
        await client.query(
          `UPDATE arc_nonce_claims SET state = 'CONSUMED', updated_at = clock_timestamp()
            WHERE namespace = 'CANCEL'
              AND digest = (SELECT cancellation_digest FROM arc_orders WHERE order_hash = $1)
              AND state IN ('ACCEPTED','CHAIN_ACTIVE')`,
          [row.order_hash],
        );
        await appendOrderEvent(client, row.order_hash, "ORDER_CANCELLED", { batchId, reason });
      }
    }
    await client.query(
      `UPDATE arc_batch_orders SET released_at = clock_timestamp()
        WHERE batch_id = $1 AND released_at IS NULL`,
      [batchId],
    );
    await client.query(
      `UPDATE arc_batch_chunks SET status = 'FAILED', last_error = $2, updated_at = clock_timestamp()
        WHERE batch_id = $1 AND status <> 'SUCCEEDED'`,
      [batchId, reason.slice(0, 2_000)],
    );
    await client.query(
      `UPDATE arc_batches SET status = 'FAILED', lease_owner = NULL, lease_expires_at = NULL,
              updated_at = clock_timestamp()
        WHERE batch_id = $1 AND fencing_token = $2`,
      [batchId, fencingToken.toString()],
    );
    const publication = await client.query<{ bundle_hash: Hex }>(
      "SELECT bundle_hash FROM arc_batch_publications WHERE batch_id = $1",
      [batchId],
    );
    await appendBatchEvent(client, batchId, "BATCH_FAILED", {
      executionJobId: jobId,
      reason: reason.slice(0, 2_000),
    }, publication.rows[0]?.bundle_hash ?? null);
    await client.query("COMMIT");
    return active;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
