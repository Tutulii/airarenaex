import { encodeAbiParameters, keccak256, stringToHex, type Address, type Hex } from "viem";
import { canonicalJson } from "./order-intake.js";
import {
  MAX_ORDER_PRICE_PPM,
  MIN_ORDER_PRICE_PPM,
  ORDER_QUANTITY_STEP_ATOMS,
  isExecutableOrderQuantity,
} from "./trading-policy.js";

export const BATCH_POLICY_VERSION =
  "PRO_RATA_LARGEST_REMAINDER_V2+SELF_TRADE_NETTING_V1+PARTIAL_FILL_V1+LOT_10000_V1+FEASIBLE_MIDPOINT_V1";

const ZERO_BATCH_SEED = `0x${"00".repeat(32)}` as Hex;

export type ClearingOrder = {
  orderHash: Hex;
  maker: Address;
  side: "BUY" | "SELL";
  pricePpm: bigint;
  quantity: bigint;
  filledQuantity: bigint;
  expiryUnix: bigint;
};

export type ClearingFill = {
  buyOrderHash: Hex;
  sellOrderHash: Hex;
  quantity: bigint;
};

export type BatchClearingResult = {
  inputRoot: Hex;
  resultHash: Hex;
  clearingPricePpm: bigint | null;
  executableQuantity: bigint;
  fills: ClearingFill[];
  orderedEligibleOrders: ClearingOrder[];
};

export type BatchClearingContext = {
  /** Used only for deterministic remainder tie-breaking; it never changes an order digest. */
  batchId?: Hex;
};

type SideOrder = ClearingOrder & { remaining: bigint };

function byHash(left: ClearingOrder, right: ClearingOrder): number {
  return left.orderHash.toLowerCase().localeCompare(right.orderHash.toLowerCase());
}

function buyPriority(left: SideOrder, right: SideOrder): number {
  if (left.pricePpm !== right.pricePpm) return left.pricePpm > right.pricePpm ? -1 : 1;
  return byHash(left, right);
}

function sellPriority(left: SideOrder, right: SideOrder): number {
  if (left.pricePpm !== right.pricePpm) return left.pricePpm < right.pricePpm ? -1 : 1;
  return byHash(left, right);
}

function available(order: ClearingOrder): bigint {
  return order.quantity > order.filledQuantity ? order.quantity - order.filledQuantity : 0n;
}

function canonicalOrder(order: SideOrder) {
  return {
    expiryUnix: order.expiryUnix.toString(),
    filledQuantity: order.filledQuantity.toString(),
    maker: order.maker.toLowerCase(),
    orderHash: order.orderHash.toLowerCase(),
    pricePpm: order.pricePpm.toString(),
    quantity: order.quantity.toString(),
    remaining: order.remaining.toString(),
    side: order.side,
  };
}

function hashCanonical(value: unknown): Hex {
  return keccak256(stringToHex(canonicalJson(value)));
}

function makerNettedVolumeAtPrice(buys: SideOrder[], sells: SideOrder[], price: bigint): bigint {
  const byMaker = new Map<string, { buy: bigint; sell: bigint }>();
  for (const order of buys) {
    if (order.pricePpm < price) continue;
    const key = order.maker.toLowerCase();
    const value = byMaker.get(key) ?? { buy: 0n, sell: 0n };
    value.buy += order.remaining;
    byMaker.set(key, value);
  }
  for (const order of sells) {
    if (order.pricePpm > price) continue;
    const key = order.maker.toLowerCase();
    const value = byMaker.get(key) ?? { buy: 0n, sell: 0n };
    value.sell += order.remaining;
    byMaker.set(key, value);
  }
  let totalNetBuy = 0n;
  let totalNetSell = 0n;
  for (const value of byMaker.values()) {
    if (value.buy > value.sell) totalNetBuy += value.buy - value.sell;
    else totalNetSell += value.sell - value.buy;
  }
  return totalNetBuy < totalNetSell ? totalNetBuy : totalNetSell;
}

