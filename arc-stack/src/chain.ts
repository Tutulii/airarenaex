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
      { name: "externalIdHash", type: "bytes32" },
      { name: "outcomeCount", type: "uint8" },
      { name: "closeTime", type: "uint64" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "resolveMarket",
    stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "winningOutcome", type: "uint8" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "invalidateMarket",
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
    name: "markets",
    stateMutability: "view",
    inputs: [{ name: "marketId", type: "bytes32" }],
    outputs: [
      { name: "externalIdHash", type: "bytes32" },
      { name: "outcomeCount", type: "uint8" },
      { name: "closeTime", type: "uint64" },
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
    name: "MarketCreated",
    inputs: [
      { name: "marketId", type: "bytes32", indexed: true },
      { name: "externalIdHash", type: "bytes32", indexed: true },
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
    ],
  },
  {
    type: "event",
    name: "MarketInvalidated",
    inputs: [{ name: "marketId", type: "bytes32", indexed: true }],
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
