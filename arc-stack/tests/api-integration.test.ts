import { createHash } from "node:crypto";
import pg from "pg";
import WebSocket from "ws";
import { getAddress } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApi } from "../src/api.js";
import { loadConfig } from "../src/config.js";
import { appendExchangeEvent } from "../src/exchange-events.js";
import { createLogger } from "../src/logger.js";
import { appendOrderEvent, payloadHash } from "../src/order-intake.js";
import { activateHalt, recoverHalt } from "../src/risk-controls.js";
import { resetArcTestData } from "./postgres-test-db.js";

const databaseUrl = process.env.ARC_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const pepper = "integration-auth-pepper-that-is-at-least-32-bytes";
const token = "airarena_arc_sk_integration_test_token";
const operatorToken = "integration-operator-token-that-is-long-enough";
const wallet = getAddress("0x00000000000000000000000000000000000000c3");

integration("isolated /v1/exchange API", () => {
  const db = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const config = loadConfig({
    NODE_ENV: "test",
    SERVICE_ROLE: "api",
    DATABASE_URL: databaseUrl ?? "postgresql://localhost/airarena_arc_test_not_configured",
    ARC_RPC_URL: "https://rpc.example.invalid",
    ARC_EXCHANGE_ADDRESS: "0x00000000000000000000000000000000000000a1",
    ARC_RECEIPT_SIGNER_PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    AUTH_TOKEN_PEPPER: pepper,
    ARC_OPERATOR_TOKEN: operatorToken,
  });
  const logger = createLogger({ logLevel: "silent", serviceRole: "api" });
  let app: Awaited<ReturnType<typeof buildApi>>;
  let baseUrl: string;

  beforeAll(async () => {
    app = await buildApi({ config, logger, db });
    await resetArcTestData(db);
    const tokenHash = createHash("sha256").update(pepper).update("\0").update(token).digest("hex");
    await db.query(
      `INSERT INTO arc_api_tokens(wallet, token_hash, scopes)
       VALUES ($1,$2,ARRAY['markets:read','orders:read','orders:write']::text[])
       ON CONFLICT (token_hash) DO NOTHING`,
      [wallet, tokenHash],
    );
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = address;
  });

  afterAll(async () => {
    await app?.close();
  });

  it("serves the complete versioned contract with structured stable errors", async () => {
    const network = await app.inject({ method: "GET", url: "/v1/exchange/network" });
    expect(network.statusCode).toBe(200);
    expect(network.json()).toMatchObject({ success: true, data: { chainId: 5_042_002 } });

    const invalid = await app.inject({ method: "GET", url: "/v1/exchange/markets/not-a-market" });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      success: false,
      error: { code: "invalid_market_id", retryable: false },
    });

    const missingRoute = await app.inject({ method: "GET", url: "/v1/exchange/not-a-route" });
    expect(missingRoute.statusCode).toBe(404);
    expect(missingRoute.json()).toMatchObject({
      success: false,
      error: { code: "route_not_found", retryable: false },
    });

    const missingJob = await app.inject({
      method: "GET",
      url: "/v1/exchange/jobs/00000000-0000-4000-8000-000000000000",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(missingJob.statusCode).toBe(404);
    expect(missingJob.json()).toMatchObject({ error: { code: "job_not_found", retryable: false } });

    const catalog = await app.inject({ method: "GET", url: "/v1/exchange/errors" });
    expect(catalog.json().data).toHaveProperty("order_cancellation_cutoff_elapsed");
    const openapi = await app.inject({ method: "GET", url: "/v1/exchange/openapi.json" });
    expect(openapi.json().paths).toHaveProperty("/stream");
    expect(openapi.json().paths).toHaveProperty("/oracles/adapters");
    expect(openapi.json().paths).toHaveProperty("/risk/withdrawals");
    expect(openapi.json().components.schemas.CreateMarketRequest.required).toContain("oracleBinding");

    const adapters = await app.inject({ method: "GET", url: "/v1/exchange/oracles/adapters" });
    expect(adapters.statusCode).toBe(200);
    expect(adapters.json().data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "pyth.price.v1", enabled: false, role: "RESERVED" }),
      expect.objectContaining({ id: "election.result.v1", enabled: false, role: "RESERVED" }),
    ]));

    const halts = await app.inject({ method: "GET", url: "/v1/exchange/operator/risk/halts" });
    expect(halts.statusCode).toBe(403);
    expect(halts.json()).toMatchObject({ error: { code: "operator_unauthorized" } });
  });

  it("permits withdrawal preparation through ordinary halts and blocks custody-safety halts", async () => {
    const headers = { authorization: `Bearer ${token}` };
    await activateHalt(db, { haltKey: "api-test:rpc", reason: "RPC", detail: "test" });
    const ordinary = await app.inject({ method: "GET", url: "/v1/exchange/risk/withdrawals", headers });
    expect(ordinary.statusCode).toBe(200);
    expect(ordinary.json()).toMatchObject({ success: true, data: { wallet, allowed: true } });

    await activateHalt(db, { haltKey: "api-test:custody", reason: "CUSTODY_SAFETY", detail: "test" });
    const custody = await app.inject({ method: "GET", url: "/v1/exchange/risk/withdrawals", headers });
    expect(custody.statusCode).toBe(503);
    expect(custody.json()).toMatchObject({
      success: false, error: { code: "exchange_halted_custody_safety", retryable: false },
    });
    await recoverHalt(db, "api-test:rpc");
    await recoverHalt(db, "api-test:custody");
  });

  it("replays idempotent writes and rejects request-key reuse", async () => {
    const marketId = `0x${"ca".repeat(32)}`;
    const headers = {
      "x-airarena-operator-token": operatorToken,
      "idempotency-key": "api-replay-key-0001",
    };
    const first = await app.inject({ method: "POST", url: `/v1/exchange/operator/markets/${marketId}/invalidate`, headers });
    const replay = await app.inject({ method: "POST", url: `/v1/exchange/operator/markets/${marketId}/invalidate`, headers });
    expect(first.statusCode).toBe(202);
    expect(replay.statusCode).toBe(202);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(replay.json()).toEqual(first.json());

    const resolveHeaders = { ...headers, "idempotency-key": "api-mismatch-key-0001" };
    const report = (outcome: number, sourceByte: string) => ({
      sourceId: `0x${sourceByte.repeat(64)}`,
      sourceEventId: `0x${"ef".repeat(32)}`,
      observedAt: "100",
      publishedAt: "101",
      finalResult: true,
      normalizedOutcome: outcome,
      rawPayloadHash: `0x${"ab".repeat(32)}`,
      signatureEvidence: "0x1234",
    });
    const accepted = await app.inject({
      method: "POST", url: `/v1/exchange/operator/markets/${marketId}/resolve`, headers: resolveHeaders,
      payload: { primary: report(0, "1"), witness: report(0, "2") },
    });
    expect(accepted.statusCode).toBe(202);
    const mismatch = await app.inject({
      method: "POST", url: `/v1/exchange/operator/markets/${marketId}/resolve`, headers: resolveHeaders,
      payload: { primary: report(1, "1"), witness: report(1, "2") },
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json()).toMatchObject({ error: { code: "idempotency_key_reused", retryable: false } });
  });

  it("rejects market creation before enqueue when no authenticated free witness is configured", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/exchange/operator/markets",
      headers: {
        "x-airarena-operator-token": operatorToken,
        "idempotency-key": "missing-witness-market-0001",
      },
      payload: {
        fixtureId: "txline-fixture-without-witness",
        specHash: `0x${"17".repeat(32)}`,
        outcomeCount: 3,
        closeTime: "2027-07-23T12:00:00.000Z",
        oracleBinding: {
          primaryAdapterId: "txline.sports-result.v1",
          primaryFixtureIdentity: "txline-fixture-without-witness",
          witnessAdapterId: "sportmonks.football.v3",
          witnessFixtureIdentity: "sportmonks-fixture",
          witnessAccessTier: "TRIAL",
          witnessAuthenticated: true,
        },
        resolutionRule: {
          primarySourceId: `0x${"18".repeat(32)}`,
          witnessSourceId: `0x${"19".repeat(32)}`,
          sourceEventId: `0x${"20".repeat(32)}`,
          primarySigner: "0x0000000000000000000000000000000000000011",
          witnessSigner: "0x0000000000000000000000000000000000000012",
          maxReportAgeSeconds: "180",
          maxSourceTimestampSkewSeconds: "30",
          graceSeconds: "900",
        },
      },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "oracle_witness_credential_unavailable" } });
    const jobs = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM arc_jobs WHERE idempotency_key LIKE 'create-market:%'",
    );
    expect(jobs.rows[0]?.count).toBe("0");
  });

  it("rejects cancellation preparation at the database-enforced cutoff", async () => {
    const marketId = `0x${"cb".repeat(32)}`;
    const orderHash = `0x${"cd".repeat(32)}`;
    const batchId = `0x${"ce".repeat(32)}`;
    await db.query(
      `INSERT INTO arc_markets(
         market_id, fixture_id, external_id_hash, outcome_count, close_time, status, oracle_reference
       ) VALUES ($1,'api-cutoff-fixture',$2,3,clock_timestamp() + interval '1 hour','OPEN','api-cutoff-fixture')
       ON CONFLICT (market_id) DO NOTHING`,
      [marketId, `0x${"cf".repeat(32)}`],
    );
    await db.query(
      `INSERT INTO arc_batches(
         batch_id, market_id, outcome, policy_version, policy_hash, batch_start, batch_end,
         cancellation_cutoff, status
       ) VALUES (
         $1,$2,0,'integration-policy',$3,clock_timestamp() - interval '2 seconds',
         clock_timestamp() + interval '1 second',clock_timestamp() - interval '1 second','OPEN'
       ) ON CONFLICT (batch_id) DO NOTHING`,
      [batchId, marketId, `0x${"d0".repeat(32)}`],
    );
    const accepted = await appendOrderEvent(db, orderHash, "ORDER_ACCEPTED", { maker: wallet });
    await db.query(
      `INSERT INTO arc_orders(
         order_hash, maker, market_id, outcome, side, price_ppm, quantity, nonce, expiry,
         client_order_id, signature, status, filled_quantity, accepted_sequence, assigned_batch_id
       ) VALUES ($1,$2,$3,0,'BUY',500000,10000,9001,clock_timestamp() + interval '30 minutes',$4,'0x1234','ACTIVE',0,$5,$6)
       ON CONFLICT (order_hash) DO NOTHING`,
      [orderHash, wallet, marketId, `0x${"d1".repeat(32)}`, accepted.sequence.toString(), batchId],
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/exchange/orders/cancellations/prepare",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        orderHash,
        nonce: "9002",
        deadline: (Math.floor(Date.now() / 1000) + 600).toString(),
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "order_cancellation_cutoff_elapsed", retryable: false } });
  });

  it("streams authenticated events from a resume cursor", async () => {
    const maximum = await db.query<{ sequence: string }>(
      "SELECT COALESCE(max(sequence),0)::text AS sequence FROM arc_exchange_events",
    );
    const cursor = maximum.rows[0]?.sequence ?? "0";
    const received: string[] = [];
    const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/v1/exchange/stream?cursor=${cursor}&topics=SYSTEM`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const complete = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("api_websocket_timeout")), 3_000);
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { type: string; eventType?: string };
        if (message.type === "event" && message.eventType) received.push(message.eventType);
        if (message.eventType === "API_TEST_2") {
          clearTimeout(timeout);
          resolve();
        }
      });
      socket.on("error", reject);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    for (const index of [1, 2]) {
      const payload = { index };
      const hashedPayload = payloadHash(payload);
      await appendExchangeEvent(db, {
        topic: "SYSTEM",
        entityId: "api-integration",
        eventType: `API_TEST_${index}`,
        payload,
        eventKey: payloadHash({ apiIntegrationEvent: index }),
        payloadHash: hashedPayload,
        sourceRoot: hashedPayload,
      });
    }
    await complete;
    socket.close();
    expect(received).toEqual(["API_TEST_1", "API_TEST_2"]);
  });
});
