import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyRequest } from "fastify";
import {
  erc20Abi,
  getAddress,
  isHex,
  type Hex,
} from "viem";
import { authenticateBearer, createChallenge, exchangeChallengeForToken, operatorAuthorized } from "./auth.js";
import {
  arenaExchangeAbi,
  arcTestnet,
  createArcPublicClient,
  hashArcCancel,
  hashArcOrder,
  cancelTypes,
  orderDomain,
  orderTypes,
  transactionUrl,
  type ArcCancel,
  type ArcOrder,
} from "./chain.js";
import { ARC_EXPLORER_URL, type ArcConfig } from "./config.js";
import { bindDatabaseToExchange, createDatabase, databaseReady, migrateDatabase, type Database } from "./db.js";
import { ERROR_CATALOG, normalizeError, publicErrorCatalog } from "./errors.js";
import { readExchangeEventsAfter, type ExchangeEventTopic } from "./exchange-events.js";
import { EVENT_STREAM_PROTOCOL, parseResumeCursor, readResumableEventPage } from "./event-stream.js";
import { enqueueJob } from "./jobs.js";
import {
  claimHttpIdempotency,
  completeHttpIdempotency,
  failHttpIdempotency,
  idempotencyActorHash,
  idempotencyRequestHash,
} from "./idempotency.js";
import type { Logger } from "./logger.js";
import { validateOrderableMarket, type OrderableMarketState } from "./market-policy.js";
import { createMetrics } from "./metrics.js";
import { buildExchangeOpenApi } from "./openapi.js";
import {
  CreateMarketSchema,
  PrepareCancelSchema,
  PrepareOrderSchema,
  ResolveMarketSchema,
  SubmitCancelSchema,
  SubmitOrderSchema,
  createArcCancel,
  createArcOrder,
  jsonCancel,
  jsonOrder,
  marketIdentifiers,
} from "./schemas.js";
import { readAgentDirectory, readOrderbook } from "./read-models.js";
import { verifyWalletDigest } from "./signatures.js";
import {
  appendOrderEvent,
  claimNonce,
  createAcceptanceReceipt,
  orderRequestHash,
  readAcceptanceReceipt,
} from "./order-intake.js";

type ApiDependencies = { config: ArcConfig; logger: Logger; db?: Database };

function bearer(request: FastifyRequest): string | undefined {
  const value = request.headers.authorization;
  return Array.isArray(value) ? value[0] : value;
}

function idempotencyKey(request: FastifyRequest): string {
  const raw = request.headers["idempotency-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || value.length < 8 || value.length > 200) throw new Error("valid_idempotency_key_required");
  return value;
}

function operatorToken(request: FastifyRequest): string | undefined {
  const raw = request.headers["x-airarena-operator-token"];
  return Array.isArray(raw) ? raw[0] : raw;
}

function serializeUnknown(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item)));
}

const EVENT_TOPICS = new Set<ExchangeEventTopic>(["ORDER", "BATCH", "MARKET", "JOB", "SYSTEM"]);

function parseEventTopics(value: string | undefined): ExchangeEventTopic[] {
  if (!value) return [];
  const topics = [...new Set(value.split(",").map((topic) => topic.trim().toUpperCase()).filter(Boolean))];
  if (topics.some((topic) => !EVENT_TOPICS.has(topic as ExchangeEventTopic))) throw new Error("invalid_event_topic");
  return topics as ExchangeEventTopic[];
}

