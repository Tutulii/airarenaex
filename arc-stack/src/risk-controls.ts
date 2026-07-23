import type { Database, DatabaseClient } from "./db.js";

export type HaltReason = "ORACLE_INTEGRITY" | "RECONCILIATION" | "RPC" | "CAP" | "CUSTODY_SAFETY";
export type RiskOperation = "INTAKE" | "BATCH" | "WITHDRAWAL";

export type OrderRiskSnapshot = {
  walletReservedAtoms: bigint;
  marketReservedAtoms: bigint;
  batchNotionalAtoms: bigint;
  treasuryReservedAtoms: bigint;
  ingressCount: number;
  walletIngressCount: number;
  globalCustodyAtoms: bigint;
};

export type OrderRiskLimits = {
  walletReserveAtoms: bigint;
  marketReserveAtoms: bigint;
  batchNotionalAtoms: bigint;
  treasuryAtoms: bigint;
  ingressPerMinute: number;
  walletOrdersPerMinute: number;
  activeMarkets: number;
  globalCustodyAtoms: bigint;
};

export function quoteNotionalAtoms(quantityAtoms: bigint, pricePpm: bigint): bigint {
  if (quantityAtoms < 0n || pricePpm < 0n) throw new Error("risk_negative_integer");
  return (quantityAtoms * pricePpm + 999_999n) / 1_000_000n;
}

export function assertOrderCaps(
  snapshot: OrderRiskSnapshot,
  limits: OrderRiskLimits,
  orderNotionalAtoms: bigint,
  isTreasuryWallet: boolean,
): void {
  if (orderNotionalAtoms <= 0n) throw new Error("risk_invalid_notional");
  // Caps are hard ceilings. Reaching the configured ceiling is rejected so a
  // concurrent accepted order cannot move the system one atom beyond it.
  if (snapshot.walletReservedAtoms + orderNotionalAtoms >= limits.walletReserveAtoms) throw new Error("risk_wallet_cap");
  if (snapshot.marketReservedAtoms + orderNotionalAtoms >= limits.marketReserveAtoms) throw new Error("risk_market_cap");
  if (snapshot.batchNotionalAtoms + orderNotionalAtoms >= limits.batchNotionalAtoms) throw new Error("risk_batch_cap");
  if (isTreasuryWallet && snapshot.treasuryReservedAtoms + orderNotionalAtoms >= limits.treasuryAtoms) {
    throw new Error("risk_treasury_cap");
  }
  if (snapshot.ingressCount + 1 >= limits.ingressPerMinute) throw new Error("risk_ingress_cap");
  if (snapshot.walletIngressCount + 1 >= limits.walletOrdersPerMinute) throw new Error("risk_wallet_rate_cap");
  if (snapshot.globalCustodyAtoms >= limits.globalCustodyAtoms) throw new Error("risk_global_custody_cap");
}

export function assertActiveMarketCap(activeMarketCount: number, limit: number): void {
  if (!Number.isSafeInteger(activeMarketCount) || activeMarketCount < 0) {
    throw new Error("risk_active_market_count_invalid");
  }
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("risk_active_market_limit_invalid");
  if (activeMarketCount + 1 >= limit) throw new Error("risk_active_market_cap");
}

export type LiquidityRiskState = {
  fundedAtoms: bigint;
  availableAtoms: bigint;
  inventoryAtoms: bigint;
  openNotionalAtoms: bigint;
  realizedPnlAtoms: bigint;
  peakEquityAtoms: bigint;
  currentEquityAtoms: bigint;
  dailyVolumeAtoms: bigint;
};

export type LiquidityRiskLimits = {
  vaultAtoms: bigint;
  inventoryAtoms: bigint;
  notionalAtoms: bigint;
  lossAtoms: bigint;
  drawdownAtoms: bigint;
  dailyVolumeAtoms: bigint;
};

