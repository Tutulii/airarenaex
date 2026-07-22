import { getAddress, isAddress, type Hex } from "viem";
import { sealNextBatch } from "../batches.js";
import { ARC_CHAIN_ID } from "../config.js";
import { createDatabase } from "../db.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing_environment:${name}`);
  return value;
}

const databaseUrl = required("DATABASE_URL");
const rawExchangeAddress = required("ARC_EXCHANGE_ADDRESS");
if (!isAddress(rawExchangeAddress)) throw new Error("invalid_exchange_address");
const targetBatchId = required("TARGET_BATCH_ID") as Hex;
if (!/^0x[0-9a-fA-F]{64}$/.test(targetBatchId)) throw new Error("invalid_target_batch_id");

const db = createDatabase({ databaseUrl });

try {
  await db.query(
    `UPDATE arc_batches
        SET batch_end = LEAST(batch_end, clock_timestamp() - interval '1 second'),
            updated_at = clock_timestamp()
      WHERE batch_id = $1 AND status = 'OPEN'`,
    [targetBatchId],
  );
  let sealed: Awaited<ReturnType<typeof sealNextBatch>> = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    sealed = await sealNextBatch(db, {
      chainId: ARC_CHAIN_ID,
      exchangeAddress: getAddress(rawExchangeAddress),
      batchIntervalMs: 60_000,
      batchMaxOrders: 40,
      batchExecutionChunkSize: 40,
    }, "v2-direct-cancellation-smoke");
    if (!sealed || sealed.batchId.toLowerCase() === targetBatchId.toLowerCase()) break;
  }
  if (!sealed || sealed.batchId.toLowerCase() !== targetBatchId.toLowerCase()) {
    throw new Error("target_batch_not_sealed");
  }
  if (!sealed.executionJobCreated) throw new Error("target_batch_has_no_execution_job");
  const state = await db.query<{
    status: string;
    execution_job_id: string | null;
    job_status: string | null;
    matching_orders: string;
  }>(
    `SELECT b.status, b.execution_job_id, j.status AS job_status,
            count(o.*) FILTER (WHERE o.status = 'MATCHING')::text AS matching_orders
       FROM arc_batches b
       LEFT JOIN arc_jobs j ON j.id = b.execution_job_id
       LEFT JOIN arc_orders o ON o.assigned_batch_id = b.batch_id
      WHERE b.batch_id = $1
      GROUP BY b.status, b.execution_job_id, j.status`,
    [targetBatchId],
  );
  const row = state.rows[0];
  if (row?.status !== "EXECUTING" || row.job_status !== "PENDING" || row.matching_orders !== "2") {
    throw new Error(`sealed_batch_state_invalid:${JSON.stringify(row)}`);
  }
  process.stdout.write(`${JSON.stringify({ targetBatchId, ...row }, null, 2)}\n`);
} finally {
  await db.end();
}
