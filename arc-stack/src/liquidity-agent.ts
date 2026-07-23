import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ArcConfig } from "./config.js";
import type { Database } from "./db.js";
import type { Logger } from "./logger.js";
import { assertLiquidityQuote, type LiquidityRiskState } from "./risk-controls.js";

type JsonResponse = { success?: boolean; data?: Record<string, unknown>; error?: Record<string, unknown> };

async function jsonRequest(url: string, init: RequestInit): Promise<JsonResponse> {
  const response = await fetch(url, init);
  const body = await response.json() as JsonResponse;
  if (!response.ok || body.success === false) {
    const code = typeof body.error?.code === "string" ? body.error.code : `http_${response.status}`;
    throw new Error(`liquidity_agent_${code}`);
  }
  return body;
}

export type LiquidityQuoteIntent = {
  marketId: Hex;
  outcome: 0 | 1 | 2;
  side: "BUY" | "SELL";
  pricePpm: bigint;
  quantity: bigint;
  expiry: bigint;
  nonce: bigint;
  clientOrderId: string;
};

async function authenticateLiquidityAgent(apiUrl: string, privateKey: Hex): Promise<{
  account: ReturnType<typeof privateKeyToAccount>;
  token: string;
}> {
  const account = privateKeyToAccount(privateKey);
  const challengeResponse = await jsonRequest(`${apiUrl}/v1/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: account.address }),
  });
  const challenge = challengeResponse.data;
  if (!challenge || typeof challenge.nonce !== "string" || typeof challenge.message !== "string") {
    throw new Error("liquidity_agent_invalid_challenge");
  }
  const authSignature = await account.signMessage({ message: challenge.message });
  const tokenResponse = await jsonRequest(`${apiUrl}/v1/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet: account.address, nonce: challenge.nonce, signature: authSignature }),
  });
  const token = tokenResponse.data?.token;
  if (typeof token !== "string") throw new Error("liquidity_agent_token_missing");
  return { account, token };
}

export async function submitProtocolLiquidityQuote(input: {
  config: Pick<ArcConfig, "apiUrl" | "liquidityAgentPrivateKey" | "liquidityLimits">;
  quote: LiquidityQuoteIntent;
  riskState: LiquidityRiskState;
  oracleHealthy: boolean;
}): Promise<{ orderHash: Hex; job: unknown }> {
  if (!input.config.liquidityAgentPrivateKey) throw new Error("liquidity_agent_not_configured");
  if (!input.oracleHealthy) throw new Error("liquidity_oracle_unhealthy");
  const notional = (input.quote.quantity * input.quote.pricePpm + 999_999n) / 1_000_000n;
  // A sell reserves existing claims; it does not reduce inventory until the
  // batch actually fills. Admission therefore treats sells as zero delta and
  // buys as their full worst-case additional inventory.
  const inventoryDelta = input.quote.side === "BUY" ? input.quote.quantity : 0n;
  assertLiquidityQuote(input.riskState, input.config.liquidityLimits, notional, inventoryDelta);

  const { account, token } = await authenticateLiquidityAgent(
    input.config.apiUrl,
    input.config.liquidityAgentPrivateKey,
  );

  const prepareResponse = await jsonRequest(`${input.config.apiUrl}/v1/orders/prepare`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      marketId: input.quote.marketId,
      outcome: input.quote.outcome,
      side: input.quote.side,
      pricePpm: input.quote.pricePpm.toString(),
      quantity: input.quote.quantity.toString(),
      expiry: input.quote.expiry.toString(),
      nonce: input.quote.nonce.toString(),
      clientOrderId: input.quote.clientOrderId,
    }),
  });
  const prepared = prepareResponse.data;
  if (!prepared || !prepared.typedData || !prepared.order || typeof prepared.orderHash !== "string") {
    throw new Error("liquidity_agent_prepare_invalid");
  }
  const typedData = prepared.typedData as {
    domain: Record<string, unknown>;
    types: Record<string, readonly { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, unknown>;
  };
  const signature = await account.signTypedData(typedData as Parameters<typeof account.signTypedData>[0]);
  const submitResponse = await jsonRequest(`${input.config.apiUrl}/v1/orders/submit`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": `liquidity:${getAddress(account.address)}:${input.quote.nonce.toString()}`,
    },
    body: JSON.stringify({ order: prepared.order, signature }),
  });
  if (typeof submitResponse.data?.orderHash !== "string") throw new Error("liquidity_agent_submit_invalid");
  return { orderHash: submitResponse.data.orderHash as Hex, job: submitResponse.data.job };
}