export function assertLiquidityQuote(
  state: LiquidityRiskState,
  limits: LiquidityRiskLimits,
  quoteNotional: bigint,
  inventoryDelta: bigint,
): void {
  if (state.fundedAtoms > limits.vaultAtoms || state.availableAtoms > state.fundedAtoms) {
    throw new Error("liquidity_vault_boundary");
  }
  const nextInventory = state.inventoryAtoms + inventoryDelta;
  const absoluteInventory = nextInventory < 0n ? -nextInventory : nextInventory;
  if (absoluteInventory >= limits.inventoryAtoms) throw new Error("liquidity_inventory_cap");
  if (state.openNotionalAtoms + quoteNotional >= limits.notionalAtoms) throw new Error("liquidity_notional_cap");
  const realizedLoss = state.realizedPnlAtoms < 0n ? -state.realizedPnlAtoms : 0n;
  if (realizedLoss >= limits.lossAtoms) throw new Error("liquidity_loss_cap");
  const drawdown = state.peakEquityAtoms > state.currentEquityAtoms
    ? state.peakEquityAtoms - state.currentEquityAtoms
    : 0n;
  if (drawdown >= limits.drawdownAtoms) throw new Error("liquidity_drawdown_cap");
  if (state.dailyVolumeAtoms + quoteNotional >= limits.dailyVolumeAtoms) throw new Error("liquidity_daily_volume_cap");
  if (quoteNotional > state.availableAtoms) throw new Error("liquidity_funded_budget_exceeded");
}

export function operationBlockedByReason(operation: RiskOperation, reason: HaltReason): boolean {
  if (operation === "INTAKE" || operation === "BATCH") return true;
  return reason === "CUSTODY_SAFETY";
}

export async function assertOperationAllowed(
  db: Database | DatabaseClient,
  operation: RiskOperation,
  marketId?: string,
): Promise<void> {
  const result = await db.query<{ reason: HaltReason }>(
    `SELECT reason FROM arc_exchange_halts
      WHERE active = true AND (scope = 'GLOBAL' OR market_id = $1)
      ORDER BY activated_at LIMIT 32`,
    [marketId ?? null],
  );
  const blocking = result.rows.find((row) => operationBlockedByReason(operation, row.reason));
  if (blocking) throw new Error(`exchange_halted_${blocking.reason.toLowerCase()}`);
}

export async function activateHalt(
  db: Database | DatabaseClient,
  input: { haltKey: string; reason: HaltReason; marketId?: string; detail: string },
): Promise<void> {
  await db.query(
    `WITH changed AS (
       INSERT INTO arc_exchange_halts(halt_key, reason, scope, market_id, active, detail)
       VALUES ($1,$2,$3,$4,true,$5)
       ON CONFLICT (halt_key) DO UPDATE SET reason = EXCLUDED.reason, scope = EXCLUDED.scope,
         market_id = EXCLUDED.market_id, active = true, detail = EXCLUDED.detail,
         recovered_at = NULL,
         activated_at = CASE WHEN arc_exchange_halts.active THEN arc_exchange_halts.activated_at
           ELSE clock_timestamp() END,
         updated_at = clock_timestamp()
       WHERE arc_exchange_halts.active = false
          OR arc_exchange_halts.reason IS DISTINCT FROM EXCLUDED.reason
          OR arc_exchange_halts.scope IS DISTINCT FROM EXCLUDED.scope
          OR arc_exchange_halts.market_id IS DISTINCT FROM EXCLUDED.market_id
          OR arc_exchange_halts.detail IS DISTINCT FROM EXCLUDED.detail
       RETURNING halt_key, reason, detail
     )
     INSERT INTO arc_risk_events(halt_key, event_type, reason, detail)
     SELECT halt_key, 'HALT_ACTIVATED', reason, detail FROM changed`,
    [input.haltKey, input.reason, input.marketId ? "MARKET" : "GLOBAL", input.marketId ?? null, input.detail],
  );
}

export async function recoverHalt(db: Database | DatabaseClient, haltKey: string): Promise<void> {
  await db.query(
    `WITH changed AS (
       UPDATE arc_exchange_halts SET active = false, recovered_at = clock_timestamp(),
         updated_at = clock_timestamp() WHERE halt_key = $1 AND active = true
       RETURNING halt_key, reason, detail
     )
     INSERT INTO arc_risk_events(halt_key, event_type, reason, detail)
     SELECT halt_key, 'HALT_RECOVERED', reason, detail FROM changed`,
    [haltKey],
  );
}