export async function buildApi(dependencies: ApiDependencies) {
  const { config, logger } = dependencies;
  const db = dependencies.db ?? createDatabase(config);
  await migrateDatabase(db, logger);
  if (config.exchangeAddress) await bindDatabaseToExchange(db, config.chainId, config.exchangeAddress);
  const publicClient = createArcPublicClient(config);
  const metrics = createMetrics("airarena-arc-api");
  const originalUrls = new WeakMap<object, string>();
  const app = Fastify({
    logger: false,
    bodyLimit: 256 * 1024,
    requestIdHeader: "x-request-id",
    genReqId: (request) => request.headers["x-request-id"]?.toString() ?? randomUUID(),
    trustProxy: true,
    rewriteUrl: (request) => {
      const original = request.url ?? "/";
      originalUrls.set(request, original);
      if (!original.startsWith("/v1/exchange")) return original;
      const rewritten = original.replace(/^\/v1\/exchange(?=\/|\?|$)/, "/v1");
      return rewritten === "/v1" ? "/v1/network" : rewritten;
    },
  });

  await app.register(websocket, { options: { maxPayload: 64 * 1024, perMessageDeflate: false } });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute", ban: 2 });
  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || config.corsOrigins.includes(origin)) callback(null, true);
      else callback(new Error("origin_not_allowed"), false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type", "idempotency-key", "x-airarena-operator-token", "x-request-id"],
  });

  const idempotentRoutes = new Set([
    "/v1/orders/submit",
    "/v1/orders/cancellations/submit",
    "/v1/operator/markets",
    "/v1/operator/markets/:marketId/resolve",
    "/v1/operator/markets/:marketId/invalidate",
  ]);
  const idempotencyLeases = new WeakMap<object, {
    actorHash: Hex;
    route: string;
    key: string;
    leaseToken: string;
  }>();

  app.addHook("preHandler", async (request, reply) => {
    const route = request.routeOptions.url;
    if (!route || request.method !== "POST" || !idempotentRoutes.has(route)) return;
    const key = idempotencyKey(request);
    const credential = route.startsWith("/v1/operator/") ? operatorToken(request) : bearer(request);
    if (!credential) return;
    const actorHash = idempotencyActorHash(credential);
    const requestHash = idempotencyRequestHash(route, { body: request.body, params: request.params });
    const claim = await claimHttpIdempotency(db, { actorHash, route, key, requestHash });
    if (claim.kind === "REPLAY") {
      reply.header("idempotency-replayed", "true");
      return reply.status(claim.statusCode).send(claim.response);
    }
    idempotencyLeases.set(request.raw, { actorHash, route, key, leaseToken: claim.leaseToken });
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const lease = idempotencyLeases.get(request.raw);
    if (!lease) return payload;
    idempotencyLeases.delete(request.raw);
    if (reply.statusCode >= 500) {
      await failHttpIdempotency(db, lease);
      return payload;
    }
    let response: unknown = payload;
    if (typeof payload === "string") response = JSON.parse(payload) as unknown;
    else if (Buffer.isBuffer(payload)) response = JSON.parse(payload.toString("utf8")) as unknown;
    await completeHttpIdempotency(db, { ...lease, statusCode: reply.statusCode, response });
    return payload;
  });

  app.addHook("onRequest", async (request) => {
    logger.info({ requestId: request.id, method: request.method, url: request.url }, "http_request_started");
  });
  app.addHook("onResponse", async (request, reply) => {
    logger.info({ requestId: request.id, method: request.method, url: request.url, statusCode: reply.statusCode }, "http_request_completed");
  });

  app.setErrorHandler((error, request, reply) => {
    const normalized = normalizeError(error);
    if (normalized.definition.status === 500) logger.error({ requestId: request.id, err: error }, "http_request_failed");
    const isExchangeApi = originalUrls.get(request.raw)?.startsWith("/v1/exchange") ?? false;
    reply.status(normalized.definition.status).send({
      success: false,
      error: isExchangeApi
        ? { code: normalized.code, message: normalized.definition.message, retryable: normalized.definition.retryable }
        : normalized.code,
      requestId: request.id,
    });
  });

  app.setNotFoundHandler((request, reply) => {
    const isExchangeApi = originalUrls.get(request.raw)?.startsWith("/v1/exchange") ?? false;
    if (!isExchangeApi) {
      return reply.status(404).send({ success: false, error: "route_not_found", requestId: request.id });
    }
    const definition = ERROR_CATALOG.route_not_found;
    return reply.status(definition.status).send({
      success: false,
      error: { code: "route_not_found", message: definition.message, retryable: definition.retryable },
      requestId: request.id,
    });
  });

  app.get("/health/live", async () => ({ status: "ok", service: "airarena-arc-api" }));
  app.get("/health/ready", async (_request, reply) => {
    const checks: Record<string, boolean> = { database: await databaseReady(db), rpc: false, chain: false, usdc: false, exchange: false };
    try {
      checks.rpc = (await publicClient.getBlockNumber()) >= 0n;
      checks.chain = (await publicClient.getChainId()) === config.chainId;
      checks.usdc = (await publicClient.readContract({ address: config.usdcAddress, abi: erc20Abi, functionName: "decimals" })) === 6;
      checks.exchange = config.exchangeAddress
        ? (await publicClient.getBytecode({ address: config.exchangeAddress })) !== undefined
        : false;
    } catch (error) {
      logger.warn({ err: error }, "api_readiness_chain_check_failed");
    }
    const ready = Object.values(checks).every(Boolean);
    return reply.status(ready ? 200 : 503).send({ status: ready ? "ready" : "not_ready", checks });
  });
  app.get("/metrics", async (_request, reply) => {
    reply.header("content-type", metrics.registry.contentType);
    return metrics.registry.metrics();
  });

  app.get("/v1/network", async () => ({
    success: true,
    data: {
      network: "arc-testnet",
      chainId: config.chainId,
      nativeCurrency: arcTestnet.nativeCurrency,
      usdcAddress: config.usdcAddress,
      usdcApplicationDecimals: 6,
      exchangeAddress: config.exchangeAddress ?? null,
      explorerUrl: ARC_EXPLORER_URL,
    },
  }));

  app.get("/v1/errors", async () => ({ success: true, data: publicErrorCatalog() }));
  app.get("/v1/openapi.json", async (_request, reply) => {
    reply.header("content-type", "application/json; charset=utf-8");
    return buildExchangeOpenApi(Object.keys(ERROR_CATALOG) as Array<keyof typeof ERROR_CATALOG>);
  });

  app.get<{ Querystring: { limit?: string } }>("/v1/fixtures", async (request) => {
    const limit = Math.min(100, Math.max(1, Number(request.query.limit ?? 50) || 50));
    const response = await fetch(`${config.txlineSourceUrl}/v1/txline/fixtures?limit=${limit}`, {
      signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json", "user-agent": "airarena-arc-api/0.1" },
    });
    if (!response.ok) throw new Error(`txline_source_http_${response.status}`);
    return { success: true, source: "txline", data: await response.json() };
  });

  app.get<{ Querystring: { status?: string; category?: string; limit?: string } }>("/v1/markets", async (request) => {
    const limit = Math.min(100, Math.max(1, Number(request.query.limit ?? 50) || 50));
    const values: unknown[] = [];
    const clauses: string[] = [];
    if (request.query.status) {
      const status = request.query.status.toUpperCase();
      if (!["QUEUED", "OPEN", "RESOLVED", "INVALID"].includes(status)) throw new Error("invalid_market_status");
      values.push(status);
      clauses.push(`status = $${values.length}`);
    }
    if (request.query.category) {
      const category = request.query.category.toUpperCase();
      if (!["SPORTS", "CRYPTO", "POLITICS"].includes(category)) throw new Error("invalid_market_category");
      values.push(category);
      clauses.push(`category = $${values.length}`);
    }
    values.push(limit);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await db.query(
      `SELECT market_id, fixture_id, external_id_hash, outcome_count, close_time, status,
              category, oracle_source, oracle_reference, display_title, outcome_labels, resolution_rules,
              settlement_policy, winning_outcome, result_home_score, result_away_score,
              result_source, result_source_update_id, result_source_timestamp, result_observed_at,
              result_evidence_hash, create_tx_hash, resolution_tx_hash, created_at, updated_at
       FROM arc_markets ${where} ORDER BY close_time ASC LIMIT $${values.length}`,
      values,
    );
    return { success: true, data: result.rows };
  });

  app.get<{ Params: { marketId: string } }>("/v1/markets/:marketId", async (request) => {
    if (!isHex(request.params.marketId, { strict: true }) || request.params.marketId.length !== 66) {
      throw new Error("invalid_market_id");
    }
    const result = await db.query(
      `SELECT market_id, fixture_id, external_id_hash, outcome_count, close_time, status,
              category, oracle_source, oracle_reference, display_title, outcome_labels, resolution_rules,
              settlement_policy, winning_outcome, result_home_score, result_away_score,
              result_source, result_source_update_id, result_source_timestamp, result_observed_at,
              result_evidence_hash, create_tx_hash, resolution_tx_hash, created_at, updated_at
         FROM arc_markets WHERE market_id = $1`,
      [request.params.marketId],
    );
    if (!result.rows[0]) throw new Error("market_not_found");
    return { success: true, data: result.rows[0] };
  });

  app.get<{ Params: { marketId: string } }>("/v1/markets/:marketId/orderbook", async (request) => {
    if (!isHex(request.params.marketId, { strict: true }) || request.params.marketId.length !== 66) {
      throw new Error("invalid_market_id");
    }
    const orderbook = await readOrderbook(db, request.params.marketId);
    if (!orderbook) throw new Error("market_not_found");
    return { success: true, data: orderbook };
  });

  app.get<{ Querystring: { limit?: string } }>("/v1/agents", async (request) => {
    const limit = Math.min(100, Math.max(1, Number(request.query.limit ?? 50) || 50));
    return { success: true, data: await readAgentDirectory(db, limit) };
  });

  app.post<{ Body: { wallet?: string } }>("/v1/auth/challenge", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request) => {
    return { success: true, data: await createChallenge(db, config, request.body?.wallet ?? "") };
  });

  app.post<{ Body: { wallet?: string; nonce?: string; signature?: Hex } }>(
    "/v1/auth/token",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request) => {
      const { wallet, nonce, signature } = request.body ?? {};
      if (!wallet || !nonce || !signature || !isHex(signature)) throw new Error("invalid_signature");
      return {
        success: true,
        data: await exchangeChallengeForToken(db, config, { wallet, nonce, signature }, publicClient),
      };
    },
  );

  app.get<{ Querystring: { marketId?: string } }>("/v1/account", async (request) => {
    if (!config.exchangeAddress) throw new Error("exchange_not_configured");
    const agent = await authenticateBearer(db, config, bearer(request), "orders:read");
    const marketId = request.query.marketId;
    if (marketId && (!isHex(marketId, { strict: true }) || marketId.length !== 66)) {
      throw new Error("invalid_market_id");
    }
    const [walletBalance, allowance, availableCollateral] = await Promise.all([
      publicClient.readContract({
        address: config.usdcAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [agent.wallet],
      }),
      publicClient.readContract({
        address: config.usdcAddress,
        abi: erc20Abi,
        functionName: "allowance",
        args: [agent.wallet, config.exchangeAddress],
      }),
      publicClient.readContract({
        address: config.exchangeAddress,
        abi: arenaExchangeAbi,
        functionName: "availableCollateral",
        args: [agent.wallet],
      }),
    ]);
    let positions: string[] = [];
    if (marketId) {
      const market = await db.query<{ outcome_count: number }>(
        "SELECT outcome_count FROM arc_markets WHERE market_id = $1",
        [marketId],
      );
      const outcomeCount = market.rows[0]?.outcome_count ?? 0;
      positions = await Promise.all(
        Array.from({ length: outcomeCount }, (_unused, outcome) =>
          publicClient.readContract({
            address: config.exchangeAddress!,
            abi: arenaExchangeAbi,
            functionName: "positions",
            args: [marketId as Hex, outcome, agent.wallet],
          }).then((value) => value.toString()),
        ),
      );
    }
    return {
      success: true,
      data: {
        wallet: agent.wallet,
        walletBalance: walletBalance.toString(),
        exchangeAllowance: allowance.toString(),
        availableCollateral: availableCollateral.toString(),
        marketId: marketId ?? null,
        positions,
      },
    };
  });

  app.post<{ Body: unknown }>("/v1/orders/prepare", async (request) => {
    if (!config.exchangeAddress) throw new Error("exchange_not_configured");
    const agent = await authenticateBearer(db, config, bearer(request), "orders:write");
    const input = PrepareOrderSchema.parse(request.body);
    const market = await db.query<OrderableMarketState>(
      "SELECT outcome_count, status, close_time FROM arc_markets WHERE market_id = $1",
      [input.marketId],
    );
    validateOrderableMarket(market.rows[0], input.outcome);
    const order = createArcOrder(agent.wallet, input);
    return {
      success: true,
      data: {
        order: jsonOrder(order),
        orderHash: hashArcOrder(config.exchangeAddress, order),
        typedData: serializeUnknown({
          domain: orderDomain(config.exchangeAddress),
          types: orderTypes,
          primaryType: "Order",
          message: order,
        }),
      },
    };
  });

  app.post<{ Body: unknown }>("/v1/orders/submit", async (request, reply) => {
    if (!config.exchangeAddress) throw new Error("exchange_not_configured");
    const agent = await authenticateBearer(db, config, bearer(request), "orders:write");
    const parsed = SubmitOrderSchema.parse(request.body);
    if (getAddress(parsed.order.maker) !== agent.wallet) throw new Error("order_maker_mismatch");
    const order = parsed.order as ArcOrder;
    const orderHash = hashArcOrder(config.exchangeAddress, order);
    const valid = await verifyWalletDigest(publicClient, agent.wallet, orderHash, parsed.signature as Hex);
    if (!valid) throw new Error("invalid_signature");
    idempotencyKey(request);
    const key = `submit-order:${orderHash}`;
    const existingReceipt = await readAcceptanceReceipt(db, orderHash);
    if (existingReceipt) {
      const existingJob = await db.query<{ id: string; status: string }>(
        "SELECT id, status FROM arc_jobs WHERE idempotency_key = $1",
        [key],
      );
      return reply.status(200).send({
        success: true,
        data: { orderHash, receipt: existingReceipt, job: existingJob.rows[0] ?? null },
      });
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const market = await client.query<OrderableMarketState>(
        "SELECT outcome_count, status, close_time FROM arc_markets WHERE market_id = $1 FOR SHARE",
        [order.marketId],
      );
      validateOrderableMarket(market.rows[0], order.outcome);
      await claimNonce(client, agent.wallet, "ORDER", order.nonce, orderHash);
      const inserted = await client.query(
        `INSERT INTO arc_orders(
          order_hash, maker, market_id, outcome, side, price_ppm, quantity, nonce,
          expiry, client_order_id, signature, status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9),$10,$11,'QUEUED')
        ON CONFLICT (order_hash) DO NOTHING`,
        [
          orderHash, agent.wallet, order.marketId, order.outcome, order.isBuy ? "BUY" : "SELL",
          order.pricePpm.toString(), order.quantity.toString(), order.nonce.toString(), order.expiry.toString(),
          order.clientOrderId, parsed.signature,
        ],
      );
      if ((inserted.rowCount ?? 0) === 0) {
        const receipt = await readAcceptanceReceipt(client, orderHash);
        if (!receipt) throw new Error("order_exists_without_receipt");
        const existingJob = await client.query<{ id: string; status: string }>(
          "SELECT id, status FROM arc_jobs WHERE idempotency_key = $1",
          [key],
        );
        await client.query("COMMIT");
        return reply.status(200).send({
          success: true,
          data: { orderHash, receipt, job: existingJob.rows[0] ?? null },
        });
      }

      const requestHash = orderRequestHash(orderHash, parsed.signature as Hex);
      const accepted = await appendOrderEvent(client, orderHash, "ORDER_ACCEPTED", {
        maker: agent.wallet,
        orderHash,
        requestHash,
      });
      await client.query(
        "UPDATE arc_orders SET accepted_sequence = $2 WHERE order_hash = $1",
        [orderHash, accepted.sequence.toString()],
      );
      const receipt = await createAcceptanceReceipt(client, config, {
        orderHash,
        maker: agent.wallet,
        sequence: accepted.sequence,
        acceptedAt: accepted.occurredAt,
        requestHash,
      });
      const job = await enqueueJob(
        client,
        "SUBMIT_ORDER",
        { order: jsonOrder(order), signature: parsed.signature, orderHash },
        key,
        agent.wallet,
      );
      await client.query("COMMIT");
      return reply.status(job.created ? 202 : 200).send({ success: true, data: { orderHash, receipt, job } });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  app.post<{ Body: unknown }>("/v1/orders/cancellations/prepare", async (request) => {
    if (!config.exchangeAddress) throw new Error("exchange_not_configured");
    const agent = await authenticateBearer(db, config, bearer(request), "orders:write");
    const input = PrepareCancelSchema.parse(request.body);
    const result = await db.query<{
      maker: string;
      status: string;
      assigned_batch_id: string | null;
      before_cancellation_cutoff: boolean | null;
    }>(
      `SELECT o.maker, o.status, o.assigned_batch_id,
              CASE WHEN o.assigned_batch_id IS NULL THEN NULL
                   ELSE b.cancellation_cutoff > clock_timestamp() END AS before_cancellation_cutoff
         FROM arc_orders o
         LEFT JOIN arc_batches b ON b.batch_id = o.assigned_batch_id
        WHERE o.order_hash = $1`,
      [input.orderHash],
    );
    const order = result.rows[0];
    if (!order) throw new Error("order_not_found");
    if (getAddress(order.maker) !== agent.wallet) throw new Error("order_maker_mismatch");
    if (order.assigned_batch_id && !order.before_cancellation_cutoff) {
      throw new Error("order_cancellation_cutoff_elapsed");
    }
    if (!["QUEUED", "SUBMITTED", "ACTIVE", "CANCEL_PENDING"].includes(order.status)) {
      if (order.status === "MATCHING") throw new Error("order_batch_locked");
      throw new Error("order_not_cancellable");
    }
    const cancellation = createArcCancel(agent.wallet, input);
    return {
      success: true,
      data: {
        cancellation: jsonCancel(cancellation),
        cancellationHash: hashArcCancel(config.exchangeAddress, cancellation),
        typedData: serializeUnknown({
          domain: orderDomain(config.exchangeAddress),
          types: cancelTypes,
          primaryType: "Cancel",
          message: cancellation,
        }),
      },
    };
  });

  app.post<{ Body: unknown }>("/v1/orders/cancellations/submit", async (request, reply) => {
    if (!config.exchangeAddress) throw new Error("exchange_not_configured");
    const agent = await authenticateBearer(db, config, bearer(request), "orders:write");
    const parsed = SubmitCancelSchema.parse(request.body);
    const cancellation: ArcCancel = {
      ...parsed.cancellation,
      orderHash: parsed.cancellation.orderHash as Hex,
    };
    if (getAddress(cancellation.maker) !== agent.wallet) throw new Error("order_maker_mismatch");
    const cancellationHash = hashArcCancel(config.exchangeAddress, cancellation);
    if (!await verifyWalletDigest(publicClient, agent.wallet, cancellationHash, parsed.signature as Hex)) {
      throw new Error("invalid_signature");
    }
    idempotencyKey(request);
    const key = `cancel-order:${cancellationHash}`;
    const existingJob = await db.query<{ id: string; status: string }>(
      "SELECT id, status FROM arc_jobs WHERE idempotency_key = $1",
      [key],
    );
    if (existingJob.rows[0]) {
      return reply.status(200).send({
        success: true,
        data: { orderHash: cancellation.orderHash, cancellationHash, job: existingJob.rows[0] },
      });
    }
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const orderResult = await client.query<{
        maker: string;
        status: string;
        assigned_batch_id: string | null;
        cancellation_digest: string | null;
        before_cancellation_cutoff: boolean | null;
      }>(
        `SELECT o.maker, o.status, o.assigned_batch_id, o.cancellation_digest,
                CASE WHEN o.assigned_batch_id IS NULL THEN NULL
                     ELSE b.cancellation_cutoff > clock_timestamp() END AS before_cancellation_cutoff
           FROM arc_orders o
           LEFT JOIN arc_batches b ON b.batch_id = o.assigned_batch_id
          WHERE o.order_hash = $1 FOR UPDATE OF o`,
        [cancellation.orderHash],
      );
      const order = orderResult.rows[0];
      if (!order) throw new Error("order_not_found");
      if (getAddress(order.maker) !== agent.wallet) throw new Error("order_maker_mismatch");
      if (order.status === "MATCHING") throw new Error("order_batch_locked");
      if (order.assigned_batch_id && !order.before_cancellation_cutoff) {
        throw new Error("order_cancellation_cutoff_elapsed");
      }
      if (order.status === "CANCEL_PENDING" && order.cancellation_digest?.toLowerCase() !== cancellationHash.toLowerCase()) {
        throw new Error("cancellation_already_pending");
      }
      if (!["QUEUED", "SUBMITTED", "ACTIVE", "CANCEL_PENDING"].includes(order.status)) {
        throw new Error("order_not_cancellable");
      }
      await claimNonce(client, agent.wallet, "CANCEL", cancellation.nonce, cancellationHash);
      if (order.status !== "CANCEL_PENDING") {
        if (order.assigned_batch_id) {
          await client.query(
            `UPDATE arc_batch_orders SET released_at = clock_timestamp()
              WHERE batch_id = $1 AND order_hash = $2 AND released_at IS NULL`,
            [order.assigned_batch_id, cancellation.orderHash],
          );
        }
        await client.query(
          `UPDATE arc_orders
              SET status = 'CANCEL_PENDING', cancellation_nonce = $2,
                  cancellation_deadline = to_timestamp($3), cancellation_signature = $4,
                  cancellation_digest = $5, assigned_batch_id = NULL, updated_at = now()
            WHERE order_hash = $1`,
          [
            cancellation.orderHash,
            cancellation.nonce.toString(),
            cancellation.deadline.toString(),
            parsed.signature,
            cancellationHash,
          ],
        );
        await appendOrderEvent(client, cancellation.orderHash, "ORDER_CANCEL_ACCEPTED", {
          cancellationHash,
          deadline: cancellation.deadline.toString(),
          maker: agent.wallet,
          nonce: cancellation.nonce.toString(),
        });
      }
      const job = await enqueueJob(
        client,
        "CANCEL_ORDER",
        { cancellation: jsonCancel(cancellation), signature: parsed.signature, cancellationHash },
        key,
        agent.wallet,
      );
      await client.query("COMMIT");
      return reply.status(job.created ? 202 : 200).send({
        success: true,
        data: { orderHash: cancellation.orderHash, cancellationHash, job },
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  app.get<{ Params: { orderHash: string } }>("/v1/orders/:orderHash/receipt", async (request) => {
    const agent = await authenticateBearer(db, config, bearer(request), "orders:read");
    if (!isHex(request.params.orderHash, { strict: true }) || request.params.orderHash.length !== 66) {
      throw new Error("invalid_order_hash");
    }
    const receipt = await readAcceptanceReceipt(db, request.params.orderHash as Hex);
    if (receipt && receipt.maker !== agent.wallet) throw new Error("order_maker_mismatch");
    return { success: true, data: receipt };
  });

  app.get<{ Querystring: { limit?: string } }>("/v1/orders", async (request) => {
    const agent = await authenticateBearer(db, config, bearer(request), "orders:read");
    const limit = Math.min(100, Math.max(1, Number(request.query.limit ?? 50) || 50));
    const result = await db.query(
      `SELECT order_hash, maker, market_id, outcome, side, price_ppm, quantity, filled_quantity, nonce, expiry,
              client_order_id, status, tx_hash, accepted_sequence, assigned_batch_id, created_at, updated_at
       FROM arc_orders WHERE maker = $1 ORDER BY created_at DESC LIMIT $2`,
      [agent.wallet, limit],
    );
    return { success: true, data: result.rows };
  });

  app.get<{ Params: { orderHash: string } }>("/v1/orders/:orderHash", async (request) => {
    const agent = await authenticateBearer(db, config, bearer(request), "orders:read");
    if (!isHex(request.params.orderHash, { strict: true }) || request.params.orderHash.length !== 66) {
      throw new Error("invalid_order_hash");
    }
    const result = await db.query(
      `SELECT order_hash, maker, market_id, outcome, side, price_ppm, quantity, filled_quantity, nonce, expiry,
              client_order_id, status, tx_hash, accepted_sequence, assigned_batch_id,
              cancellation_nonce, cancellation_deadline, cancellation_digest, created_at, updated_at
         FROM arc_orders WHERE order_hash = $1 AND maker = $2`,
      [request.params.orderHash, agent.wallet],
    );
    if (!result.rows[0]) throw new Error("order_not_found");
    return { success: true, data: result.rows[0] };
  });

  app.get<{ Params: { batchId: string } }>("/v1/batches/:batchId", async (request) => {
    if (!isHex(request.params.batchId, { strict: true }) || request.params.batchId.length !== 66) {
      throw new Error("batch_not_found");
    }
    const result = await db.query(
      `SELECT b.batch_id, b.market_id, b.outcome, b.policy_version, b.policy_hash,
              b.batch_start, b.batch_end, b.cancellation_cutoff, b.status,
              b.input_root, b.result_hash, b.clearing_price_ppm, b.executable_quantity,
              b.sealed_at, b.executed_at, p.order_root, p.fill_root, p.bundle_hash, p.published_at
         FROM arc_batches b
         LEFT JOIN arc_batch_publications p ON p.batch_id = b.batch_id
        WHERE b.batch_id = $1`,
      [request.params.batchId],
    );
    if (!result.rows[0]) throw new Error("batch_not_found");
    return { success: true, data: result.rows[0] };
  });

  app.get<{ Params: { batchId: string } }>("/v1/batches/:batchId/bundle", async (request, reply) => {
    if (!isHex(request.params.batchId, { strict: true }) || request.params.batchId.length !== 66) {
      throw new Error("batch_not_found");
    }
    const result = await db.query<{ bundle: unknown; bundle_hash: string }>(
      "SELECT bundle, bundle_hash FROM arc_batch_publications WHERE batch_id = $1",
      [request.params.batchId],
    );
    if (!result.rows[0]) throw new Error("batch_bundle_not_found");
    reply.header("etag", `\"${result.rows[0].bundle_hash}\"`);
    reply.header("cache-control", "public, max-age=31536000, immutable");
    return { success: true, data: result.rows[0].bundle };
  });

  app.get<{ Querystring: { cursor?: string; limit?: string; topics?: string } }>("/v1/events", async (request) => {
    await authenticateBearer(db, config, bearer(request), "orders:read");
    const cursor = parseResumeCursor(request.query.cursor);
    const limit = Math.min(500, Math.max(1, Number(request.query.limit ?? 100) || 100));
    const topics = parseEventTopics(request.query.topics);
    const events = await readExchangeEventsAfter(db, cursor, limit, topics);
    return {
      success: true,
      data: {
        protocol: EVENT_STREAM_PROTOCOL,
        events,
        resumeCursor: events.at(-1)?.resumeCursor ?? cursor.toString(),
      },
    };
  });

  app.get<{ Querystring: { cursor?: string; topics?: string } }>(
    "/v1/stream",
    { websocket: true },
    (socket, request) => {
      let closed = false;
      socket.on("close", () => { closed = true; });
      socket.on("error", (error) => logger.warn({ err: error, requestId: request.id }, "event_stream_socket_error"));
      void (async () => {
        try {
          await authenticateBearer(db, config, bearer(request), "orders:read");
          let cursor = parseResumeCursor(request.query.cursor);
          const topics = parseEventTopics(request.query.topics);
          socket.send(JSON.stringify({ type: "ready", protocol: EVENT_STREAM_PROTOCOL, resumeCursor: cursor.toString() }));
          let lastHeartbeat = Date.now();
          while (!closed && socket.readyState === 1) {
            if (socket.bufferedAmount > 8 * 1024 * 1024) {
              socket.close(1013, "client_backpressure_limit");
              break;
            }
            if (socket.bufferedAmount <= 1024 * 1024) {
              const page = await readResumableEventPage(
                (after, limit) => readExchangeEventsAfter(db, after, limit, topics),
                cursor,
                100,
              );
              for (const event of page.events) socket.send(JSON.stringify({ type: "event", ...event }));
              cursor = page.cursor;
            }
            if (Date.now() - lastHeartbeat >= 15_000) {
              socket.send(JSON.stringify({ type: "heartbeat", resumeCursor: cursor.toString() }));
              lastHeartbeat = Date.now();
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        } catch (error) {
          const normalized = normalizeError(error);
          if (socket.readyState === 1) {
            socket.send(JSON.stringify({
              type: "error",
              error: { code: normalized.code, message: normalized.definition.message, retryable: normalized.definition.retryable },
            }));
            socket.close(1008, normalized.code);
          }
        }
      })();
    },
  );

  app.get<{ Params: { id: string } }>("/v1/jobs/:id", async (request) => {
    const agent = await authenticateBearer(db, config, bearer(request), "orders:read");
    const result = await db.query(
      `SELECT id, kind, status, attempts, max_attempts, available_at, last_error, tx_hash, created_at, updated_at
       FROM arc_jobs WHERE id = $1 AND owner_wallet = $2`,
      [request.params.id, agent.wallet],
    );
    const row = result.rows[0];
    if (!row) throw new Error("job_not_found");
    return { success: true, data: { ...row, explorerUrl: row.tx_hash ? transactionUrl(row.tx_hash) : null } };
  });

  app.post<{ Body: unknown }>("/v1/operator/markets", async (request, reply) => {
    if (!operatorAuthorized(config.operatorToken, operatorToken(request))) throw new Error("operator_unauthorized");
    const input = CreateMarketSchema.parse(request.body);
    const closeTime = new Date(input.closeTime);
    if (closeTime.getTime() <= Date.now()) throw new Error("invalid_close_time");
    const identifiers = marketIdentifiers(input.fixtureId);
    idempotencyKey(request);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO arc_markets(
           market_id, fixture_id, external_id_hash, outcome_count, close_time, status, settlement_policy,
           category, oracle_source, oracle_reference, display_title, outcome_labels, resolution_rules,
           spec_hash, resolution_rule
         ) VALUES ($1,$2,$3,$4,$5,'QUEUED','TXLINE_1X2_REGULATION',$6,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb)
         ON CONFLICT (market_id) DO NOTHING`,
        [
          identifiers.marketId, input.fixtureId, identifiers.externalIdHash, input.outcomeCount, closeTime,
          input.category, input.oracleSource, input.fixtureId, input.displayTitle ?? null,
          JSON.stringify(input.outcomeLabels), input.resolutionRules, input.specHash,
          JSON.stringify(serializeUnknown(input.resolutionRule)),
        ],
      );
      const job = await enqueueJob(
        client,
        "CREATE_MARKET",
        serializeUnknown({
          ...identifiers,
          fixtureId: input.fixtureId,
          specHash: input.specHash,
          outcomeCount: input.outcomeCount,
          closeTime: Math.floor(closeTime.getTime() / 1000).toString(),
          resolutionRule: input.resolutionRule,
        }) as Record<string, unknown>,
        `create-market:${identifiers.marketId}`,
      );
      await client.query("COMMIT");
      return reply.status(job.created ? 202 : 200).send({ success: true, data: { ...identifiers, job } });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  app.post<{ Params: { marketId: string }; Body: unknown }>("/v1/operator/markets/:marketId/resolve", async (request, reply) => {
    if (!operatorAuthorized(config.operatorToken, operatorToken(request))) throw new Error("operator_unauthorized");
    if (!isHex(request.params.marketId, { strict: true }) || request.params.marketId.length !== 66) throw new Error("invalid_market_id");
    const input = ResolveMarketSchema.parse(request.body);
    const job = await enqueueJob(
      db,
      "RESOLVE_MARKET",
      serializeUnknown({ marketId: request.params.marketId, primary: input.primary, witness: input.witness }) as Record<string, unknown>,
      `resolve-market:${request.params.marketId}:${idempotencyKey(request)}`,
    );
    await db.query(
      "UPDATE arc_markets SET resolution_job_id = $2, updated_at = now() WHERE market_id = $1 AND status = 'OPEN'",
      [request.params.marketId, job.id],
    );
    return reply.status(job.created ? 202 : 200).send({ success: true, data: { job } });
  });

  app.post<{ Params: { marketId: string } }>("/v1/operator/markets/:marketId/invalidate", async (request, reply) => {
    if (!operatorAuthorized(config.operatorToken, operatorToken(request))) throw new Error("operator_unauthorized");
    if (!isHex(request.params.marketId, { strict: true }) || request.params.marketId.length !== 66) throw new Error("invalid_market_id");
    const job = await enqueueJob(
      db,
      "INVALIDATE_AFTER_GRACE",
      { marketId: request.params.marketId },
      `invalidate-market:${request.params.marketId}:${idempotencyKey(request)}`,
    );
    return reply.status(job.created ? 202 : 200).send({ success: true, data: { job } });
  });

  app.addHook("onClose", async () => db.end());
  return app;
}

export async function startApi(config: ArcConfig, logger: Logger): Promise<void> {
  const app = await buildApi({ config, logger });
  await app.listen({ host: "0.0.0.0", port: config.port });
  logger.info({ port: config.port }, "arc_api_started");
}
