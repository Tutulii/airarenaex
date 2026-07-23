import { getAddress, isAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
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
  ARC_RPC_WITNESS_URL: z.string().url().default("https://rpc.testnet.arc.network"),
  ARC_RPC_MAX_BLOCK_LAG: z.coerce.number().int().min(1).max(1_000).default(20),
  ARC_CHAIN_ID: z.coerce.number().int().default(ARC_CHAIN_ID),
  ARC_USDC_ADDRESS: AddressSchema.default(ARC_USDC_ADDRESS),
  ARC_EXCHANGE_ADDRESS: OptionalAddressSchema,
  ARC_RELAYER_PRIVATE_KEY: OptionalPrivateKeySchema,
  ARC_UPGRADE_MULTISIG_PRIVATE_KEY: OptionalPrivateKeySchema,
  ARC_SEQUENCER_PRIVATE_KEY: OptionalPrivateKeySchema,
  ARC_MARKET_ADMIN_PRIVATE_KEY: OptionalPrivateKeySchema,
  ARC_MATCHER_PRIVATE_KEY: OptionalPrivateKeySchema,
  ARC_RESOLVER_PRIVATE_KEY: OptionalPrivateKeySchema,
  ARC_RECEIPT_SIGNER_PRIVATE_KEY: OptionalPrivateKeySchema,
  ARC_RECEIPT_SIGNER_KEY_ID: z.string().min(1).max(128).default("arc-v2-receipt-1"),
  ARC_API_URL: z.string().url().default("http://localhost:3000"),
  ARC_OPERATOR_TOKEN: z.string().min(32).optional(),
  ARC_CORS_ORIGINS: z.string().default(""),
  TXLINE_SOURCE_URL: z.string().url().default("https://api-server-production-8a16.up.railway.app"),
  TXLINE_SSE_URL: z.preprocess(
    (value) => (value === "" || value === undefined ? undefined : value),
    z.string().url().optional(),
  ),
  TXLINE_API_TOKEN: z.string().min(16).optional(),
  TXLINE_GUEST_JWT: z.string().min(16).optional(),
  SPORTMONKS_API_URL: z.string().url().default("https://api.sportmonks.com/v3/football"),
  SPORTMONKS_API_TOKEN: z.string().min(16).optional(),
  ARC_ORACLE_PRIMARY_SIGNER_PRIVATE_KEY: OptionalPrivateKeySchema,
  ARC_ORACLE_WITNESS_SIGNER_PRIVATE_KEY: OptionalPrivateKeySchema,
  ARC_ORACLE_RECOVERY_OBSERVATIONS: z.coerce.number().int().min(2).max(20).default(3),
  ARC_ORACLE_STALE_AFTER_SECONDS: z.coerce.number().int().min(15).max(3_600).default(180),
  ARC_LIQUIDITY_AGENT_PRIVATE_KEY: OptionalPrivateKeySchema,
  ARC_LIQUIDITY_AGENT_ADDRESS: OptionalAddressSchema,
  ARC_LIQUIDITY_VAULT_CAP_ATOMS: z.coerce.bigint().positive().default(100_000_000n),
  ARC_LIQUIDITY_INVENTORY_CAP_ATOMS: z.coerce.bigint().positive().default(50_000_000n),
  ARC_LIQUIDITY_NOTIONAL_CAP_ATOMS: z.coerce.bigint().positive().default(25_000_000n),
  ARC_LIQUIDITY_LOSS_CAP_ATOMS: z.coerce.bigint().nonnegative().default(10_000_000n),
  ARC_LIQUIDITY_DRAWDOWN_CAP_ATOMS: z.coerce.bigint().nonnegative().default(10_000_000n),
  ARC_LIQUIDITY_DAILY_VOLUME_CAP_ATOMS: z.coerce.bigint().positive().default(50_000_000n),
  ARC_WALLET_RESERVE_CAP_ATOMS: z.coerce.bigint().positive().default(100_000_000n),
  ARC_MARKET_RESERVE_CAP_ATOMS: z.coerce.bigint().positive().default(1_000_000_000n),
  ARC_BATCH_NOTIONAL_CAP_ATOMS: z.coerce.bigint().positive().default(250_000_000n),
  ARC_TREASURY_CAP_ATOMS: z.coerce.bigint().positive().default(100_000_000n),
  ARC_INGRESS_PER_MINUTE_CAP: z.coerce.number().int().min(1).max(100_000).default(1_000),
  ARC_WALLET_ORDERS_PER_MINUTE_CAP: z.coerce.number().int().min(1).max(10_000).default(60),
  ARC_ACTIVE_MARKET_CAP: z.coerce.number().int().min(1).max(10_000).default(100),
  ARC_GLOBAL_CUSTODY_CAP_ATOMS: z.coerce.bigint().positive().default(10_000_000_000n),
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
  rpcWitnessUrl: string;
  rpcMaxBlockLag: number;
  chainId: typeof ARC_CHAIN_ID;
  usdcAddress: Address;
  exchangeAddress?: Address;
  relayerPrivateKey?: `0x${string}`;
  upgradeMultisigPrivateKey?: `0x${string}`;
  sequencerPrivateKey?: `0x${string}`;
  resolverPrivateKey?: `0x${string}`;
  receiptSignerPrivateKey?: `0x${string}`;
  receiptSignerKeyId: string;
  apiUrl: string;
  operatorToken?: string;
  corsOrigins: string[];
  txlineSourceUrl: string;
  txlineSseUrl?: string;
  txlineApiToken?: string;
  txlineGuestJwt?: string;
  sportmonksApiUrl: string;
  sportmonksApiToken?: string;
  oraclePrimarySignerPrivateKey?: `0x${string}`;
  oracleWitnessSignerPrivateKey?: `0x${string}`;
  oracleRecoveryObservations: number;
  oracleStaleAfterSeconds: number;
  liquidityAgentPrivateKey?: `0x${string}`;
  liquidityAgentAddress?: Address;
  liquidityLimits: {
    vaultAtoms: bigint;
    inventoryAtoms: bigint;
    notionalAtoms: bigint;
    lossAtoms: bigint;
    drawdownAtoms: bigint;
    dailyVolumeAtoms: bigint;
  };
  riskLimits: {
    walletReserveAtoms: bigint;
    marketReserveAtoms: bigint;
    batchNotionalAtoms: bigint;
    treasuryAtoms: bigint;
    ingressPerMinute: number;
    walletOrdersPerMinute: number;
    activeMarkets: number;
    globalCustodyAtoms: bigint;
  };
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
    if (!(parsed.ARC_UPGRADE_MULTISIG_PRIVATE_KEY ?? parsed.ARC_MARKET_ADMIN_PRIVATE_KEY)) {
      throw new Error("ARC_UPGRADE_MULTISIG_PRIVATE_KEY is required for middleman production");
    }
    if (!(parsed.ARC_SEQUENCER_PRIVATE_KEY ?? parsed.ARC_MATCHER_PRIVATE_KEY)) {
      throw new Error("ARC_SEQUENCER_PRIVATE_KEY is required for middleman production");
    }
    if (!parsed.ARC_RESOLVER_PRIVATE_KEY) throw new Error("ARC_RESOLVER_PRIVATE_KEY is required for middleman production");
    if (!parsed.SPORTMONKS_API_TOKEN) throw new Error("SPORTMONKS_API_TOKEN is required for middleman production");
    if (!parsed.ARC_ORACLE_PRIMARY_SIGNER_PRIVATE_KEY) {
      throw new Error("ARC_ORACLE_PRIMARY_SIGNER_PRIVATE_KEY is required for middleman production");
    }
    if (!parsed.ARC_ORACLE_WITNESS_SIGNER_PRIVATE_KEY) {
      throw new Error("ARC_ORACLE_WITNESS_SIGNER_PRIVATE_KEY is required for middleman production");
    }
    if (!parsed.ARC_LIQUIDITY_AGENT_PRIVATE_KEY || !parsed.ARC_LIQUIDITY_AGENT_ADDRESS) {
      throw new Error("ARC_LIQUIDITY_AGENT_PRIVATE_KEY and ARC_LIQUIDITY_AGENT_ADDRESS are required for middleman production");
    }
    if (!parsed.TXLINE_SOURCE_URL.startsWith("https://")) {
      throw new Error("TXLINE_SOURCE_URL must use HTTPS in middleman production");
    }
    if (parsed.TXLINE_SSE_URL && !parsed.TXLINE_API_TOKEN) {
      throw new Error("TXLINE_API_TOKEN is required when TXLINE_SSE_URL is configured");
    }
  }
  if (parsed.SERVICE_ROLE === "api" && parsed.NODE_ENV === "production" && !parsed.AUTH_TOKEN_PEPPER) {
    throw new Error("AUTH_TOKEN_PEPPER is required for API production");
  }
  if (parsed.SERVICE_ROLE === "api" && parsed.NODE_ENV === "production" && !parsed.ARC_RECEIPT_SIGNER_PRIVATE_KEY) {
    throw new Error("ARC_RECEIPT_SIGNER_PRIVATE_KEY is required for API production");
  }
  if (parsed.SERVICE_ROLE === "api" && parsed.NODE_ENV === "production" && !parsed.ARC_LIQUIDITY_AGENT_ADDRESS) {
    throw new Error("ARC_LIQUIDITY_AGENT_ADDRESS is required for API production");
  }
  if (parsed.ARC_CLEARING_MODE === "batch_v1" && parsed.ARC_BATCH_MAX_ORDERS > parsed.ARC_BATCH_EXECUTION_CHUNK_SIZE) {
    throw new Error("ARC_BATCH_MAX_ORDERS must not exceed ARC_BATCH_EXECUTION_CHUNK_SIZE for atomic execution");
  }
  if (parsed.ARC_LIQUIDITY_NOTIONAL_CAP_ATOMS > parsed.ARC_LIQUIDITY_VAULT_CAP_ATOMS) {
    throw new Error("ARC_LIQUIDITY_NOTIONAL_CAP_ATOMS must not exceed the liquidity vault cap");
  }
  if (parsed.ARC_LIQUIDITY_LOSS_CAP_ATOMS > parsed.ARC_LIQUIDITY_VAULT_CAP_ATOMS
      || parsed.ARC_LIQUIDITY_DRAWDOWN_CAP_ATOMS > parsed.ARC_LIQUIDITY_VAULT_CAP_ATOMS) {
    throw new Error("liquidity loss and drawdown caps must not exceed the liquidity vault cap");
  }
  if (parsed.ARC_LIQUIDITY_AGENT_PRIVATE_KEY && parsed.ARC_LIQUIDITY_AGENT_ADDRESS
      && privateKeyToAccount(parsed.ARC_LIQUIDITY_AGENT_PRIVATE_KEY as `0x${string}`).address !== parsed.ARC_LIQUIDITY_AGENT_ADDRESS) {
    throw new Error("ARC_LIQUIDITY_AGENT_PRIVATE_KEY does not match ARC_LIQUIDITY_AGENT_ADDRESS");
  }

  const config: ArcConfig = {
    nodeEnv: parsed.NODE_ENV,
    serviceRole: parsed.SERVICE_ROLE,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    rpcUrl: parsed.ARC_RPC_URL,
    rpcWitnessUrl: parsed.ARC_RPC_WITNESS_URL,
    rpcMaxBlockLag: parsed.ARC_RPC_MAX_BLOCK_LAG,
    chainId: ARC_CHAIN_ID,
    usdcAddress: parsed.ARC_USDC_ADDRESS,
    apiUrl: parsed.ARC_API_URL.replace(/\/$/, ""),
    corsOrigins: parsed.ARC_CORS_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean),
    txlineSourceUrl: parsed.TXLINE_SOURCE_URL.replace(/\/$/, ""),
    sportmonksApiUrl: parsed.SPORTMONKS_API_URL.replace(/\/$/, ""),
    oracleRecoveryObservations: parsed.ARC_ORACLE_RECOVERY_OBSERVATIONS,
    oracleStaleAfterSeconds: parsed.ARC_ORACLE_STALE_AFTER_SECONDS,
    liquidityLimits: {
      vaultAtoms: parsed.ARC_LIQUIDITY_VAULT_CAP_ATOMS,
      inventoryAtoms: parsed.ARC_LIQUIDITY_INVENTORY_CAP_ATOMS,
      notionalAtoms: parsed.ARC_LIQUIDITY_NOTIONAL_CAP_ATOMS,
      lossAtoms: parsed.ARC_LIQUIDITY_LOSS_CAP_ATOMS,
      drawdownAtoms: parsed.ARC_LIQUIDITY_DRAWDOWN_CAP_ATOMS,
      dailyVolumeAtoms: parsed.ARC_LIQUIDITY_DAILY_VOLUME_CAP_ATOMS,
    },
    riskLimits: {
      walletReserveAtoms: parsed.ARC_WALLET_RESERVE_CAP_ATOMS,
      marketReserveAtoms: parsed.ARC_MARKET_RESERVE_CAP_ATOMS,
      batchNotionalAtoms: parsed.ARC_BATCH_NOTIONAL_CAP_ATOMS,
      treasuryAtoms: parsed.ARC_TREASURY_CAP_ATOMS,
      ingressPerMinute: parsed.ARC_INGRESS_PER_MINUTE_CAP,
      walletOrdersPerMinute: parsed.ARC_WALLET_ORDERS_PER_MINUTE_CAP,
      activeMarkets: parsed.ARC_ACTIVE_MARKET_CAP,
      globalCustodyAtoms: parsed.ARC_GLOBAL_CUSTODY_CAP_ATOMS,
    },
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
  const upgradeMultisigPrivateKey = parsed.ARC_UPGRADE_MULTISIG_PRIVATE_KEY ?? parsed.ARC_MARKET_ADMIN_PRIVATE_KEY;
  const sequencerPrivateKey = parsed.ARC_SEQUENCER_PRIVATE_KEY ?? parsed.ARC_MATCHER_PRIVATE_KEY;
  if (upgradeMultisigPrivateKey) config.upgradeMultisigPrivateKey = upgradeMultisigPrivateKey as `0x${string}`;
  if (sequencerPrivateKey) config.sequencerPrivateKey = sequencerPrivateKey as `0x${string}`;
  if (parsed.ARC_RESOLVER_PRIVATE_KEY) config.resolverPrivateKey = parsed.ARC_RESOLVER_PRIVATE_KEY as `0x${string}`;
  if (parsed.ARC_RECEIPT_SIGNER_PRIVATE_KEY) config.receiptSignerPrivateKey = parsed.ARC_RECEIPT_SIGNER_PRIVATE_KEY as `0x${string}`;
  if (parsed.ARC_OPERATOR_TOKEN) config.operatorToken = parsed.ARC_OPERATOR_TOKEN;
  if (parsed.AUTH_TOKEN_PEPPER) config.authTokenPepper = parsed.AUTH_TOKEN_PEPPER;
  if (parsed.TXLINE_SSE_URL) config.txlineSseUrl = parsed.TXLINE_SSE_URL;
  if (parsed.TXLINE_API_TOKEN) config.txlineApiToken = parsed.TXLINE_API_TOKEN;
  if (parsed.TXLINE_GUEST_JWT) config.txlineGuestJwt = parsed.TXLINE_GUEST_JWT;
  if (parsed.SPORTMONKS_API_TOKEN) config.sportmonksApiToken = parsed.SPORTMONKS_API_TOKEN;
  if (parsed.ARC_ORACLE_PRIMARY_SIGNER_PRIVATE_KEY) {
    config.oraclePrimarySignerPrivateKey = parsed.ARC_ORACLE_PRIMARY_SIGNER_PRIVATE_KEY as `0x${string}`;
  }
  if (parsed.ARC_ORACLE_WITNESS_SIGNER_PRIVATE_KEY) {
    config.oracleWitnessSignerPrivateKey = parsed.ARC_ORACLE_WITNESS_SIGNER_PRIVATE_KEY as `0x${string}`;
  }
  if (parsed.ARC_LIQUIDITY_AGENT_PRIVATE_KEY) {
    config.liquidityAgentPrivateKey = parsed.ARC_LIQUIDITY_AGENT_PRIVATE_KEY as `0x${string}`;
  }
  if (parsed.ARC_LIQUIDITY_AGENT_ADDRESS) config.liquidityAgentAddress = parsed.ARC_LIQUIDITY_AGENT_ADDRESS;
  if (parsed.INDEXER_START_BLOCK !== undefined) config.indexerStartBlock = parsed.INDEXER_START_BLOCK;
  return config;
}
