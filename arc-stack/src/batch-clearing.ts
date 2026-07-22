import { keccak256, stringToHex, type Address, type Hex } from "viem";
import { canonicalJson } from "./order-intake.js";
import {
  MAX_ORDER_PRICE_PPM,
  MIN_ORDER_PRICE_PPM,
  ORDER_QUANTITY_STEP_ATOMS,
  isExecutableOrderQuantity,
} from "./trading-policy.js";

export const BATCH_POLICY_VERSION =
  "PRO_RATA_AT_CLEARING_PRICE_V1+ORDER_HASH_ASC_V1+LOT_10000_V1+FEASIBLE_MIDPOINT_V1";

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

type SideOrder = ClearingOrder & { remaining: bigint };

class MaxHeap {
  private readonly values: Array<{ value: bigint; maker: string; version: number }> = [];

  push(item: { value: bigint; maker: string; version: number }): void {
    this.values.push(item);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const parentValue = this.values[parent];
      if (!parentValue || parentValue.value >= item.value) break;
      this.values[index] = parentValue;
      index = parent;
    }
    this.values[index] = item;
  }

  current(combined: Map<string, bigint>, versions: Map<string, number>): bigint {
    for (;;) {
      const top = this.values[0];
      if (!top) return 0n;
      if (versions.get(top.maker) === top.version && combined.get(top.maker) === top.value) return top.value;
      const last = this.values.pop();
      if (!this.values.length || !last) continue;
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        if (left >= this.values.length) break;
        const next = right < this.values.length && this.values[right]!.value > this.values[left]!.value ? right : left;
        if (this.values[next]!.value <= last.value) break;
        this.values[index] = this.values[next]!;
        index = next;
      }
      this.values[index] = last;
    }
  }
}

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

function noSelfVolume(totalBuy: bigint, totalSell: bigint, largestCombinedMaker: bigint): bigint {
  const unconstrained = totalBuy < totalSell ? totalBuy : totalSell;
  const crossMakerCapacity = totalBuy + totalSell - largestCombinedMaker;
  if (crossMakerCapacity <= 0n) return 0n;
  return unconstrained < crossMakerCapacity ? unconstrained : crossMakerCapacity;
}

function volumeAtPrice(buys: SideOrder[], sells: SideOrder[], price: bigint): bigint {
  let totalBuy = 0n;
  let totalSell = 0n;
  const combined = new Map<string, bigint>();
  for (const order of buys) {
    if (order.pricePpm < price) continue;
    totalBuy += order.remaining;
    const key = order.maker.toLowerCase();
    combined.set(key, (combined.get(key) ?? 0n) + order.remaining);
  }
  for (const order of sells) {
    if (order.pricePpm > price) continue;
    totalSell += order.remaining;
    const key = order.maker.toLowerCase();
    combined.set(key, (combined.get(key) ?? 0n) + order.remaining);
  }
  let largestCombinedMaker = 0n;
  for (const quantity of combined.values()) {
    if (quantity > largestCombinedMaker) largestCombinedMaker = quantity;
  }
  return noSelfVolume(totalBuy, totalSell, largestCombinedMaker);
}

function clearingPriceAndVolume(buys: SideOrder[], sells: SideOrder[]): { price: bigint; volume: bigint } | null {
  const candidates = [...new Set([...buys, ...sells].map((order) => order.pricePpm.toString()))]
    .map(BigInt)
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (!candidates.length) return null;

  const buysAscending = [...buys].sort((left, right) => left.pricePpm < right.pricePpm ? -1 : left.pricePpm > right.pricePpm ? 1 : byHash(left, right));
  const sellsAscending = [...sells].sort((left, right) => left.pricePpm < right.pricePpm ? -1 : left.pricePpm > right.pricePpm ? 1 : byHash(left, right));
  const combined = new Map<string, bigint>();
  const versions = new Map<string, number>();
  const heap = new MaxHeap();
  let totalBuy = 0n;
  let totalSell = 0n;
  let buyRemoveIndex = 0;
  let sellAddIndex = 0;

  const changeMaker = (maker: string, delta: bigint) => {
    const normalized = maker.toLowerCase();
    const next = (combined.get(normalized) ?? 0n) + delta;
    combined.set(normalized, next);
    const version = (versions.get(normalized) ?? 0) + 1;
    versions.set(normalized, version);
    heap.push({ value: next, maker: normalized, version });
  };
  for (const order of buysAscending) {
    totalBuy += order.remaining;
    changeMaker(order.maker, order.remaining);
  }

  let bestVolume = 0n;
  const bestPrices: bigint[] = [];
  for (const candidate of candidates) {
    while (buyRemoveIndex < buysAscending.length && buysAscending[buyRemoveIndex]!.pricePpm < candidate) {
      const order = buysAscending[buyRemoveIndex++]!;
      totalBuy -= order.remaining;
      changeMaker(order.maker, -order.remaining);
    }
    while (sellAddIndex < sellsAscending.length && sellsAscending[sellAddIndex]!.pricePpm <= candidate) {
      const order = sellsAscending[sellAddIndex++]!;
      totalSell += order.remaining;
      changeMaker(order.maker, order.remaining);
    }
    const volume = noSelfVolume(totalBuy, totalSell, heap.current(combined, versions));
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
  const price = volumeAtPrice(buys, sells, midpoint) === bestVolume ? midpoint : bestPrices[0]!;
  return { price, volume: bestVolume };
}

function priorityAllocation(orders: SideOrder[], target: bigint, side: "BUY" | "SELL"): Map<string, bigint> {
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
    for (const order of ranked) {
      const orderLots = order.remaining / ORDER_QUANTITY_STEP_ATOMS;
      const lots = orderLots * targetLots / groupLots;
      const value = lots * ORDER_QUANTITY_STEP_ATOMS;
      allocation.set(order.orderHash.toLowerCase(), value);
      allocatedLots += lots;
    }
    let remainderLots = targetLots - allocatedLots;
    for (const order of ranked) {
      if (remainderLots === 0n) break;
      const key = order.orderHash.toLowerCase();
      if ((allocation.get(key) ?? 0n) < order.remaining) {
        allocation.set(key, (allocation.get(key) ?? 0n) + ORDER_QUANTITY_STEP_ATOMS);
        remainderLots -= 1n;
      }
    }
    remaining = 0n;
  }
  if (remaining !== 0n) throw new Error("allocation_target_unreachable");
  return allocation;
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

export function clearUniformPriceBatch(orders: ClearingOrder[], cutoffUnix: bigint): BatchClearingResult {
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

  const eligibleBuys = buys.filter((order) => order.pricePpm >= clearing.price);
  const eligibleSells = sells.filter((order) => order.pricePpm <= clearing.price);
  const buyAllocation = priorityAllocation(eligibleBuys, clearing.volume, "BUY");
  const sellAllocation = priorityAllocation(eligibleSells, clearing.volume, "SELL");
  let flowed = maxFlow(eligibleBuys, eligibleSells, buyAllocation, sellAllocation, clearing.volume);
  if (flowed.volume !== clearing.volume) {
    flowed = maxFlow(
      eligibleBuys,
      eligibleSells,
      new Map(eligibleBuys.map((order) => [order.orderHash.toLowerCase(), order.remaining])),
      new Map(eligibleSells.map((order) => [order.orderHash.toLowerCase(), order.remaining])),
      clearing.volume,
    );
  }
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
