import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  assertActiveMarketCap,
  assertLiquidityQuote,
  assertOrderCaps,
  operationBlockedByReason,
  quoteNotionalAtoms,
} from "../src/risk-controls.js";

const limits = {
  walletReserveAtoms: 100n,
  marketReserveAtoms: 200n,
  batchNotionalAtoms: 150n,
  treasuryAtoms: 80n,
  ingressPerMinute: 10,
  walletOrdersPerMinute: 10,
  activeMarkets: 10,
  globalCustodyAtoms: 1_000n,
};

function snapshot() {
  return {
    walletReservedAtoms: 0n,
    marketReservedAtoms: 0n,
    batchNotionalAtoms: 0n,
    treasuryReservedAtoms: 0n,
    ingressCount: 0,
    walletIngressCount: 0,
    globalCustodyAtoms: 0n,
  };
}

describe("caps, halts, and bounded liquidity", () => {
  it.each([
    [{ ...snapshot(), walletReservedAtoms: 99n }, "risk_wallet_cap"],
    [{ ...snapshot(), marketReservedAtoms: 199n }, "risk_market_cap"],
    [{ ...snapshot(), batchNotionalAtoms: 149n }, "risk_batch_cap"],
    [{ ...snapshot(), treasuryReservedAtoms: 79n }, "risk_treasury_cap"],
    [{ ...snapshot(), ingressCount: 9 }, "risk_ingress_cap"],
    [{ ...snapshot(), walletIngressCount: 9 }, "risk_wallet_rate_cap"],
    [{ ...snapshot(), globalCustodyAtoms: 1_000n }, "risk_global_custody_cap"],
  ])("fails closed exactly at each hard boundary", (state, error) => {
    expect(() => assertOrderCaps(state, limits, 1n, true)).toThrow(error);
  });

  it("uses integer-only quote rounding", () => {
    expect(quoteNotionalAtoms(10_001n, 333_333n)).toBe(3_334n);
  });

  it("rejects the active-market boundary exactly and rejects invalid counters", () => {
    expect(() => assertActiveMarketCap(8, 10)).not.toThrow();
    expect(() => assertActiveMarketCap(9, 10)).toThrow("risk_active_market_cap");
    expect(() => assertActiveMarketCap(-1, 10)).toThrow("risk_active_market_count_invalid");
  });

  it("keeps finalized withdrawals available except for custody-safety halts", () => {
    for (const reason of ["ORACLE_INTEGRITY", "RECONCILIATION", "RPC", "CAP"] as const) {
      expect(operationBlockedByReason("INTAKE", reason)).toBe(true);
      expect(operationBlockedByReason("BATCH", reason)).toBe(true);
      expect(operationBlockedByReason("WITHDRAWAL", reason)).toBe(false);
    }
    expect(operationBlockedByReason("WITHDRAWAL", "CUSTODY_SAFETY")).toBe(true);
  });

  it("never permits the liquidity agent past its funded budget under fuzzed inputs", () => {
    fc.assert(fc.property(
      fc.bigInt({ min: 0n, max: 1_000_000n }),
      fc.bigInt({ min: 0n, max: 1_000_000n }),
      (funded, quote) => {
        const state = {
          fundedAtoms: funded,
          availableAtoms: funded,
          inventoryAtoms: 0n,
          openNotionalAtoms: 0n,
          realizedPnlAtoms: 0n,
          peakEquityAtoms: funded,
          currentEquityAtoms: funded,
          dailyVolumeAtoms: 0n,
        };
        const liquidityLimits = {
          vaultAtoms: 1_000_001n,
          inventoryAtoms: 2_000_000n,
          notionalAtoms: 2_000_000n,
          lossAtoms: 1_000_001n,
          drawdownAtoms: 1_000_001n,
          dailyVolumeAtoms: 2_000_000n,
        };
        if (quote > funded) expect(() => assertLiquidityQuote(state, liquidityLimits, quote, quote)).toThrow("funded_budget");
      },
    ), { numRuns: 1_000 });
  });

  it("never permits cumulative accepted liquidity notional past the funded budget", () => {
    fc.assert(fc.property(
      fc.bigInt({ min: 1n, max: 1_000_000n }),
      fc.array(fc.bigInt({ min: 1n, max: 100_000n }), { minLength: 1, maxLength: 100 }),
      (funded, quotes) => {
        let accepted = 0n;
        for (const quote of quotes) {
          const state = {
            fundedAtoms: funded,
            availableAtoms: funded - accepted,
            inventoryAtoms: 0n,
            openNotionalAtoms: accepted,
            realizedPnlAtoms: 0n,
            peakEquityAtoms: funded,
            currentEquityAtoms: funded,
            dailyVolumeAtoms: accepted,
          };
          const caps = {
            vaultAtoms: funded,
            inventoryAtoms: 10_000_000n,
            notionalAtoms: funded + 1n,
            lossAtoms: funded + 1n,
            drawdownAtoms: funded + 1n,
            dailyVolumeAtoms: funded + 1n,
          };
          if (quote > funded - accepted) {
            expect(() => assertLiquidityQuote(state, caps, quote, 0n)).toThrow();
          } else if (accepted + quote < funded + 1n) {
            expect(() => assertLiquidityQuote(state, caps, quote, 0n)).not.toThrow();
            accepted += quote;
          }
          expect(accepted).toBeLessThanOrEqual(funded);
        }
      },
    ), { numRuns: 1_000 });
  });

  it("stops at vault, inventory, notional, loss, and drawdown limits independently", () => {
    const base = {
      fundedAtoms: 100n, availableAtoms: 100n, inventoryAtoms: 0n, openNotionalAtoms: 0n,
      realizedPnlAtoms: 0n, peakEquityAtoms: 100n, currentEquityAtoms: 100n, dailyVolumeAtoms: 0n,
    };
    const caps = {
      vaultAtoms: 100n, inventoryAtoms: 50n, notionalAtoms: 50n, lossAtoms: 20n,
      drawdownAtoms: 20n, dailyVolumeAtoms: 50n,
    };
    expect(() => assertLiquidityQuote({ ...base, fundedAtoms: 101n }, caps, 1n, 1n)).toThrow("vault_boundary");
    expect(() => assertLiquidityQuote(base, caps, 1n, 50n)).toThrow("inventory_cap");
    expect(() => assertLiquidityQuote(base, caps, 50n, 1n)).toThrow("notional_cap");
    expect(() => assertLiquidityQuote({ ...base, realizedPnlAtoms: -20n }, caps, 1n, 1n)).toThrow("loss_cap");
    expect(() => assertLiquidityQuote({ ...base, currentEquityAtoms: 80n }, caps, 1n, 1n)).toThrow("drawdown_cap");
    expect(() => assertLiquidityQuote({ ...base, dailyVolumeAtoms: 49n }, caps, 1n, 1n)).toThrow("daily_volume_cap");
  });
});
