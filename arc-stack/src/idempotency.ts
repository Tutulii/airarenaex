import { randomUUID } from "node:crypto";
import { type Hex } from "viem";
import type { Database } from "./db.js";
import { payloadHash } from "./order-intake.js";

export type IdempotentResponse<T = unknown> = { statusCode: number; body: T; replayed: boolean };

export function idempotencyActorHash(credential: string): Hex {
  return payloadHash({ credential });
}

export function idempotencyRequestHash(route: string, body: unknown): Hex {
  return payloadHash({ body, route });
}

type Claim =
  | { kind: "ACQUIRED"; leaseToken: string }
  | { kind: "REPLAY"; statusCode: number; response: unknown };

export async function claimHttpIdempotency(
  db: Database,
  input: { actorHash: Hex; route: string; key: string; requestHash: Hex; leaseMs?: number },
): Promise<Claim> {
  const leaseToken = randomUUID();
  const leaseMs = input.leaseMs ?? 30_000;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO arc_http_idempotency(
         actor_hash, route, idempotency_key, request_hash, state, lease_token, lease_expires_at
       ) VALUES ($1,$2,$3,$4,'IN_PROGRESS',$5,clock_timestamp() + ($6::text || ' milliseconds')::interval)
       ON CONFLICT DO NOTHING`,
      [input.actorHash, input.route, input.key, input.requestHash, leaseToken, leaseMs.toString()],
    );
    if ((inserted.rowCount ?? 0) === 1) {
      await client.query("COMMIT");
      return { kind: "ACQUIRED", leaseToken };
    }
    const existing = await client.query<{
      request_hash: string;
      state: "IN_PROGRESS" | "COMPLETED" | "FAILED";
      lease_expired: boolean;
      status_code: number | null;
      response: unknown;
    }>(
      `SELECT request_hash, state, lease_expires_at <= clock_timestamp() AS lease_expired,
              status_code, response
         FROM arc_http_idempotency
        WHERE actor_hash = $1 AND route = $2 AND idempotency_key = $3
        FOR UPDATE`,
      [input.actorHash, input.route, input.key],
    );
    const row = existing.rows[0];
    if (!row) throw new Error("idempotency_claim_missing");
    if (row.request_hash.toLowerCase() !== input.requestHash.toLowerCase()) throw new Error("idempotency_key_reused");
    if (row.state === "COMPLETED") {
      await client.query("COMMIT");
      if (row.status_code === null || row.response === null) throw new Error("idempotency_completed_response_missing");
      return { kind: "REPLAY", statusCode: row.status_code, response: row.response };
    }
    if (row.state === "IN_PROGRESS" && !row.lease_expired) throw new Error("idempotency_request_in_progress");
    await client.query(
      `UPDATE arc_http_idempotency
          SET state = 'IN_PROGRESS', lease_token = $4,
              lease_expires_at = clock_timestamp() + ($5::text || ' milliseconds')::interval,
              status_code = NULL, response = NULL, updated_at = clock_timestamp()
        WHERE actor_hash = $1 AND route = $2 AND idempotency_key = $3`,
      [input.actorHash, input.route, input.key, leaseToken, leaseMs.toString()],
    );
    await client.query("COMMIT");
    return { kind: "ACQUIRED", leaseToken };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function completeHttpIdempotency(
  db: Database,
  input: { actorHash: Hex; route: string; key: string; leaseToken: string; statusCode: number; response: unknown },
): Promise<void> {
  const updated = await db.query(
    `UPDATE arc_http_idempotency
        SET state = 'COMPLETED', status_code = $5, response = $6::jsonb,
            lease_expires_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE actor_hash = $1 AND route = $2 AND idempotency_key = $3
        AND lease_token = $4 AND state = 'IN_PROGRESS'`,
    [input.actorHash, input.route, input.key, input.leaseToken, input.statusCode, JSON.stringify(input.response)],
  );
  if ((updated.rowCount ?? 0) !== 1) throw new Error("idempotency_lease_lost");
}

export async function failHttpIdempotency(
  db: Database,
  input: { actorHash: Hex; route: string; key: string; leaseToken: string },
): Promise<void> {
  await db.query(
    `UPDATE arc_http_idempotency SET state = 'FAILED', lease_expires_at = clock_timestamp(),
            updated_at = clock_timestamp()
      WHERE actor_hash = $1 AND route = $2 AND idempotency_key = $3
        AND lease_token = $4 AND state = 'IN_PROGRESS'`,
    [input.actorHash, input.route, input.key, input.leaseToken],
  );
}

export async function executeIdempotent<T>(
  db: Database,
  input: { actorHash: Hex; route: string; key: string; body: unknown },
  operation: () => Promise<{ statusCode: number; body: T }>,
): Promise<IdempotentResponse<T>> {
  const requestHash = idempotencyRequestHash(input.route, input.body);
  const claim = await claimHttpIdempotency(db, { ...input, requestHash });
  if (claim.kind === "REPLAY") {
    return { statusCode: claim.statusCode, body: claim.response as T, replayed: true };
  }
  try {
    const result = await operation();
    await completeHttpIdempotency(db, { ...input, leaseToken: claim.leaseToken, ...result, response: result.body });
    return { ...result, replayed: false };
  } catch (error) {
    await failHttpIdempotency(db, { ...input, leaseToken: claim.leaseToken }).catch(() => undefined);
    throw error;
  }
}