function clearingPriceAndVolume(buys: SideOrder[], sells: SideOrder[]): { price: bigint; volume: bigint } | null {
  const candidates = [...new Set([...buys, ...sells].map((order) => order.pricePpm.toString()))]
    .map(BigInt)
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (!candidates.length) return null;

  let bestVolume = 0n;
  const bestPrices: bigint[] = [];
  for (const candidate of candidates) {
    const volume = makerNettedVolumeAtPrice(buys, sells, candidate);
    if (volume > bestVolume) {
      bestVolume = volume;
      bestPrices.length = 0;
      bestPrices.push(candidate);
    } else if (volume === bestVolume && volume > 0n) {
      bestPrices.push(candidate);
    }
  }
  if (!bestVolume || !bestPrices.length) return null;
  const midpoint = (bestPrices[0]! + bestPrices[bestPrices.length - 1]!) / 2n;
  // A midpoint is only valid when the maximum-volume plateau actually spans it.
  // Disjoint equal-volume peaks can otherwise produce a non-executable clearing price.
  const price = makerNettedVolumeAtPrice(buys, sells, midpoint) === bestVolume ? midpoint : bestPrices[0]!;
  return { price, volume: bestVolume };
}

function remainderRank(batchId: Hex, orderHash: Hex): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }],
    [batchId, orderHash],
  ));
}

function priorityAllocation(
  orders: SideOrder[],
  target: bigint,
  side: "BUY" | "SELL",
  batchId: Hex,
): Map<string, bigint> {
  if (target % ORDER_QUANTITY_STEP_ATOMS !== 0n) throw new Error("allocation_target_not_lot_aligned");
  const sorted = [...orders].sort(side === "BUY" ? buyPriority : sellPriority);
  const allocation = new Map<string, bigint>();
  let remaining = target;
  for (let index = 0; index < sorted.length && remaining > 0n;) {
    const price = sorted[index]!.pricePpm;
    const group: SideOrder[] = [];
    while (index < sorted.length && sorted[index]!.pricePpm === price) group.push(sorted[index++]!);
    const groupTotal = group.reduce((sum, order) => sum + order.remaining, 0n);
    if (groupTotal <= remaining) {
      for (const order of group) allocation.set(order.orderHash.toLowerCase(), order.remaining);
      remaining -= groupTotal;
      continue;
    }
    const ranked = [...group].sort(byHash);
    const targetLots = remaining / ORDER_QUANTITY_STEP_ATOMS;
    const groupLots = groupTotal / ORDER_QUANTITY_STEP_ATOMS;
    let allocatedLots = 0n;
    const remainders: Array<{ order: SideOrder; remainder: bigint; rank: Hex }> = [];
    for (const order of ranked) {
      const orderLots = order.remaining / ORDER_QUANTITY_STEP_ATOMS;
      const numerator = orderLots * targetLots;
      const lots = numerator / groupLots;
      const value = lots * ORDER_QUANTITY_STEP_ATOMS;
      allocation.set(order.orderHash.toLowerCase(), value);
      allocatedLots += lots;
      remainders.push({
        order,
        remainder: numerator % groupLots,
        rank: remainderRank(batchId, order.orderHash),
      });
    }
    let remainderLots = targetLots - allocatedLots;
    remainders.sort((left, right) => {
      if (left.remainder !== right.remainder) return left.remainder > right.remainder ? -1 : 1;
      return left.rank.localeCompare(right.rank);
    });
    for (const candidate of remainders) {
      if (remainderLots === 0n) break;
      const key = candidate.order.orderHash.toLowerCase();
      if ((allocation.get(key) ?? 0n) < candidate.order.remaining) {
        allocation.set(key, (allocation.get(key) ?? 0n) + ORDER_QUANTITY_STEP_ATOMS);
        remainderLots -= 1n;
      }
    }
    remaining = 0n;
  }
  if (remaining !== 0n) throw new Error("allocation_target_unreachable");
  return allocation;
}

/**
 * Removes a maker's crossing interest before global price-level allocation.
 * Better-priced orders consume the maker's net capacity first; orders tied at
 * one price are prorated with the same deterministic largest-remainder rule.
 */