export async function recordRecoveryObservation(
  db: Database | DatabaseClient,
  input: { haltKey: string; reason: HaltReason; healthy: boolean; threshold: number; detail: string },
): Promise<number> {
  const stateKey = `recovery:${input.haltKey}`;
  const result = await db.query<{ count: string }>(
    `INSERT INTO arc_runtime_state(key, value, updated_at)
     VALUES ($1, jsonb_build_object('count', CASE WHEN $2 THEN 1 ELSE 0 END), clock_timestamp())
     ON CONFLICT (key) DO UPDATE SET
       value = jsonb_build_object('count', CASE WHEN $2
         THEN LEAST(COALESCE((arc_runtime_state.value->>'count')::integer, 0) + 1, $3) ELSE 0 END),
       updated_at = clock_timestamp()
     RETURNING value->>'count' AS count`,
    [stateKey, input.healthy, input.threshold],
  );
  const count = Number(result.rows[0]?.count ?? "0");
  const active = await db.query<{ active: boolean }>(
    "SELECT active FROM arc_exchange_halts WHERE halt_key = $1",
    [input.haltKey],
  );
  // Healthy background probes are intentionally quiet until there is an
  // active halt to recover. This keeps the append-only risk log useful under
  // normal operation while still recording every unhealthy/recovery sample.
  if (!input.healthy || active.rows[0]?.active === true) {
    await db.query(
      `INSERT INTO arc_risk_events(halt_key, event_type, reason, detail, observation_count)
       VALUES ($1,'RECOVERY_OBSERVED',$2,$3,$4)`,
      [input.haltKey, input.reason, input.detail, count],
    );
  }
  if (!input.healthy) {
    await activateHalt(db, { haltKey: input.haltKey, reason: input.reason, detail: input.detail });
  } else if (count >= input.threshold) {
    await recoverHalt(db, input.haltKey);
  }
  return count;
}

export async function readOrderRiskSnapshot(
  db: Database | DatabaseClient,
  maker: string,
  marketId: string,
  batchId: string | null,
  globalCustodyAtoms: bigint,
  treasuryWallet: string | null,
): Promise<OrderRiskSnapshot> {
  const result = await db.query<{
    wallet_reserved: string;
    market_reserved: string;
    batch_notional: string;
    treasury_reserved: string;
    ingress_count: string;
    wallet_ingress_count: string;
  }>(
    `SELECT
       COALESCE(sum(CASE WHEN maker = $1 AND status IN ('QUEUED','SUBMITTED','ACTIVE','MATCHING')
         THEN (quantity * price_ppm + 999999) / 1000000 ELSE 0 END),0)::numeric(78,0)::text AS wallet_reserved,
       COALESCE(sum(CASE WHEN market_id = $2 AND status IN ('QUEUED','SUBMITTED','ACTIVE','MATCHING')
         THEN (quantity * price_ppm + 999999) / 1000000 ELSE 0 END),0)::numeric(78,0)::text AS market_reserved,
       COALESCE(sum(CASE WHEN assigned_batch_id = $3 AND status IN ('ACTIVE','MATCHING')
         THEN (quantity * price_ppm + 999999) / 1000000 ELSE 0 END),0)::numeric(78,0)::text AS batch_notional,
       COALESCE(sum(CASE WHEN maker = $4 AND status IN ('QUEUED','SUBMITTED','ACTIVE','MATCHING')
         THEN (quantity * price_ppm + 999999) / 1000000 ELSE 0 END),0)::numeric(78,0)::text AS treasury_reserved,
       count(*) FILTER (WHERE created_at >= clock_timestamp() - interval '1 minute')::text AS ingress_count,
       count(*) FILTER (WHERE maker = $1 AND created_at >= clock_timestamp() - interval '1 minute')::text
         AS wallet_ingress_count
     FROM arc_orders`,
    [maker, marketId, batchId, treasuryWallet],
  );
  const row = result.rows[0];
  if (!row) throw new Error("risk_snapshot_unavailable");
  return {
    walletReservedAtoms: BigInt(row.wallet_reserved),
    marketReservedAtoms: BigInt(row.market_reserved),
    batchNotionalAtoms: BigInt(row.batch_notional),
    treasuryReservedAtoms: BigInt(row.treasury_reserved),
    ingressCount: Number(row.ingress_count),
    walletIngressCount: Number(row.wallet_ingress_count),
    globalCustodyAtoms,
  };
}
