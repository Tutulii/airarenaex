import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  hashTypedData,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_CHAIN_ID, ARC_EXPLORER_URL, type ArcConfig } from "./config.js";

export const arcTestnet = defineChain({
  id: ARC_CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
  blockExplorers: { default: { name: "ArcScan", url: ARC_EXPLORER_URL } },
  testnet: true,
});

export const arenaExchangeAbi = [
  {
    type: "function",
    name: "availableCollateral",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "amount", type: "uint256" }],
  },
  {
    type: "function",
    name: "positions",
    stateMutability: "view",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "outcome", type: "uint8" },
      { name: "account", type: "address" },
    ],
    outputs: [{ name: "amount", type: "uint256" }],
  },
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "splitCompleteSet",
    stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "quantity", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "mergeCompleteSet",
    stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "quantity", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "cancelOrder",
    stateMutability: "nonpayable",
    inputs: [{ name: "orderHash", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "cancelOrderBySig",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "cancellation",
        type: "tuple",
        components: [
          { name: "maker", type: "address" },
          { name: "orderHash", type: "bytes32" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint64" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "redeem",
    stateMutability: "nonpayable",
    inputs: [{ name: "marketId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "submitOrder",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "order",
        type: "tuple",
        components: [
          { name: "maker", type: "address" },
          { name: "marketId", type: "bytes32" },
          { name: "outcome", type: "uint8" },
          { name: "isBuy", type: "bool" },
          { name: "pricePpm", type: "uint64" },
          { name: "quantity", type: "uint128" },
          { name: "expiry", type: "uint64" },
          { name: "nonce", type: "uint256" },
          { name: "clientOrderId", type: "bytes32" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "orderHash", type: "bytes32" }],
  },
  {
    type: "function",
    name: "feeBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint16" }],
  },
  {
    type: "function",
    name: "activeBatchByMarket",
    stateMutability: "view",
    inputs: [{ name: "marketId", type: "bytes32" }],
    outputs: [{ name: "batchId", type: "bytes32" }],
  },
  {
    type: "function",
    name: "nextBatchSequence",
    stateMutability: "view",
    inputs: [{ name: "marketId", type: "bytes32" }],
    outputs: [{ name: "sequence", type: "uint64" }],
  },
  {
    type: "function",
    name: "lastFinalizedLedgerRoot",
    stateMutability: "view",
    inputs: [{ name: "marketId", type: "bytes32" }],
    outputs: [{ name: "root", type: "bytes32" }],
  },
  {
    type: "function",
    name: "appliedBatchLeaves",
    stateMutability: "view",
    inputs: [{ name: "batchId", type: "bytes32" }, { name: "index", type: "uint32" }],
    outputs: [{ name: "leaf", type: "bytes32" }],
  },
  {
    type: "function",
    name: "publishedDataCommitments",
    stateMutability: "view",
    inputs: [{ name: "commitment", type: "bytes32" }],
    outputs: [{ name: "blockNumber", type: "uint256" }],
  },
  {
    type: "function",
    name: "publishDataCommitment",
    stateMutability: "nonpayable",
    inputs: [{ name: "commitment", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "openBatch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "bytes32" }, { name: "sequence", type: "uint64" },
      { name: "priorRoot", type: "bytes32" }, { name: "dataCommitment", type: "bytes32" },
    ],
    outputs: [{ name: "batchId", type: "bytes32" }],
  },
  {
    type: "function",
    name: "sealBatch",
    stateMutability: "nonpayable",
    inputs: [{ name: "batchId", type: "bytes32" }, { name: "orderRoot", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "clearBatch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "batchId", type: "bytes32" }, { name: "outcome", type: "uint8" },
      { name: "clearingPricePpm", type: "uint64" }, { name: "matchRoot", type: "bytes32" },
      { name: "matchCount", type: "uint32" }, { name: "expectedDebits", type: "uint256" },
      { name: "expectedCredits", type: "uint256" }, { name: "expectedFees", type: "uint256" },
      { name: "expectedClaimAtoms", type: "uint256" }, { name: "expectedLedgerRoot", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "commitBatch",
    stateMutability: "nonpayable",
    inputs: [{ name: "batchId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "applyBatchMatch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "batchId", type: "bytes32" }, { name: "index", type: "uint32" },
      {
        name: "matched", type: "tuple", components: [
          { name: "buyOrderHash", type: "bytes32" }, { name: "sellOrderHash", type: "bytes32" },
          { name: "quantity", type: "uint128" },
        ],
      },
      { name: "proof", type: "bytes32[]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "finalizeBatch",
    stateMutability: "nonpayable",
    inputs: [{ name: "batchId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "executeBatch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "outcome", type: "uint8" },
      { name: "clearingPricePpm", type: "uint64" },
      {
        name: "matches_",
        type: "tuple[]",
        components: [
          { name: "buyOrderHash", type: "bytes32" },
          { name: "sellOrderHash", type: "bytes32" },
          { name: "quantity", type: "uint128" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "createMarket",
    stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "specHash", type: "bytes32" },
      { name: "externalIdHash", type: "bytes32" },
      { name: "outcomeCount", type: "uint8" },
      { name: "closeTime", type: "uint64" },
      {
        name: "rule",
        type: "tuple",
        components: [
          { name: "primarySourceId", type: "bytes32" },
          { name: "witnessSourceId", type: "bytes32" },
          { name: "sourceEventId", type: "bytes32" },
          { name: "primarySigner", type: "address" },
          { name: "witnessSigner", type: "address" },
          { name: "maxReportAgeSeconds", type: "uint64" },
          { name: "maxSourceTimestampSkewSeconds", type: "uint64" },
          { name: "graceSeconds", type: "uint64" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "resolveMarket",
    stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "bytes32" },
      {
        name: "primary",
        type: "tuple",
        components: [
          { name: "sourceId", type: "bytes32" },
          { name: "sourceEventId", type: "bytes32" },
          { name: "observedAt", type: "uint64" },
          { name: "publishedAt", type: "uint64" },
          { name: "finalResult", type: "bool" },
          { name: "normalizedOutcome", type: "uint8" },
          { name: "rawPayloadHash", type: "bytes32" },
          { name: "signatureEvidence", type: "bytes" },
        ],
      },
      {
        name: "witness",
        type: "tuple",
        components: [
          { name: "sourceId", type: "bytes32" },
          { name: "sourceEventId", type: "bytes32" },
          { name: "observedAt", type: "uint64" },
          { name: "publishedAt", type: "uint64" },
          { name: "finalResult", type: "bool" },
          { name: "normalizedOutcome", type: "uint8" },
          { name: "rawPayloadHash", type: "bytes32" },
          { name: "signatureEvidence", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "invalidateAfterGrace",
    stateMutability: "nonpayable",
    inputs: [{ name: "marketId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "isSolvent",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "totalLiabilities",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "markets",
    stateMutability: "view",
    inputs: [{ name: "marketId", type: "bytes32" }],
    outputs: [
      { name: "specHash", type: "bytes32" },
      { name: "externalIdHash", type: "bytes32" },
      { name: "resolutionRuleHash", type: "bytes32" },
      { name: "closeTime", type: "uint64" },
      { name: "outcomeCount", type: "uint8" },
      { name: "status", type: "uint8" },
      { name: "winningOutcome", type: "uint8" },
    ],
  },
  {
    type: "function",
    name: "getOrder",
    stateMutability: "view",
    inputs: [{ name: "orderHash", type: "bytes32" }],
    outputs: [
      {
        name: "storedOrder",
        type: "tuple",
        components: [
          {
            name: "order",
            type: "tuple",
            components: [
              { name: "maker", type: "address" },
              { name: "marketId", type: "bytes32" },
              { name: "outcome", type: "uint8" },
              { name: "isBuy", type: "bool" },
              { name: "pricePpm", type: "uint64" },
              { name: "quantity", type: "uint128" },
              { name: "expiry", type: "uint64" },
              { name: "nonce", type: "uint256" },
              { name: "clientOrderId", type: "bytes32" },
            ],
          },
          { name: "filledQuantity", type: "uint128" },
          { name: "reservedCollateral", type: "uint256" },
          { name: "reservedShares", type: "uint128" },
          { name: "status", type: "uint8" },
        ],
      },
    ],
  },
  {
    type: "event",
    name: "BatchStatusChanged",
    inputs: [
      { name: "batchId", type: "bytes32", indexed: true },
      { name: "marketId", type: "bytes32", indexed: true },
      { name: "sequence", type: "uint64", indexed: true },
      { name: "status", type: "uint8", indexed: false },
    ],
  },
  {
    type: "event",
    name: "MarketCreated",
    inputs: [
      { name: "marketId", type: "bytes32", indexed: true },
      { name: "specHash", type: "bytes32", indexed: true },
      { name: "externalIdHash", type: "bytes32", indexed: true },
      { name: "resolutionRuleHash", type: "bytes32", indexed: false },
      { name: "outcomeCount", type: "uint8", indexed: false },
      { name: "closeTime", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "MarketResolved",
    inputs: [
      { name: "marketId", type: "bytes32", indexed: true },
      { name: "winningOutcome", type: "uint8", indexed: false },
      { name: "primaryReport", type: "bytes32", indexed: false },
      { name: "witnessReport", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "MarketInvalidated",
    inputs: [
      { name: "marketId", type: "bytes32", indexed: true },
      { name: "primaryReport", type: "bytes32", indexed: false },
      { name: "witnessReport", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ResolutionReportStored",
    inputs: [
      { name: "marketId", type: "bytes32", indexed: true },
      { name: "sourceId", type: "bytes32", indexed: true },
      { name: "reportDigest", type: "bytes32", indexed: true },
      { name: "rawPayloadHash", type: "bytes32", indexed: false },
      { name: "normalizedOutcome", type: "uint8", indexed: false },
      { name: "finalResult", type: "bool", indexed: false },
      { name: "observedAt", type: "uint64", indexed: false },
      { name: "publishedAt", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "OrderSubmitted",
    inputs: [
      { name: "orderHash", type: "bytes32", indexed: true },
      { name: "maker", type: "address", indexed: true },
      { name: "marketId", type: "bytes32", indexed: true },
      { name: "outcome", type: "uint8", indexed: false },
      { name: "isBuy", type: "bool", indexed: false },
      { name: "pricePpm", type: "uint64", indexed: false },
      { name: "quantity", type: "uint128", indexed: false },
    ],
  },
  {
    type: "event",
    name: "OrderCancelled",
    inputs: [
      { name: "orderHash", type: "bytes32", indexed: true },
      { name: "maker", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "TradeExecuted",
    inputs: [
      { name: "marketId", type: "bytes32", indexed: true },
      { name: "outcome", type: "uint8", indexed: true },
      { name: "buyOrderHash", type: "bytes32", indexed: true },
      { name: "sellOrderHash", type: "bytes32", indexed: false },
      { name: "quantity", type: "uint128", indexed: false },
      { name: "clearingPricePpm", type: "uint64", indexed: false },
      { name: "quoteAmount", type: "uint256", indexed: false },
      { name: "feeAmount", type: "uint256", indexed: false },
    ],
  },
] as const;

export const orderTypes = {
  Order: [
    { name: "maker", type: "address" },
    { name: "marketId", type: "bytes32" },
    { name: "outcome", type: "uint8" },
    { name: "isBuy", type: "bool" },
    { name: "pricePpm", type: "uint64" },
    { name: "quantity", type: "uint128" },
    { name: "expiry", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "clientOrderId", type: "bytes32" },
  ],
} as const;

export const cancelTypes = {
  Cancel: [
    { name: "maker", type: "address" },
    { name: "orderHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export const acceptanceTypes = {
  OrderAcceptance: [
    { name: "orderHash", type: "bytes32" },
    { name: "maker", type: "address" },
    { name: "sequence", type: "uint64" },
    { name: "acceptedAt", type: "uint64" },
    { name: "requestHash", type: "bytes32" },
  ],
} as const;

export type ArcOrder = {
  maker: Address;
  marketId: Hex;
  outcome: number;
  isBuy: boolean;
  pricePpm: bigint;
  quantity: bigint;
  expiry: bigint;
  nonce: bigint;
  clientOrderId: Hex;
};

export type ArcCancel = {
  maker: Address;
  orderHash: Hex;
  nonce: bigint;
  deadline: bigint;
};

export type OrderAcceptance = {
  orderHash: Hex;
  maker: Address;
  sequence: bigint;
  acceptedAt: bigint;
  requestHash: Hex;
};

export function orderDomain(exchangeAddress: Address) {
  return { name: "AIR Arena Arc", version: "1", chainId: ARC_CHAIN_ID, verifyingContract: exchangeAddress } as const;
}

export function hashArcOrder(exchangeAddress: Address, order: ArcOrder): Hex {
  return hashTypedData({
    domain: orderDomain(exchangeAddress),
    types: orderTypes,
    primaryType: "Order",
    message: order,
  });
}

export function hashArcCancel(exchangeAddress: Address, cancellation: ArcCancel): Hex {
  return hashTypedData({
    domain: orderDomain(exchangeAddress),
    types: cancelTypes,
    primaryType: "Cancel",
    message: cancellation,
  });
}

export function acceptanceDomain(exchangeAddress: Address) {
  return {
    name: "AIR Arena Arc Receipt",
    version: "1",
    chainId: ARC_CHAIN_ID,
    verifyingContract: exchangeAddress,
  } as const;
}

export function hashOrderAcceptance(exchangeAddress: Address, acceptance: OrderAcceptance): Hex {
  return hashTypedData({
    domain: acceptanceDomain(exchangeAddress),
    types: acceptanceTypes,
    primaryType: "OrderAcceptance",
    message: acceptance,
  });
}

export function createArcPublicClient(config: Pick<ArcConfig, "rpcUrl">) {
  return createPublicClient({ chain: arcTestnet, transport: http(config.rpcUrl, { timeout: 10_000, retryCount: 2 }) });
}

export function createArcWalletClient(
  config: Pick<ArcConfig, "rpcUrl" | "relayerPrivateKey">,
  privateKey: `0x${string}` | undefined = config.relayerPrivateKey,
) {
  if (!privateKey) throw new Error("Arc transaction signer is not configured");
  const account = privateKeyToAccount(privateKey);
  return createWalletClient({ account, chain: arcTestnet, transport: http(config.rpcUrl, { timeout: 15_000, retryCount: 2 }) });
}

export function transactionUrl(hash: Hex): string {
  return `${ARC_EXPLORER_URL}/tx/${hash}`;
}

export function normalizeAddress(value: string): Address {
  return getAddress(value);
}