function makerNettedOrders(
  buys: SideOrder[],
  sells: SideOrder[],
  batchId: Hex,
): { buys: SideOrder[]; sells: SideOrder[] } {
  const makers = new Set([...buys, ...sells].map((order) => order.maker.toLowerCase()));
  const nettedBuys: SideOrder[] = [];
  const nettedSells: SideOrder[] = [];
  for (const maker of [...makers].sort()) {
    const makerBuys = buys.filter((order) => order.maker.toLowerCase() === maker);
    const makerSells = sells.filter((order) => order.maker.toLowerCase() === maker);
    const buyTotal = makerBuys.reduce((sum, order) => sum + order.remaining, 0n);
    const sellTotal = makerSells.reduce((sum, order) => sum + order.remaining, 0n);
    if (buyTotal > sellTotal) {
      const cap = buyTotal - sellTotal;
      const allocations = priorityAllocation(makerBuys, cap, "BUY", batchId);
      for (const order of makerBuys) {
        const remaining = allocations.get(order.orderHash.toLowerCase()) ?? 0n;
        if (remaining > 0n) nettedBuys.push({ ...order, remaining });
      }
    } else if (sellTotal > buyTotal) {
      const cap = sellTotal - buyTotal;
      const allocations = priorityAllocation(makerSells, cap, "SELL", batchId);
      for (const order of makerSells) {
        const remaining = allocations.get(order.orderHash.toLowerCase()) ?? 0n;
        if (remaining > 0n) nettedSells.push({ ...order, remaining });
      }
    }
  }
  return {
    buys: nettedBuys.sort(buyPriority),
    sells: nettedSells.sort(sellPriority),
  };
}

function maxFlow(
  buys: SideOrder[],
  sells: SideOrder[],
  buyCaps: Map<string, bigint>,
  sellCaps: Map<string, bigint>,
  target: bigint,
): { volume: bigint; fills: ClearingFill[] } {
  const flow = new Map<string, bigint>();
  const buyUsed = new Array<bigint>(buys.length).fill(0n);
  const sellUsed = new Array<bigint>(sells.length).fill(0n);
  let volume = 0n;

  while (volume < target) {
    const buyParent = new Array<number>(buys.length).fill(-2);
    const sellParent = new Array<number>(sells.length).fill(-2);
    const queue: Array<{ side: "BUY" | "SELL"; index: number }> = [];
    for (let buyIndex = 0; buyIndex < buys.length; buyIndex += 1) {
      const cap = buyCaps.get(buys[buyIndex]!.orderHash.toLowerCase()) ?? 0n;
      if (buyUsed[buyIndex]! < cap) {
        buyParent[buyIndex] = -1;
        queue.push({ side: "BUY", index: buyIndex });
      }
    }

    let terminalSell = -1;
    for (let cursor = 0; cursor < queue.length && terminalSell < 0; cursor += 1) {
      const node = queue[cursor]!;
      if (node.side === "BUY") {
        for (let sellIndex = 0; sellIndex < sells.length; sellIndex += 1) {
          if (sellParent[sellIndex] !== -2 || buys[node.index]!.maker === sells[sellIndex]!.maker) continue;
          sellParent[sellIndex] = node.index;
          const cap = sellCaps.get(sells[sellIndex]!.orderHash.toLowerCase()) ?? 0n;
          if (sellUsed[sellIndex]! < cap) {
            terminalSell = sellIndex;
            break;
          }
          queue.push({ side: "SELL", index: sellIndex });
        }
      } else {
        for (let buyIndex = 0; buyIndex < buys.length; buyIndex += 1) {
          const key = `${buyIndex}:${node.index}`;
          if (buyParent[buyIndex] !== -2 || (flow.get(key) ?? 0n) === 0n) continue;
          buyParent[buyIndex] = node.index;
          queue.push({ side: "BUY", index: buyIndex });
        }
      }
    }
    if (terminalSell < 0) break;

    const path: Array<{ buy: number; sell: number; forward: boolean }> = [];
    let sellIndex = terminalSell;
    for (;;) {
      const buyIndex = sellParent[sellIndex]!;
      path.push({ buy: buyIndex, sell: sellIndex, forward: true });
      const previousSell = buyParent[buyIndex]!;
      if (previousSell === -1) break;
      path.push({ buy: buyIndex, sell: previousSell, forward: false });
      sellIndex = previousSell;
    }
    path.reverse();

    const startBuy = path[0]!.buy;
    const endSell = terminalSell;
    let delta = target - volume;
    const startCap = buyCaps.get(buys[startBuy]!.orderHash.toLowerCase()) ?? 0n;
    const endCap = sellCaps.get(sells[endSell]!.orderHash.toLowerCase()) ?? 0n;
    if (startCap - buyUsed[startBuy]! < delta) delta = startCap - buyUsed[startBuy]!;
    if (endCap - sellUsed[endSell]! < delta) delta = endCap - sellUsed[endSell]!;
    for (const edge of path) {
      if (!edge.forward) {
        const residual = flow.get(`${edge.buy}:${edge.sell}`) ?? 0n;
        if (residual < delta) delta = residual;
      }
    }
    if (delta <= 0n) break;
    for (const edge of path) {
      const key = `${edge.buy}:${edge.sell}`;
      flow.set(key, (flow.get(key) ?? 0n) + (edge.forward ? delta : -delta));
    }
    buyUsed[startBuy] = buyUsed[startBuy]! + delta;
    sellUsed[endSell] = sellUsed[endSell]! + delta;
    volume += delta;
  }

  const fills: ClearingFill[] = [];
  for (let buyIndex = 0; buyIndex < buys.length; buyIndex += 1) {
    for (let sellIndex = 0; sellIndex < sells.length; sellIndex += 1) {
      const quantity = flow.get(`${buyIndex}:${sellIndex}`) ?? 0n;
      if (quantity > 0n) fills.push({
        buyOrderHash: buys[buyIndex]!.orderHash,
        sellOrderHash: sells[sellIndex]!.orderHash,
        quantity,
      });
    }
  }
  return { volume, fills };
}

