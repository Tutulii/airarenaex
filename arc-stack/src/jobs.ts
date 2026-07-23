import type { Database, DatabaseClient } from "./db.js";

export const JOB_KINDS = [
  "SUBMIT_ORDER",
  "CANCEL_ORDER",
  "EXECUTE_MATCH",
  "EXECUTE_BATCH",
  "CREATE_MARKET",
  "RESOLVE_MARKET",
  "INVALIDATE_AFTER_GRACE",
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export type ArcJob = {
  id: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "DEAD";
  attempts: number;
  maxAttempts: number;
  idempotencyKey: string;
};

type JobRow = {
  id: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  status: ArcJob["status"];
  attempts: number;
  max_attempts: number;
  idempotency_key: string;
};

function mapJob(row: JobRow): ArcJob {
  return {
    id: row.id,
    kind: row.kind,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    idempotencyKey: row.idempotency_key,
  };
}

export async function enqueueJob(
  db: Database | DatabaseClient,
  kind: JobKind,
  payload: Record<string, unknown>,
  idempotencyKey: string,
  ownerWallet: string | null = null,
): Promise<{ id: string; status: ArcJob["status"]; created: boolean }> {
  const result = await db.query<{ id: string; status: ArcJob["status"] }>(
    `INSERT INTO arc_jobs(kind, payload, idempotency_key, owner_wallet)
     VALUES ($1, $2::jsonb, $3, $4)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id, status`,
    [kind, JSON.stringify(payload), idempotencyKey, ownerWallet],
  );
  if (result.rows[0]) return { ...result.rows[0], created: true };
  const existing = await db.query<{ id: string; status: ArcJob["status"] }>(
    "SELECT id, status FROM arc_jobs WHERE idempotency_key = $1",
    [idempotencyKey],
  );
  const row = existing.rows[0];
  if (!row) throw new Error("job_idempotency_lookup_failed");
  return { ...row, created: false };
}

export async function claimNextJob(db: Database, workerId: string): Promise<ArcJob | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<JobRow>(
      `SELECT id, kind, payload, status, attempts, max_attempts, idempotency_key
       FROM arc_jobs
       WHERE status IN ('PENDING','FAILED') AND available_at <= now()
       ORDER BY created_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
    );
    const row = result.rows[0];
    if (!row) {
      await client.query("COMMIT");
      return null;
    }
    await client.query(
      `UPDATE arc_jobs
       SET status = 'RUNNING', attempts = attempts + 1, locked_at = now(), locked_by = $2, updated_at = now()
       WHERE id = $1`,
      [row.id, workerId],
    );
    await client.query("COMMIT");
    return mapJob({ ...row, status: "RUNNING", attempts: row.attempts + 1 });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function completeJob(db: Database, id: string, txHash: string | null): Promise<void> {
  await db.query(
    `UPDATE arc_jobs
     SET status = 'SUCCEEDED', tx_hash = COALESCE($2, tx_hash), locked_at = NULL, locked_by = NULL, updated_at = now()
     WHERE id = $1 AND status = 'RUNNING'`,
    [id, txHash],
  );
}

export async function failJob(
  db: Database,
  job: ArcJob,
  error: string,
  options: { permanent?: boolean } = {},
): Promise<boolean> {
  const dead = options.permanent === true || job.attempts >= job.maxAttempts;
  const backoffSeconds = Math.min(300, 2 ** Math.min(job.attempts, 8));
  await db.query(
    `UPDATE arc_jobs
     SET status = $2, last_error = $3, available_at = now() + ($4 * interval '1 second'),
         locked_at = NULL, locked_by = NULL, updated_at = now()
     WHERE id = $1 AND status = 'RUNNING'`,
    [job.id, dead ? "DEAD" : "FAILED", error.slice(0, 2000), backoffSeconds],
  );
  return dead;
}

export async function requeueRestartableJob(
  db: Database,
  id: string,
  error: string,
): Promise<void> {
  const result = await db.query(
    `UPDATE arc_jobs
     SET status = 'FAILED', attempts = 0, last_error = $2,
         available_at = now() + interval '5 seconds', locked_at = NULL, locked_by = NULL,
         updated_at = now()
     WHERE id = $1 AND status = 'DEAD'`,
    [id, error.slice(0, 2000)],
  );
  if ((result.rowCount ?? 0) !== 1) throw new Error("restartable_job_requeue_failed");
}

export async function recoverAbandonedJobs(db: Database): Promise<number> {
  const result = await db.query(
    `UPDATE arc_jobs
     SET status = 'FAILED', last_error = 'worker_lease_expired', available_at = now(),
         locked_at = NULL, locked_by = NULL, updated_at = now()
     WHERE status = 'RUNNING' AND locked_at < now() - interval '2 minutes'`,
  );
  return result.rowCount ?? 0;
}
