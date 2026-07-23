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
import { parseSportmonksOracleReport, parseTxlineOracleReport } from "../src/oracle-adapter.js";
import { evaluateOracleQuorum, storeOracleReport, updateMarketOracleHealth } from "../src/oracle-state.js";
import { activateHalt, assertOperationAllowed, recordRecoveryObservation } from "../src/risk-controls.js";
import { resetArcTestData } from "./postgres-test-db.js";

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
  riskLimits: {
    walletReserveAtoms: 10n ** 30n,
    marketReserveAtoms: 10n ** 30n,
    batchNotionalAtoms: 10n ** 30n,
    treasuryAtoms: 10n ** 30n,
    ingressPerMinute: 1_000_000,
    walletOrdersPerMinute: 1_000_000,
    activeMarkets: 1_000_000,
    globalCustodyAtoms: 10n ** 30n,
  },
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
    await resetArcTestData(db);
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

  it("migrates the complete append-only oracle evidence schema and reserved adapters", async () => {
    const columns = await db.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'arc_oracle_reports'`,
    );
    const required = ["raw_response", "raw_payload_hash", "proof", "fixture_identity", "sequence", "source_timestamp"];
    for (const column of required) {
      expect(columns.rows).toContainEqual({ column_name: column, is_nullable: "NO" });
    }
    const reserved = await db.query<{ adapter_id: string; enabled: boolean }>(
      `SELECT adapter_id, enabled FROM arc_oracle_adapters
        WHERE adapter_id IN ('pyth.price.v1','election.result.v1') ORDER BY adapter_id`,
    );
    expect(reserved.rows).toEqual([
      { adapter_id: "election.result.v1", enabled: false },
      { adapter_id: "pyth.price.v1", enabled: false },
    ]);
  });

  it("stores oracle evidence append-only and selects corrections deterministically", async () => {
    const base = {
      success: true as const,
      data: {
        fixtureId: "integration-fixture", status: "final", homeScore: 1, awayScore: 0,
        winner: "part1" as const, sourceUpdateId: "7", sourceTimestamp: "2026-07-23T12:00:00.000Z",
        sequence: 7, correction: 0,
      },
    };
    const original = parseTxlineOracleReport(base, undefined, "2026-07-23T12:00:01.000Z");
    const corrected = parseTxlineOracleReport({
      ...base,
      data: { ...base.data, homeScore: 2, correction: 1 },
    }, undefined, "2026-07-23T12:00:02.000Z");
    await storeOracleReport(db, corrected, marketId);
    await storeOracleReport(db, original, marketId);
    await storeOracleReport(db, corrected, marketId);
    const selected = await db.query<{ selected_report_hash: string }>(
      "SELECT selected_report_hash FROM arc_oracle_fixture_state WHERE adapter_id = $1 AND fixture_identity = $2",
      [corrected.adapterId, corrected.fixtureIdentity],
    );
    expect(selected.rows[0]?.selected_report_hash).toBe(corrected.reportHash);
    await expect(db.query(
      "UPDATE arc_oracle_reports SET correction_rank = 2 WHERE report_hash = $1",
      [corrected.reportHash],
    )).rejects.toThrow(/immutable_relation:arc_oracle_reports/);
  });

  it("requires consecutive agreeing observations before recovering an oracle halt", async () => {
    const at = new Date().toISOString();
    const primary = parseTxlineOracleReport({
      success: true,
      data: {
        fixtureId: "integration-fixture", status: "final", homeScore: 1, awayScore: 0,
        winner: "part1", sourceUpdateId: "8", sourceTimestamp: at, sequence: 8,
      },
    }, undefined, at);
    const makeWitness = (observedAt: string, score: [number, number]) => parseSportmonksOracleReport({
      data: {
        id: "witness-integration", state: { short_name: "FT" }, participants: [],
        scores: [
          { description: "CURRENT", score: { participant: "home", goals: score[0] } },
          { description: "CURRENT", score: { participant: "away", goals: score[1] } },
        ],
      },
      subscription: [{ type: "trial" }],
    }, undefined, observedAt);
    const witness = makeWitness(at, [1, 0]);
    await storeOracleReport(db, primary, marketId);
    await storeOracleReport(db, witness, marketId);
    const badWitness = makeWitness(new Date(Date.now() - 3_000).toISOString(), [0, 1]);
    await storeOracleReport(db, badWitness, marketId);
    const bad = evaluateOracleQuorum(primary, badWitness, {
      nowMs: Date.now(), maxAgeSeconds: 60, maxSkewSeconds: 10,
    });
    await updateMarketOracleHealth(db, marketId, bad, 3);
    await expect(assertOperationAllowed(db, "INTAKE", marketId)).rejects.toThrow("exchange_halted_oracle_integrity");
    for (let index = 0; index < 3; index += 1) {
      const nextWitness = makeWitness(new Date(Date.now() + index).toISOString(), [1, 0]);
      await storeOracleReport(db, nextWitness, marketId);
      const good = evaluateOracleQuorum(primary, nextWitness, {
        nowMs: Date.now() + 10, maxAgeSeconds: 60, maxSkewSeconds: 10,
      });
      expect((await updateMarketOracleHealth(db, marketId, good, 3)).healthy).toBe(index === 2);
    }
    await expect(assertOperationAllowed(db, "INTAKE", marketId)).resolves.toBeUndefined();
  });

  it("counts stable authenticated quorum polls so an immutable final can recover safely", async () => {
    await db.query("DELETE FROM arc_market_oracle_health WHERE market_id = $1", [marketId]);
    const at = new Date().toISOString();
    const primary = parseTxlineOracleReport({
      success: true,
      data: {
        fixtureId: "integration-fixture", status: "final", homeScore: 1, awayScore: 0,
        winner: "part1", sourceUpdateId: "stable-10", sourceTimestamp: at, sequence: 10,
      },
    }, undefined, at);
    const witness = parseSportmonksOracleReport({
      data: {
        id: "witness-integration", state: { short_name: "FT" }, participants: [],
        scores: [
          { description: "CURRENT", score: { participant: "home", goals: 1 } },
          { description: "CURRENT", score: { participant: "away", goals: 0 } },
        ],
      },
      subscription: [{ type: "trial" }],
    }, undefined, at);
    await storeOracleReport(db, primary, marketId);
    await storeOracleReport(db, witness, marketId);
    const quorum = evaluateOracleQuorum(primary, witness, {
      nowMs: Date.now(), maxAgeSeconds: 60, maxSkewSeconds: 10,
    });
    const observations = [];
    for (let index = 0; index < 3; index += 1) {
      observations.push(await updateMarketOracleHealth(db, marketId, quorum, 3));
    }
    expect(observations.map((item) => item.consecutiveHealthy)).toEqual([1, 2, 3]);
    expect(observations.at(-1)?.healthy).toBe(true);
  });

  it("keeps finalized withdrawals available during non-custody halts and blocks them for custody safety", async () => {
    await activateHalt(db, { haltKey: "integration:rpc", reason: "RPC", detail: "forced_test" });
    await expect(assertOperationAllowed(db, "INTAKE")).rejects.toThrow("exchange_halted_rpc");
    await expect(assertOperationAllowed(db, "BATCH")).rejects.toThrow("exchange_halted_rpc");
    await expect(assertOperationAllowed(db, "WITHDRAWAL")).resolves.toBeUndefined();
    await activateHalt(db, { haltKey: "integration:custody", reason: "CUSTODY_SAFETY", detail: "forced_test" });
    await expect(assertOperationAllowed(db, "WITHDRAWAL")).rejects.toThrow("exchange_halted_custody_safety");
    await recordRecoveryObservation(db, {
      haltKey: "integration:custody", reason: "CUSTODY_SAFETY", healthy: true, threshold: 3, detail: "first_good",
    });
    await expect(assertOperationAllowed(db, "WITHDRAWAL")).rejects.toThrow("exchange_halted_custody_safety");
    for (const haltKey of ["integration:custody", "integration:rpc"]) {
      await recordRecoveryObservation(db, {
        haltKey, reason: haltKey.endsWith("custody") ? "CUSTODY_SAFETY" : "RPC",
        healthy: true, threshold: 1, detail: "test_cleanup",
      });
    }
  });

  it("records halt activation idempotently and keeps simultaneous failures independently active", async () => {
    const input = { haltKey: "integration:idempotent", reason: "CAP" as const, detail: "cap_boundary" };
    await activateHalt(db, input);
    await activateHalt(db, input);
    const activations = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM arc_risk_events
        WHERE halt_key = $1 AND event_type = 'HALT_ACTIVATED'`,
      [input.haltKey],
    );
    expect(activations.rows[0]?.count).toBe("1");

    await activateHalt(db, { haltKey: "integration:oracle", reason: "ORACLE_INTEGRITY", detail: "divergent" });
    await activateHalt(db, { haltKey: "integration:reconcile", reason: "RECONCILIATION", detail: "ledger_mismatch" });
    await recordRecoveryObservation(db, {
      haltKey: input.haltKey, reason: "CAP", healthy: true, threshold: 1, detail: "test_cleanup",
    });
    await recordRecoveryObservation(db, {
      haltKey: "integration:oracle", reason: "ORACLE_INTEGRITY", healthy: true, threshold: 1, detail: "recovered",
    });
    await expect(assertOperationAllowed(db, "INTAKE")).rejects.toThrow("exchange_halted_reconciliation");
    await recordRecoveryObservation(db, {
      haltKey: "integration:reconcile", reason: "RECONCILIATION", healthy: true, threshold: 1, detail: "recovered",
    });
    await expect(assertOperationAllowed(db, "INTAKE")).resolves.toBeUndefined();
  });

  it("does not reopen a finalized market when a late correction is archived", async () => {
    await db.query("UPDATE arc_markets SET status = 'RESOLVED' WHERE market_id = $1", [marketId]);
    const report = parseTxlineOracleReport({
      success: true,
      data: {
        fixtureId: "integration-fixture", status: "final", homeScore: 3, awayScore: 0,
        winner: "part1", sourceUpdateId: "9", sourceTimestamp: new Date().toISOString(), sequence: 9, correction: 2,
      },
    });
    await storeOracleReport(db, report, marketId);
    const market = await db.query<{ status: string; resolution_job_id: string | null }>(
      "SELECT status, resolution_job_id FROM arc_markets WHERE market_id = $1",
      [marketId],
    );
    expect(market.rows[0]).toEqual({ status: "RESOLVED", resolution_job_id: null });
    await db.query("UPDATE arc_markets SET status = 'OPEN' WHERE market_id = $1", [marketId]);
  });

  it("keeps normalized resolution evidence append-only", async () => {
    const digest = hash(880);
    await db.query(
      `INSERT INTO arc_resolution_reports(
         report_digest, market_id, source_index, source_id, source_event_id,
         observed_at, published_at, final_result, normalized_outcome,
         raw_payload_hash, signature_evidence
       ) VALUES ($1,$2,0,'TXLINE','integration-fixture',1,1,true,0,$3,'0x1234')`,
      [digest, marketId, hash(881)],
    );
    await expect(db.query(
      "UPDATE arc_resolution_reports SET normalized_outcome = 1 WHERE report_digest = $1",
      [digest],
    )).rejects.toThrow(/immutable_relation:arc_resolution_reports/);
    await expect(db.query(
      "DELETE FROM arc_resolution_reports WHERE report_digest = $1",
      [digest],
    )).rejects.toThrow(/immutable_relation:arc_resolution_reports/);
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