export function clearUniformPriceBatch(
  orders: ClearingOrder[],
  cutoffUnix: bigint,
  context: BatchClearingContext = {},
): BatchClearingResult {
  const batchId = context.batchId ?? ZERO_BATCH_SEED;
  const eligible = orders
    .map((order): SideOrder => ({ ...order, remaining: available(order) }))
    .filter((order) =>
      order.remaining > 0n
      && order.expiryUnix > cutoffUnix
      && order.pricePpm >= MIN_ORDER_PRICE_PPM
      && order.pricePpm <= MAX_ORDER_PRICE_PPM
      && isExecutableOrderQuantity(order.quantity)
      && order.filledQuantity % ORDER_QUANTITY_STEP_ATOMS === 0n
      && order.remaining % ORDER_QUANTITY_STEP_ATOMS === 0n,
    )
    .sort(byHash);
  const inputRoot = hashCanonical({ policy: BATCH_POLICY_VERSION, orders: eligible.map(canonicalOrder) });
  const buys = eligible.filter((order) => order.side === "BUY").sort(buyPriority);
  const sells = eligible.filter((order) => order.side === "SELL").sort(sellPriority);
  const clearing = clearingPriceAndVolume(buys, sells);
  if (!clearing) {
    const empty = { clearingPricePpm: null, executableQuantity: "0", fills: [], inputRoot };
    return {
      inputRoot,
      resultHash: hashCanonical(empty),
      clearingPricePpm: null,
      executableQuantity: 0n,
      fills: [],
      orderedEligibleOrders: eligible,
    };
  }

  const pricedBuys = buys.filter((order) => order.pricePpm >= clearing.price);
  const pricedSells = sells.filter((order) => order.pricePpm <= clearing.price);
  const netted = makerNettedOrders(pricedBuys, pricedSells, batchId);
  const buyAllocation = priorityAllocation(netted.buys, clearing.volume, "BUY", batchId);
  const sellAllocation = priorityAllocation(netted.sells, clearing.volume, "SELL", batchId);
  const flowed = maxFlow(netted.buys, netted.sells, buyAllocation, sellAllocation, clearing.volume);
  if (flowed.volume !== clearing.volume) throw new Error("self_trade_safe_max_flow_failed");

  const resultBody = {
    clearingPricePpm: clearing.price.toString(),
    executableQuantity: clearing.volume.toString(),
    fills: flowed.fills.map((fill) => ({ ...fill, quantity: fill.quantity.toString() })),
    inputRoot,
    policy: BATCH_POLICY_VERSION,
  };
  return {
    inputRoot,
    resultHash: hashCanonical(resultBody),
    clearingPricePpm: clearing.price,
    executableQuantity: clearing.volume,
    fills: flowed.fills,
    orderedEligibleOrders: eligible,
  };
}