export async function cancelProtocolLiquidityOrders(input: {
  config: Pick<ArcConfig, "apiUrl" | "liquidityAgentPrivateKey">;
  marketId: Hex;
  nowMs?: number;
}): Promise<{ submitted: number; skipped: number }> {
  if (!input.config.liquidityAgentPrivateKey) throw new Error("liquidity_agent_not_configured");
  const { account, token } = await authenticateLiquidityAgent(
    input.config.apiUrl,
    input.config.liquidityAgentPrivateKey,
  );
  const list = await jsonRequest(`${input.config.apiUrl}/v1/orders?limit=100`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  const orders = Array.isArray(list.data) ? list.data : [];
  let submitted = 0;
  let skipped = 0;
  const nowSeconds = BigInt(Math.floor((input.nowMs ?? Date.now()) / 1_000));
  for (let index = 0; index < orders.length; index += 1) {
    const order = orders[index] as Record<string, unknown>;
    if (order.market_id !== input.marketId || !["QUEUED", "SUBMITTED", "ACTIVE"].includes(String(order.status))) continue;
    try {
      const nonce = nowSeconds * 1_000n + BigInt(index);
      const prepare = await jsonRequest(`${input.config.apiUrl}/v1/orders/cancellations/prepare`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ orderHash: order.order_hash, nonce: nonce.toString(), deadline: (nowSeconds + 300n).toString() }),
      });
      const data = prepare.data;
      if (!data?.typedData || !data.cancellation || typeof data.cancellationHash !== "string") {
        throw new Error("liquidity_agent_cancel_prepare_invalid");
      }
      const signature = await account.signTypedData(data.typedData as Parameters<typeof account.signTypedData>[0]);
      await jsonRequest(`${input.config.apiUrl}/v1/orders/cancellations/submit`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": `liquidity-cancel:${data.cancellationHash}`,
        },
        body: JSON.stringify({ cancellation: data.cancellation, signature }),
      });
      submitted += 1;
    } catch {
      // The normal cancellation endpoint is authoritative for cutoff and batch
      // locks. A rejected cancellation is safely skipped, never bypassed.
      skipped += 1;
    }
  }
  return { submitted, skipped };
}

type LiquidityIntentRow = {
  intent_id: string;
  market_id: Hex;
  outcome: 0 | 1 | 2;
  side: "BUY" | "SELL";
  price_ppm: string;
  quantity: string;
  expiry_seconds: number;
  next_nonce: string;
  funded_atoms: string;
  realized_pnl_atoms: string;
  peak_equity_atoms: string;
  available_atoms: string;
  open_notional_atoms: string;
  daily_volume_atoms: string;
};

