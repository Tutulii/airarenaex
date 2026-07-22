import { getAddress, isAddress, type Address } from "viem";
import { z } from "zod";

export const ARC_CHAIN_ID = 5_042_002;
export const ARC_USDC_ADDRESS = "0x3600000000000000000000000000000000000000" as Address;
export const ARC_EXPLORER_URL = "https://testnet.arcscan.app";

const AddressSchema = z
  .string()
  .refine(isAddress, "must be a valid EVM address")
  .transform((value) => getAddress(value));

const OptionalAddressSchema = z.preprocess(
  (value) => (value === "" || value === undefined ? undefined : value),
  AddressSchema.optional(),
);

const OptionalPrivateKeySchema = z.preprocess(
  (value) => (value === "" || value === undefined ? undefined : value),
  z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 32-byte 0x-prefixed key").optional(),
);

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  SERVICE_ROLE: z.enum(["api", "middleman", "mcp"]),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().url().optional(),
  ARC_RPC_URL: z.string().url(),
  ARC_CHAIN_ID: z.coerce.number().int().default(ARC_CHAIN_ID),
  ARC_USDC_ADDRESS: AddressSchema.default(ARC_USDC_ADDRESS),
  ARC_EXCHANGE_ADDRESS: OptionalAddressSchema,
  ARC_RELAYER_PRIVATE_KEY: OptionalPrivateKeySchema,
  ARC_MARKET_ADMIN_PRIVATE_KEY: OptionalPrivateKeySchema,
  ARC_MATCHER_PRIVATE_KEY: OptionalPrivateKeySchema,
  ARC_RESOLVER_PRIVATE_KEY: OptionalPrivateKeySchema,
  ARC_RECEIPT_SIGNER_PRIVATE_KEY: OptionalPrivateKeySchema,
  ARC_RECEIPT_SIGNER_KEY_ID: z.string().min(1).max(128).default("arc-v2-receipt-1"),
  ARC_API_URL: z.string().url().default("http://localhost:3000"),
  ARC_OPERATOR_TOKEN: z.string().min(32).optional(),
  ARC_CORS_ORIGINS: z.string().default(""),
  TXLINE_SOURCE_URL: z.string().url().default("https://api-server-production-8a16.up.railway.app"),
  AUTH_CHALLENGE_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
  AUTH_TOKEN_PEPPER: z.string().min(32).optional(),
  JOB_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(30_000).default(1000),
  INDEXER_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(30_000).default(1000),
  RESULT_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(15_000),
  ARC_CLEARING_MODE: z.enum(["pairwise", "batch_v1"]).default("batch_v1"),
  ARC_BATCH_INTERVAL_MS: z.coerce.number().int().min(1_000).max(60_000).default(2_000),
  ARC_BATCH_MAX_ORDERS: z.coerce.number().int().min(2).max(100).default(40),
  ARC_BATCH_EXECUTION_CHUNK_SIZE: z.coerce.number().int().min(1).max(100).default(40),
  INDEXER_START_BLOCK: z.coerce.bigint().nonnegative().optional(),
});

