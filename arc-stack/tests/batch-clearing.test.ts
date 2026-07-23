import { getAddress, type Address, type Hex } from "viem";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BATCH_POLICY_VERSION, clearUniformPriceBatch, type ClearingOrder } from "../src/batch-clearing.js";

const LOT = 10_000n;

function address(index: number): Address {
  return getAddress(`0x${index.toString(16).padStart(40, "0")}`);
}

function hash(index: number): Hex {
  return `0x${index.toString(16).padStart(64, "0")}`;
}

function order(
  index: number,
  maker: number,
  side: "BUY" | "SELL",
  pricePpm: bigint,
  quantity: bigint,
  overrides: Partial<ClearingOrder> = {},
): ClearingOrder {
  return {
    orderHash: hash(index),
    maker: address(maker),
    side,
    pricePpm,
    quantity: quantity * LOT,
    filledQuantity: 0n,
    expiryUnix: 2_000_000_000n,
    ...overrides,
  };
}

function totals(result: ReturnType<typeof clearUniformPriceBatch>) {
  const perOrder = new Map<string, bigint>();
  for (const fill of result.fills) {
    perOrder.set(fill.buyOrderHash, (perOrder.get(fill.buyOrderHash) ?? 0n) + fill.quantity);
    perOrder.set(fill.sellOrderHash, (perOrder.get(fill.sellOrderHash) ?? 0n) + fill.quantity);
  }
  return perOrder;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("deterministic uniform-price batch clearing", () => {
  it("maximizes multi-order volume and prorates the marginal price level with integer remainders", () => {
    const orders = [
      order(1, 1, "BUY", 600_000n, 7n),
      order(2, 2, "BUY", 550_000n, 5n),
      order(3, 3, "BUY", 550_000n, 5n),
      order(4, 4, "SELL", 400_000n, 6n),
      order(5, 5, "SELL", 500_000n, 8n),
    ];
    const result = clearUniformPriceBatch(orders, 1_900_000_000n);
    expect(BATCH_POLICY_VERSION).toBe(
      "PRO_RATA_LARGEST_REMAINDER_V2+SELF_TRADE_NETTING_V1+PARTIAL_FILL_V1+LOT_10000_V1+FEASIBLE_MIDPOINT_V1",
    );
    expect(result.clearingPricePpm).toBe(525_000n);
    expect(result.executableQuantity).toBe(14n * LOT);
    expect(result.fills.length).toBeGreaterThan(1);
    const filled = totals(result);
    expect(filled.get(hash(1))).toBe(7n * LOT);
    expect(filled.get(hash(2))).toBe(3n * LOT);
    expect(filled.get(hash(3))).toBe(4n * LOT);
    expect(filled.get(hash(4))).toBe(6n * LOT);
    expect(filled.get(hash(5))).toBe(8n * LOT);
  });

  it("is byte-deterministic across input permutations", () => {
    const orders = [
      order(10, 1, "BUY", 700_000n, 9n),
      order(11, 2, "BUY", 650_000n, 4n),
      order(12, 3, "SELL", 350_000n, 5n),
      order(13, 4, "SELL", 600_000n, 8n),
    ];
    const forward = clearUniformPriceBatch(orders, 1_900_000_000n);
    const reverse = clearUniformPriceBatch([...orders].reverse(), 1_900_000_000n);
    expect(reverse).toEqual(forward);
    expect(reverse.inputRoot).toBe(forward.inputRoot);
    expect(reverse.resultHash).toBe(forward.resultHash);
  });

  it("nets a maker's crossing interest before price discovery and never self-trades", () => {
    const orders = [
      order(20, 1, "BUY", 700_000n, 10n),
      order(21, 2, "BUY", 700_000n, 4n),
      order(22, 1, "SELL", 300_000n, 10n),
      order(23, 3, "SELL", 300_000n, 3n),
    ];
    const result = clearUniformPriceBatch(orders, 1_900_000_000n);
    expect(result.executableQuantity).toBe(3n * LOT);
    for (const fill of result.fills) {
      const buy = orders.find((candidate) => candidate.orderHash === fill.buyOrderHash)!;
      const sell = orders.find((candidate) => candidate.orderHash === fill.sellOrderHash)!;
      expect(buy.maker).not.toBe(sell.maker);
    }
  });

  it("uses remaining quantity only and excludes orders expired at the batch cutoff", () => {
    const orders = [
      order(30, 1, "BUY", 600_000n, 10n, { filledQuantity: 7n * LOT }),
      order(31, 2, "BUY", 700_000n, 100n, { expiryUnix: 100n }),
      order(32, 3, "SELL", 400_000n, 8n),
    ];
    const result = clearUniformPriceBatch(orders, 1_900_000_000n);
    expect(result.executableQuantity).toBe(3n * LOT);
    expect(result.orderedEligibleOrders.map((candidate) => candidate.orderHash)).not.toContain(hash(31));
  });

  it("returns a committed no-cross result instead of inventing a price", () => {
    const result = clearUniformPriceBatch([
      order(40, 1, "BUY", 400_000n, 5n),
      order(41, 2, "SELL", 500_000n, 5n),
    ], 1_900_000_000n);
    expect(result.clearingPricePpm).toBeNull();
    expect(result.executableQuantity).toBe(0n);
    expect(result.fills).toEqual([]);
    expect(result.inputRoot).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.resultHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("chooses a feasible midpoint after wallet-level netting", () => {
    const result = clearUniformPriceBatch([
      order(50, 3, "BUY", 386_000n, 5n),
      order(51, 3, "BUY", 293_000n, 9n),
      order(52, 5, "SELL", 172_000n, 15n),
      order(53, 1, "BUY", 912_000n, 4n),
      order(54, 3, "BUY", 601_000n, 7n),
      order(55, 2, "SELL", 601_000n, 13n),
      order(56, 5, "BUY", 617_000n, 4n),
    ], 1_900_000_000n);
    expect(result.clearingPricePpm).toBe(386_500n);
    expect(result.executableQuantity).toBe(11n * LOT);
  });

  it("allocates every integer remainder atom exactly once and deterministically", () => {
    const orders = [
      order(70, 1, "BUY", 600_000n, 2n),
      order(71, 2, "BUY", 600_000n, 2n),
      order(72, 3, "BUY", 600_000n, 2n),
      order(73, 4, "SELL", 400_000n, 4n),
    ];
    const batchId = hash(900);
    const first = clearUniformPriceBatch(orders, 1_900_000_000n, { batchId });
    const second = clearUniformPriceBatch([...orders].reverse(), 1_900_000_000n, { batchId });
    expect(second).toEqual(first);
    const filled = totals(first);
    expect([filled.get(hash(70)), filled.get(hash(71)), filled.get(hash(72))].sort())
      .toEqual([LOT, LOT, 2n * LOT]);
    expect(first.executableQuantity).toBe(4n * LOT);
  });

  it("preserves deterministic, lot-sized, no-self invariants across seeded order books", () => {
    const random = seededRandom(0xA17A_2026);
    for (let iteration = 0; iteration < 2_000; iteration += 1) {
      const count = 2 + Math.floor(random() * 38);
      const orders = Array.from({ length: count }, (_unused, index) => order(
        iteration * 64 + index + 1,
        1 + Math.floor(random() * Math.min(10, count)),
        random() < 0.5 ? "BUY" : "SELL",
        BigInt(1 + Math.floor(random() * 998)) * 1_000n,
        BigInt(1 + Math.floor(random() * 100)),
      ));
      const result = clearUniformPriceBatch(orders, 1_900_000_000n);
      expect(clearUniformPriceBatch([...orders].reverse(), 1_900_000_000n)).toEqual(result);
      expect(result.fills.length).toBeLessThanOrEqual(orders.length);
      const filled = totals(result);
      for (const fill of result.fills) {
        const buy = orders.find((candidate) => candidate.orderHash === fill.buyOrderHash)!;
        const sell = orders.find((candidate) => candidate.orderHash === fill.sellOrderHash)!;
        expect(fill.quantity % LOT).toBe(0n);
        expect(fill.quantity).toBeGreaterThan(0n);
        expect(buy.maker).not.toBe(sell.maker);
        expect(result.clearingPricePpm).not.toBeNull();
        expect(buy.pricePpm).toBeGreaterThanOrEqual(result.clearingPricePpm!);
        expect(sell.pricePpm).toBeLessThanOrEqual(result.clearingPricePpm!);
      }
      for (const candidate of orders) {
        expect(filled.get(candidate.orderHash) ?? 0n).toBeLessThanOrEqual(candidate.quantity);
      }
      const buyTotal = result.fills.reduce((sum, fill) => sum + fill.quantity, 0n);
      expect(buyTotal).toBe(result.executableQuantity);
      const makerSides = new Map<string, Set<string>>();
      for (const fill of result.fills) {
        const buy = orders.find((candidate) => candidate.orderHash === fill.buyOrderHash)!;
        const sell = orders.find((candidate) => candidate.orderHash === fill.sellOrderHash)!;
        const buySides = makerSides.get(buy.maker) ?? new Set<string>();
        buySides.add("BUY");
        makerSides.set(buy.maker, buySides);
        const sellSides = makerSides.get(sell.maker) ?? new Set<string>();
        sellSides.add("SELL");
        makerSides.set(sell.maker, sellSides);
      }
      expect([...makerSides.values()].every((sides) => sides.size === 1)).toBe(true);
    }
  }, 30_000);

  it("satisfies no-overfill, non-negative, remainder, and netting properties under fuzzed books", () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        maker: fc.integer({ min: 1, max: 8 }),
        side: fc.constantFrom<"BUY" | "SELL">("BUY", "SELL"),
        price: fc.integer({ min: 1, max: 999 }),
        lots: fc.integer({ min: 1, max: 80 }),
        filled: fc.integer({ min: 0, max: 79 }),
      }), { minLength: 2, maxLength: 32 }),
      (specs) => {
        const orders = specs.map((spec, index) => {
          const quantityLots = BigInt(spec.lots);
          const filledLots = BigInt(Math.min(spec.filled, spec.lots));
          return order(index + 10_000, spec.maker, spec.side, BigInt(spec.price) * 1_000n, quantityLots, {
            filledQuantity: filledLots * LOT,
          });
        });
        const result = clearUniformPriceBatch(orders, 1_900_000_000n, { batchId: hash(901) });
        const filled = totals(result);
        for (const candidate of orders) {
          const executed = filled.get(candidate.orderHash) ?? 0n;
          expect(executed).toBeGreaterThanOrEqual(0n);
          expect(executed).toBeLessThanOrEqual(candidate.quantity - candidate.filledQuantity);
        }
        const perMaker = new Map<string, Set<string>>();
        for (const fill of result.fills) {
          expect(fill.quantity).toBeGreaterThan(0n);
          expect(fill.quantity % LOT).toBe(0n);
          const buy = orders.find((candidate) => candidate.orderHash === fill.buyOrderHash)!;
          const sell = orders.find((candidate) => candidate.orderHash === fill.sellOrderHash)!;
          const buySides = perMaker.get(buy.maker) ?? new Set<string>();
          buySides.add("BUY");
          perMaker.set(buy.maker, buySides);
          const sellSides = perMaker.get(sell.maker) ?? new Set<string>();
          sellSides.add("SELL");
          perMaker.set(sell.maker, sellSides);
        }
        expect([...perMaker.values()].every((sides) => sides.size <= 1)).toBe(true);
        expect(result.fills.reduce((sum, fill) => sum + fill.quantity, 0n)).toBe(result.executableQuantity);
      },
    ), { numRuns: 500, endOnFailure: true });
  }, 30_000);
});
