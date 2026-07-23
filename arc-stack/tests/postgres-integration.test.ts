import pg from "pg";
import { getAddress, type Address, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { replayPublicBatchBundle, type PublicBatchBundle } from "../src/batch-bundle.js";
import { assignActiveOrderToBatch, failAndReleaseBatch, sealNextBatch } from "../src/batches.js";
import { bindDatabaseToExchange, migrateDatabase, type Database } from "../src/db.js";
import { readExchangeEventsAfter } from "../src/exchange-events.js";
import {
  claimHttpIdempotency,
  completeHttpIdempotency,
  idempotencyActorHash,
  idempotencyRequestHash,
} from "../src/idempotency.js";
import { createLogger } from "../src/logger.js";
import { appendOrderEvent, createAcceptanceReceipt } from "../src/order-intake.js";

const databaseUrl = process.env.ARC_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const exchange = getAddress("0x00000000000000000000000000000000000000a1");
const receiptSignerPrivateKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const marketId = `0x${"aa".repeat(32)}` as Hex;
const config = {
  chainId: 5_042_002,
  exchangeAddress: exchange,
  batchIntervalMs: 1_000,
  batchMaxOrders: 16,
  batchExecutionChunkSize: 16,
};

function hash(index: number): Hex {
  return `0x${index.toString(16).padStart(64, "0")}`;
}

function maker(index: number): Address {
  return getAddress(`0x${index.toString(16).padStart(40, "0")}`);
}

integration("PostgreSQL durable intake and batch integration", () => {
  let db: Database;

  beforeAll(async () => {
    db = new pg.Pool({ connectionString: databaseUrl, max: 8 });
    await migrateDatabase(db, createLogger({ logLevel: "silent", serviceRole: "api" }));
    await bindDatabaseToExchange(db, config.chainId, exchange);
    await db.query(
      `INSERT INTO arc_markets(
         market_id, fixture_id, external_id_hash, outcome_count, close_time, status, oracle_reference
       ) VALUES ($1,'integration-fixture',$2,3,clock_timestamp() + interval '1 hour','OPEN','integration-fixture')`,
      [marketId, hash(999)],
    );
  });

  afterAll(async () => {
    await db?.end();
  });

  it("enforces one immutable deployment binding", async () => {
    await expect(bindDatabaseToExchange(db, config.chainId, exchange)).resolves.toBeUndefined();
    await expect(bindDatabaseToExchange(
      db,
      config.chainId,
      getAddress("0x00000000000000000000000000000000000000b2"),
    )).rejects.toThrow("database_exchange_binding_mismatch");
  });

  it("persists immutable receipts and crash-safe assignments, then seals one uniform-price auction", async () => {
    const orders = [
      { index: 1, side: "BUY", price: 600_000, quantity: 70_000 },
      { index: 2, side: "BUY", price: 550_000, quantity: 50_000 },
      { index: 3, side: "BUY", price: 550_000, quantity: 50_000 },
      { index: 4, side: "SELL", price: 400_000, quantity: 60_000 },
      { index: 5, side: "SELL", price: 500_000, quantity: 80_000 },
    ] as const;

    for (const order of orders) {
      const orderHash = hash(order.index);
      const accepted = await appendOrderEvent(db, orderHash, "ORDER_ACCEPTED", { maker: maker(order.index) });
      await db.query(
        `INSERT INTO arc_orders(
           order_hash, maker, market_id, outcome, side, price_ppm, quantity, nonce, expiry,
           client_order_id, signature, status, filled_quantity, accepted_sequence
         ) VALUES ($1,$2,$3,0,$4,$5,$6,$7,clock_timestamp() + interval '30 minutes',$8,'0x1234','ACTIVE',0,$9)`,
        [
          orderHash,
          maker(order.index),
          marketId,
          order.side,
          order.price,
          order.quantity,
          order.index,
          hash(100 + order.index),
          accepted.sequence.toString(),
        ],
      );
      await db.query(
        `INSERT INTO arc_nonce_claims(maker, namespace, nonce, digest, state)
         VALUES ($1,'ORDER',$2,$3,'CHAIN_ACTIVE')`,
        [maker(order.index), order.index, orderHash],
      );
      if (order.index === 1) {
        const receipt = await createAcceptanceReceipt(db as never, {
          exchangeAddress: exchange,
          receiptSignerPrivateKey,
          receiptSignerKeyId: "integration-receipt-v1",
        }, {
          orderHash,
          maker: maker(order.index),
          sequence: accepted.sequence,
          acceptedAt: accepted.occurredAt,
          requestHash: hash(700),
        });
        expect(receipt.sequence).toBe(accepted.sequence.toString());
        expect(receipt.signature).toMatch(/^0x[0-9a-f]{130}$/);
      }
    }

    const firstHash = hash(1);
    const assignments = await Promise.all([
      assignActiveOrderToBatch(db, config, firstHash),
      assignActiveOrderToBatch(db, config, firstHash),
    ]);
    expect(assignments[0]).toBeTruthy();
    expect(assignments[1]).toBe(assignments[0]);
    for (const order of orders.slice(1)) {
      expect(await assignActiveOrderToBatch(db, config, hash(order.index))).toBe(assignments[0]);
    }
    const cutoff = await db.query<{ delta_ms: string }>(
      `SELECT round(extract(epoch FROM (batch_end - cancellation_cutoff)) * 1000)::bigint::text AS delta_ms
         FROM arc_batches WHERE batch_id = $1`,
      [assignments[0]],
    );
    expect(cutoff.rows[0]?.delta_ms).toBe("200");

    await db.query(
      `UPDATE arc_batches
          SET batch_start = clock_timestamp() - interval '2 seconds',
              batch_end = clock_timestamp() - interval '1 second',
              cancellation_cutoff = clock_timestamp() - interval '1.2 seconds'`,
    );
    const sealed = await sealNextBatch(db, config, "integration-worker");
    expect(sealed?.batchId).toBe(assignments[0]);
    expect(sealed?.executionJobCreated).toBe(true);

    const batch = await db.query<{
      status: string;
      clearing_price_ppm: string;
      executable_quantity: string;
      jobs: string;
      execution_job_id: string;
    }>(
      `SELECT b.status, b.clearing_price_ppm::text, b.executable_quantity::text, b.execution_job_id,
              count(j.id)::text AS jobs
         FROM arc_batches b LEFT JOIN arc_jobs j ON j.id = b.execution_job_id
        WHERE b.batch_id = $1
        GROUP BY b.batch_id`,
      [sealed!.batchId],
    );
    expect(batch.rows[0]).toMatchObject({
      status: "EXECUTING",
      clearing_price_ppm: "525000",
      executable_quantity: "140000",
      jobs: "1",
    });

    const fills = await db.query<{ quantity: string; self_trade: boolean }>(
      `SELECT f.quantity::text,
              lower(b.maker) = lower(s.maker) AS self_trade
         FROM arc_batch_fills f
         JOIN arc_orders b ON b.order_hash = f.buy_order_hash
         JOIN arc_orders s ON s.order_hash = f.sell_order_hash
        WHERE f.batch_id = $1 ORDER BY f.fill_index`,
      [sealed!.batchId],
    );
    expect(fills.rows.length).toBeGreaterThan(1);
    expect(fills.rows.every((fill) => !fill.self_trade && BigInt(fill.quantity) % 10_000n === 0n)).toBe(true);

    const publication = await db.query<{ bundle: PublicBatchBundle; bundle_hash: Hex }>(
      "SELECT bundle, bundle_hash FROM arc_batch_publications WHERE batch_id = $1",
      [sealed!.batchId],
    );
    expect(replayPublicBatchBundle(publication.rows[0]!.bundle).valid).toBe(true);
    expect(publication.rows[0]!.bundle.bundleHash).toBe(publication.rows[0]!.bundle_hash);
    await expect(db.query(
      "UPDATE arc_batch_publications SET bundle = '{}'::jsonb WHERE batch_id = $1",
      [sealed!.batchId],
    )).rejects.toMatchObject({ code: "55000" });

    await expect(db.query("UPDATE arc_order_events SET payload = '{}'::jsonb WHERE order_hash = $1", [firstHash]))
      .rejects.toMatchObject({ code: "55000" });
    await expect(db.query("DELETE FROM arc_order_receipts WHERE order_hash = $1", [firstHash]))
      .rejects.toMatchObject({ code: "55000" });

    const released = await failAndReleaseBatch(
      db,
      sealed!.batchId,
      1n,
      batch.rows[0]!.execution_job_id,
      orders.map((order) => ({
        orderHash: hash(order.index),
        status: order.index === 1 ? "CANCELLED" as const : "ACTIVE" as const,
        filledQuantity: 0n,
      })),
      "integration_chain_prestate_changed",
    );
    expect(released).toHaveLength(4);
    const recovered = await db.query<{ status: string; assigned_batch_id: string | null }>(
      "SELECT status, assigned_batch_id FROM arc_orders WHERE order_hash = $1",
      [firstHash],
    );
    expect(recovered.rows[0]).toEqual({ status: "CANCELLED", assigned_batch_id: null });
    expect((await db.query("SELECT status FROM arc_batches WHERE batch_id = $1", [sealed!.batchId])).rows[0]?.status)
      .toBe("FAILED");
    const events = await readExchangeEventsAfter(db, 0n, 500);
    expect(events.length).toBeGreaterThan(orders.length);
    expect(events.map((event) => BigInt(event.sequence))).toEqual(
      [...events.map((event) => BigInt(event.sequence))].sort((left, right) => left < right ? -1 : 1),
    );
    expect(events.some((event) => event.eventType === "BATCH_PUBLISHED" && event.sourceRoot === publication.rows[0]!.bundle_hash))
      .toBe(true);
    expect(events.some((event) => event.eventType === "BATCH_FAILED")).toBe(true);
  });

  it("makes HTTP idempotency crash-safe, replayable, and request-bound", async () => {
    const actorHash = idempotencyActorHash("integration-agent-token");
    const route = "/v1/orders/submit";
    const key = "integration-idempotency-key";
    const requestHash = idempotencyRequestHash(route, { orderHash: hash(501) });
    const claim = await claimHttpIdempotency(db, { actorHash, route, key, requestHash, leaseMs: 60_000 });
    expect(claim.kind).toBe("ACQUIRED");
    await expect(claimHttpIdempotency(db, { actorHash, route, key, requestHash, leaseMs: 60_000 }))
      .rejects.toThrow("idempotency_request_in_progress");
    if (claim.kind !== "ACQUIRED") throw new Error("idempotency_claim_not_acquired");
    const response = { success: true, data: { orderHash: hash(501) } };
    await completeHttpIdempotency(db, {
      actorHash, route, key, leaseToken: claim.leaseToken, statusCode: 202, response,
    });
    await expect(claimHttpIdempotency(db, { actorHash, route, key, requestHash })).resolves.toEqual({
      kind: "REPLAY", statusCode: 202, response,
    });
    await expect(claimHttpIdempotency(db, {
      actorHash, route, key, requestHash: idempotencyRequestHash(route, { orderHash: hash(502) }),
    })).rejects.toThrow("idempotency_key_reused");
  });
});