export type ArcConfig = {
  nodeEnv: "development" | "test" | "production";
  serviceRole: "api" | "middleman" | "mcp";
  port: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  databaseUrl?: string;
  rpcUrl: string;
  chainId: typeof ARC_CHAIN_ID;
  usdcAddress: Address;
  exchangeAddress?: Address;
  relayerPrivateKey?: `0x${string}`;
  marketAdminPrivateKey?: `0x${string}`;
  matcherPrivateKey?: `0x${string}`;
  resolverPrivateKey?: `0x${string}`;
  receiptSignerPrivateKey?: `0x${string}`;
  receiptSignerKeyId: string;
  apiUrl: string;
  operatorToken?: string;
  corsOrigins: string[];
  txlineSourceUrl: string;
  authChallengeTtlSeconds: number;
  authTokenPepper?: string;
  jobPollIntervalMs: number;
  indexerPollIntervalMs: number;
  resultPollIntervalMs: number;
  clearingMode: "pairwise" | "batch_v1";
  batchIntervalMs: number;
  batchMaxOrders: number;
  batchExecutionChunkSize: number;
  indexerStartBlock?: bigint;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ArcConfig {
  const parsed = EnvironmentSchema.parse(env);
  if (parsed.ARC_CHAIN_ID !== ARC_CHAIN_ID) {
    throw new Error(`ARC_CHAIN_ID must be ${ARC_CHAIN_ID}; cross-network execution is disabled`);
  }
  if (getAddress(parsed.ARC_USDC_ADDRESS) !== getAddress(ARC_USDC_ADDRESS)) {
    throw new Error(`ARC_USDC_ADDRESS must be the official Arc Testnet USDC interface ${ARC_USDC_ADDRESS}`);
  }
  if ((parsed.SERVICE_ROLE === "api" || parsed.SERVICE_ROLE === "middleman") && !parsed.DATABASE_URL) {
    throw new Error(`DATABASE_URL is required for ${parsed.SERVICE_ROLE}`);
  }
  if (parsed.SERVICE_ROLE === "middleman" && parsed.NODE_ENV === "production") {
    if (!parsed.ARC_EXCHANGE_ADDRESS) throw new Error("ARC_EXCHANGE_ADDRESS is required for middleman production");
    if (!parsed.ARC_RELAYER_PRIVATE_KEY) throw new Error("ARC_RELAYER_PRIVATE_KEY is required for middleman production");
    if (!parsed.ARC_MARKET_ADMIN_PRIVATE_KEY) throw new Error("ARC_MARKET_ADMIN_PRIVATE_KEY is required for middleman production");
    if (!parsed.ARC_MATCHER_PRIVATE_KEY) throw new Error("ARC_MATCHER_PRIVATE_KEY is required for middleman production");
    if (!parsed.ARC_RESOLVER_PRIVATE_KEY) throw new Error("ARC_RESOLVER_PRIVATE_KEY is required for middleman production");
    if (!parsed.TXLINE_SOURCE_URL.startsWith("https://")) {
      throw new Error("TXLINE_SOURCE_URL must use HTTPS in middleman production");
    }
  }
  if (parsed.SERVICE_ROLE === "api" && parsed.NODE_ENV === "production" && !parsed.AUTH_TOKEN_PEPPER) {
    throw new Error("AUTH_TOKEN_PEPPER is required for API production");
  }
  if (parsed.SERVICE_ROLE === "api" && parsed.NODE_ENV === "production" && !parsed.ARC_RECEIPT_SIGNER_PRIVATE_KEY) {
    throw new Error("ARC_RECEIPT_SIGNER_PRIVATE_KEY is required for API production");
  }
  if (parsed.ARC_CLEARING_MODE === "batch_v1" && parsed.ARC_BATCH_MAX_ORDERS > parsed.ARC_BATCH_EXECUTION_CHUNK_SIZE) {
    throw new Error("ARC_BATCH_MAX_ORDERS must not exceed ARC_BATCH_EXECUTION_CHUNK_SIZE for atomic execution");
  }

  const config: ArcConfig = {
    nodeEnv: parsed.NODE_ENV,
    serviceRole: parsed.SERVICE_ROLE,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    rpcUrl: parsed.ARC_RPC_URL,
    chainId: ARC_CHAIN_ID,
    usdcAddress: parsed.ARC_USDC_ADDRESS,
    apiUrl: parsed.ARC_API_URL.replace(/\/$/, ""),
    corsOrigins: parsed.ARC_CORS_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean),
    txlineSourceUrl: parsed.TXLINE_SOURCE_URL.replace(/\/$/, ""),
    authChallengeTtlSeconds: parsed.AUTH_CHALLENGE_TTL_SECONDS,
    jobPollIntervalMs: parsed.JOB_POLL_INTERVAL_MS,
    indexerPollIntervalMs: parsed.INDEXER_POLL_INTERVAL_MS,
    resultPollIntervalMs: parsed.RESULT_POLL_INTERVAL_MS,
    receiptSignerKeyId: parsed.ARC_RECEIPT_SIGNER_KEY_ID,
    clearingMode: parsed.ARC_CLEARING_MODE,
    batchIntervalMs: parsed.ARC_BATCH_INTERVAL_MS,
    batchMaxOrders: parsed.ARC_BATCH_MAX_ORDERS,
    batchExecutionChunkSize: parsed.ARC_BATCH_EXECUTION_CHUNK_SIZE,
  };
  if (parsed.DATABASE_URL) config.databaseUrl = parsed.DATABASE_URL;
  if (parsed.ARC_EXCHANGE_ADDRESS) config.exchangeAddress = parsed.ARC_EXCHANGE_ADDRESS;
  if (parsed.ARC_RELAYER_PRIVATE_KEY) config.relayerPrivateKey = parsed.ARC_RELAYER_PRIVATE_KEY as `0x${string}`;
  if (parsed.ARC_MARKET_ADMIN_PRIVATE_KEY) config.marketAdminPrivateKey = parsed.ARC_MARKET_ADMIN_PRIVATE_KEY as `0x${string}`;
  if (parsed.ARC_MATCHER_PRIVATE_KEY) config.matcherPrivateKey = parsed.ARC_MATCHER_PRIVATE_KEY as `0x${string}`;
  if (parsed.ARC_RESOLVER_PRIVATE_KEY) config.resolverPrivateKey = parsed.ARC_RESOLVER_PRIVATE_KEY as `0x${string}`;
  if (parsed.ARC_RECEIPT_SIGNER_PRIVATE_KEY) config.receiptSignerPrivateKey = parsed.ARC_RECEIPT_SIGNER_PRIVATE_KEY as `0x${string}`;
  if (parsed.ARC_OPERATOR_TOKEN) config.operatorToken = parsed.ARC_OPERATOR_TOKEN;
  if (parsed.AUTH_TOKEN_PEPPER) config.authTokenPepper = parsed.AUTH_TOKEN_PEPPER;
  if (parsed.INDEXER_START_BLOCK !== undefined) config.indexerStartBlock = parsed.INDEXER_START_BLOCK;
  return config;
}