async function reserveNextLiquidityIntent(
  db: Database,
  wallet: string,
  oracleStaleAfterSeconds: number,
  oracleRecoveryObservations: number,
): Promise<LiquidityIntentRow | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query<LiquidityIntentRow>(
      `SELECT i.intent_id::text, i.market_id, i.outcome, i.side, i.price_ppm::text,
              i.quantity::text, i.expiry_seconds, i.next_nonce::text,
              b.funded_atoms::text, a.realized_pnl_atoms::text, a.peak_equity_atoms::text,
              LEAST(a.funded_atoms, b.funded_atoms)::text AS available_atoms,
              COALESCE((SELECT sum((o.quantity * o.price_ppm + 999999) / 1000000)
                FROM arc_orders o WHERE o.maker = i.wallet AND o.market_id = i.market_id
                  AND o.status IN ('QUEUED','SUBMITTED','ACTIVE','MATCHING')),0)::text AS open_notional_atoms,
              COALESCE((SELECT sum((o.quantity * o.price_ppm + 999999) / 1000000)
                FROM arc_orders o WHERE o.maker = i.wallet AND o.market_id = i.market_id
                  AND o.created_at >= clock_timestamp() - interval '24 hours'),0)::text AS daily_volume_atoms
         FROM arc_liquidity_quote_intents i
         JOIN arc_liquidity_accounts a ON a.wallet = i.wallet AND a.enabled
         JOIN arc_liquidity_market_budgets b ON b.wallet = i.wallet AND b.market_id = i.market_id AND b.enabled
         JOIN arc_markets m ON m.market_id = i.market_id AND m.status = 'OPEN' AND m.close_time > clock_timestamp()
         JOIN arc_market_oracle_health h ON h.market_id = i.market_id
          AND h.state = 'HEALTHY'
          AND h.consecutive_healthy >= $3
          AND h.updated_at > clock_timestamp() - ($2::bigint * interval '1 second')
        WHERE i.wallet = $1 AND i.enabled
          AND (i.active_order_hash IS NULL OR NOT EXISTS (
            SELECT 1 FROM arc_orders active WHERE active.order_hash = i.active_order_hash
              AND active.status IN ('QUEUED','SUBMITTED','ACTIVE','MATCHING','CANCEL_PENDING')
          ))
        ORDER BY i.updated_at, i.intent_id
        FOR UPDATE OF i SKIP LOCKED
        LIMIT 1`,
      [wallet, oracleStaleAfterSeconds, oracleRecoveryObservations],
    );
    const intent = selected.rows[0];
    if (!intent) {
      await client.query("COMMIT");
      return null;
    }
    await client.query(
      `UPDATE arc_liquidity_quote_intents
          SET next_nonce = next_nonce + 1, last_attempt_at = clock_timestamp(),
              last_error = NULL, updated_at = clock_timestamp()
        WHERE intent_id = $1`,
      [intent.intent_id],
    );
    await client.query("COMMIT");
    return intent;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function runProtocolLiquidityAgent(
  config: Pick<ArcConfig,
    "apiUrl" | "liquidityAgentPrivateKey" | "liquidityAgentAddress" | "liquidityLimits"
    | "jobPollIntervalMs" | "oracleStaleAfterSeconds" | "oracleRecoveryObservations">,
  db: Database,
  logger: Logger,
  state: { stopping: boolean },
): Promise<void> {
  if (!config.liquidityAgentPrivateKey || !config.liquidityAgentAddress) return;
  const wallet = privateKeyToAccount(config.liquidityAgentPrivateKey).address;
  if (getAddress(wallet) !== getAddress(config.liquidityAgentAddress)) {
    throw new Error("liquidity_agent_wallet_mismatch");
  }
  const lock = await db.connect();
  try {
    while (!state.stopping) {
      const acquired = await lock.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext('airarena_arc_liquidity_agent')) AS acquired",
      );
      if (acquired.rows[0]?.acquired) break;
      await new Promise((resolve) => setTimeout(resolve, config.jobPollIntervalMs));
    }
    while (!state.stopping) {
      let intent: LiquidityIntentRow | null = null;
      try {
        intent = await reserveNextLiquidityIntent(
          db,
          wallet,
          config.oracleStaleAfterSeconds,
          config.oracleRecoveryObservations,
        );
        if (!intent) {
          await new Promise((resolve) => setTimeout(resolve, config.jobPollIntervalMs));
          continue;
        }
        const funded = BigInt(intent.funded_atoms);
        const result = await submitProtocolLiquidityQuote({
          config,
          oracleHealthy: true,
          quote: {
            marketId: intent.market_id,
            outcome: intent.outcome,
            side: intent.side,
            pricePpm: BigInt(intent.price_ppm),
            quantity: BigInt(intent.quantity),
            expiry: BigInt(Math.floor(Date.now() / 1_000) + intent.expiry_seconds),
            nonce: BigInt(intent.next_nonce),
            clientOrderId: `liquidity:${intent.intent_id}:${intent.next_nonce}`,
          },
          riskState: {
            fundedAtoms: funded,
            availableAtoms: BigInt(intent.available_atoms),
            // The public order endpoint reads the authoritative position from
            // ArenaExchange immediately before admission. Keeping this
            // pre-flight value at zero avoids an unsafe off-chain inventory
            // projection becoming a source of truth.
            inventoryAtoms: 0n,
            openNotionalAtoms: BigInt(intent.open_notional_atoms),
            realizedPnlAtoms: BigInt(intent.realized_pnl_atoms),
            peakEquityAtoms: BigInt(intent.peak_equity_atoms),
            currentEquityAtoms: BigInt(intent.available_atoms),
            dailyVolumeAtoms: BigInt(intent.daily_volume_atoms),
          },
        });
        await db.query(
          `UPDATE arc_liquidity_quote_intents SET active_order_hash = $2,
                  last_error = NULL, updated_at = clock_timestamp() WHERE intent_id = $1`,
          [intent.intent_id, result.orderHash],
        );
      } catch (error) {
        if (intent) {
          await db.query(
            `UPDATE arc_liquidity_quote_intents
                SET last_error = $2, updated_at = clock_timestamp()
              WHERE intent_id = $1`,
            [intent.intent_id, error instanceof Error ? error.message.slice(0, 512) : "liquidity_agent_unknown_error"],
          ).catch(() => undefined);
        }
        logger.warn({ err: error }, "arc_liquidity_agent_cycle_failed_closed");
        await new Promise((resolve) => setTimeout(resolve, config.jobPollIntervalMs));
      }
    }
  } finally {
    await lock.query("SELECT pg_advisory_unlock(hashtext('airarena_arc_liquidity_agent'))").catch(() => undefined);
    lock.release();
  }
}
