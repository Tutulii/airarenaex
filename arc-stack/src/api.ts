import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
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
import { enqueueJob } from "./jobs.js";
import type { Logger } from "./logger.js";
import { validateOrderableMarket, type OrderableMarketState } from "./market-policy.js";
import { createMetrics } from "./metrics.js";
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

export async function buildApi(dependencies: ApiDependencies) {
  const { config, logger } = dependencies;
  const db = dependencies.db ?? createDatabase(config);
  await migrateDatabase(db, logger);
  if (config.exchangeAddress) await bindDatabaseToExchange(db, config.chainId, config.exchangeAddress);
  const publicClient = createArcPublicClient(config);
  const metrics = createMetrics("airarena-arc-api");
  const app = Fastify({
    logger: false,
    bodyLimit: 256 * 1024,
    requestIdHeader: "x-request-id",
    genReqId: (request) => request.headers["x-request-id"]?.toString() ?? randomUUID(),
    trustProxy: true,
  });

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

  app.addHook("onRequest", async (request) => {
    logger.info({ requestId: request.id, method: request.method, url: request.url }, "http_request_started");
  });
  app.addHook("onResponse", async (request, reply) => {
    logger.info({ requestId: request.id, method: request.method, url: request.url, statusCode: reply.statusCode }, "http_request_completed");
  });

  app.setErrorHandler((error, request, reply) => {
    const message = error instanceof Error ? error.message : "unknown_error";
    const name = error instanceof Error ? error.name : "UnknownError";
    const statusByMessage: Record<string, number> = {
      invalid_wallet: 400,
      challenge_invalid_or_expired: 401,
      invalid_signature: 401,
      missing_or_invalid_bearer_token: 401,
      invalid_bearer_token: 401,
      insufficient_scope: 403,
      valid_idempotency_key_required: 400,
      operator_unauthorized: 403,
      exchange_not_configured: 503,
      order_maker_mismatch: 403,
      invalid_close_time: 400,
      invalid_market_id: 400,
      invalid_market_category: 400,
      invalid_market_status: 400,
      invalid_market_outcome: 400,
      market_not_found: 404,
      market_not_open: 409,
      market_closed: 409,
      nonce_digest_conflict: 409,
      order_not_found: 404,
      order_not_cancellable: 409,
      order_batch_locked: 409,
      cancellation_already_pending: 409,
      invalid_order_hash: 400,
      receipt_signer_unavailable: 503,
    };
    const status = name === "ZodError" ? 400 : statusByMessage[message] ?? 500;
    if (status === 500) logger.error({ requestId: request.id, err: error }, "http_request_failed");
    reply.status(status).send({
      success: false,
      error: status === 500 ? "internal_error" : message,
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

  app.get<{ Params: { marketId: string } }>("/v1/markets/:marketId/orderbook", async (request, reply) => {
    if (!isHex(request.params.marketId, { strict: true }) || request.params.marketId.length !== 66) {
      throw new Error("invalid_market_id");
    }
    const orderbook = await readOrderbook(db, request.params.marketId);
    if (!orderbook) {
      return reply.status(404).send({ success: false, error: "market_not_found", requestId: request.id });
    }
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
    const result = await db.query<{ maker: string; status: string }>(
      "SELECT maker, status FROM arc_orders WHERE order_hash = $1",
      [input.orderHash],
    );
    const order = result.rows[0];
    if (!order) throw new Error("order_not_found");
    if (getAddress(order.maker) !== agent.wallet) throw new Error("order_maker_mismatch");
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
      }>(
        `SELECT maker, status, assigned_batch_id, cancellation_digest
           FROM arc_orders WHERE order_hash = $1 FOR UPDATE`,
        [cancellation.orderHash],
      );
      const order = orderResult.rows[0];
      if (!order) throw new Error("order_not_found");
      if (getAddress(order.maker) !== agent.wallet) throw new Error("order_maker_mismatch");
      if (order.status === "MATCHING") throw new Error("order_batch_locked");
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

  app.get<{ Params: { id: string } }>("/v1/jobs/:id", async (request) => {
    const agent = await authenticateBearer(db, config, bearer(request), "orders:read");
    const result = await db.query(
      `SELECT id, kind, status, attempts, max_attempts, available_at, last_error, tx_hash, created_at, updated_at
       FROM arc_jobs WHERE id = $1 AND owner_wallet = $2`,
      [request.params.id, agent.wallet],
    );
    const row = result.rows[0];
    return { success: true, data: row ? { ...row, explorerUrl: row.tx_hash ? transactionUrl(row.tx_hash) : null } : null };
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
           category, oracle_source, oracle_reference, display_title, outcome_labels, resolution_rules
         ) VALUES ($1,$2,$3,$4,$5,'QUEUED','TXLINE_1X2_REGULATION',$6,$7,$8,$9,$10::jsonb,$11)
         ON CONFLICT (market_id) DO NOTHING`,
        [
          identifiers.marketId, input.fixtureId, identifiers.externalIdHash, input.outcomeCount, closeTime,
          input.category, input.oracleSource, input.fixtureId, input.displayTitle ?? null,
          JSON.stringify(input.outcomeLabels), input.resolutionRules,
        ],
      );
      const job = await enqueueJob(
        client,
        "CREATE_MARKET",
        { ...identifiers, fixtureId: input.fixtureId, outcomeCount: input.outcomeCount, closeTime: Math.floor(closeTime.getTime() / 1000).toString() },
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
      { marketId: request.params.marketId, winningOutcome: input.winningOutcome },
      `resolve-market:${request.params.marketId}:${idempotencyKey(request)}`,
    );
    return reply.status(job.created ? 202 : 200).send({ success: true, data: { job } });
  });

  app.post<{ Params: { marketId: string } }>("/v1/operator/markets/:marketId/invalidate", async (request, reply) => {
    if (!operatorAuthorized(config.operatorToken, operatorToken(request))) throw new Error("operator_unauthorized");
    if (!isHex(request.params.marketId, { strict: true }) || request.params.marketId.length !== 66) throw new Error("invalid_market_id");
    const job = await enqueueJob(
      db,
      "INVALIDATE_MARKET",
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
