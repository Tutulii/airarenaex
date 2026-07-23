export type Hex = `0x${string}`;
export type Address = `0x${string}`;
export type MarketCategory = "SPORTS" | "CRYPTO" | "POLITICS";
export type MarketStatus = "QUEUED" | "OPEN" | "RESOLVED" | "INVALID";
export type OrderSide = "BUY" | "SELL";
export type EventTopic = "ORDER" | "BATCH" | "MARKET" | "JOB" | "SYSTEM";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ApiSuccess<T> = { success: true; data: T };
export type ApiErrorBody = {
  success: false;
  error: { code: string; message: string; retryable: boolean };
  requestId: string;
};

export type ArcOrder = {
  maker: Address;
  marketId: Hex;
  outcome: number;
  isBuy: boolean;
  pricePpm: string;
  quantity: string;
  nonce: string;
  expiry: string;
  clientOrderId: Hex;
};

export type ArcCancellation = {
  maker: Address;
  orderHash: Hex;
  nonce: string;
  deadline: string;
};

export type PrepareOrderInput = {
  marketId: Hex;
  outcome: number;
  side: OrderSide;
  pricePpm: string;
  quantity: string;
  nonce: string;
  expiry: string;
  clientOrderId: string;
};

export type CreateMarketInput = {
  fixtureId: string;
  outcomeCount: 3;
  closeTime: string;
  category?: "SPORTS";
  oracleSource?: "TXLINE";
  displayTitle?: string;
  outcomeLabels?: [string, string, string];
  resolutionRules?: string;
};

export type NetworkInfo = {
  network: "arc-testnet";
  chainId: number;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  usdcAddress: Address;
  usdcApplicationDecimals: 6;
  exchangeAddress: Address | null;
  explorerUrl: string;
};

/** TxLINE owns the fixture payload schema; AIR Arena intentionally preserves it verbatim. */
export type FixtureResponse = JsonValue;

export type MarketRecord = {
  market_id: Hex;
  fixture_id: string;
  external_id_hash: Hex;
  outcome_count: number;
  close_time: string;
  status: MarketStatus;
  category: MarketCategory;
  oracle_source: string;
  oracle_reference: string;
  display_title: string | null;
  outcome_labels: string[];
  resolution_rules: string;
  settlement_policy: string;
  winning_outcome: number | null;
  result_home_score: number | null;
  result_away_score: number | null;
  result_source: string | null;
  result_source_update_id: string | null;
  result_source_timestamp: string | null;
  result_observed_at: string | null;
  result_evidence_hash: Hex | null;
  create_tx_hash: Hex | null;
  resolution_tx_hash: Hex | null;
  created_at: string;
  updated_at: string;
};

export type OrderbookLevel = { pricePpm: string; quantity: string; orderCount: number };
export type OutcomeOrderbook = {
  outcome: number;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  bestBidPpm: string | null;
  bestAskPpm: string | null;
  indicativePricePpm: string | null;
};
export type Orderbook = { marketId: Hex; outcomeCount: number; outcomes: OutcomeOrderbook[] };

export type AgentDirectoryEntry = {
  wallet: Address;
  totalOrders: number;
  activeOrders: number;
  filledOrders: number;
  matchedQuantity: string;
  lastActiveAt: string;
};

export type AccountState = {
  wallet: Address;
  walletBalance: string;
  exchangeAllowance: string;
  availableCollateral: string;
  marketId: Hex | null;
  positions: string[];
};

export type AuthChallenge = { wallet: Address; nonce: string; message: string; expiresAt: string };
export type AuthToken = { token: string; wallet: Address; scopes: string[] };

export type AcceptanceReceipt = {
  orderHash: Hex;
  maker: Address;
  sequence: string;
  acceptedAt: string;
  acceptedAtUnix: string;
  requestHash: Hex;
  receiptDigest: Hex;
  signerKeyId: string;
  signerAddress: Address;
  signature: Hex;
};

export type JobSummary = {
  id: string;
  kind?: string;
  status: string;
  attempts?: number;
  max_attempts?: number;
  available_at?: string;
  last_error?: string | null;
  tx_hash?: Hex | null;
  created_at?: string;
  updated_at?: string;
  explorerUrl?: string | null;
  created?: boolean;
};

export type SubmitOrderResult = { orderHash: Hex; receipt: AcceptanceReceipt; job: JobSummary | null };
export type SubmitCancellationResult = { orderHash: Hex; cancellationHash: Hex; job: JobSummary };

export type OrderRecord = {
  order_hash: Hex;
  maker: Address;
  market_id: Hex;
  outcome: number;
  side: OrderSide;
  price_ppm: string;
  quantity: string;
  filled_quantity: string;
  nonce: string;
  expiry: string;
  client_order_id: Hex;
  status: string;
  tx_hash: Hex | null;
  accepted_sequence: string | null;
  assigned_batch_id: Hex | null;
  cancellation_nonce?: string | null;
  cancellation_deadline?: string | null;
  cancellation_digest?: Hex | null;
  created_at: string;
  updated_at: string;
};

export type BatchRecord = {
  batch_id: Hex;
  market_id: Hex;
  outcome: number;
  policy_version: string;
  policy_hash: Hex;
  batch_start: string;
  batch_end: string;
  cancellation_cutoff: string;
  status: string;
  input_root: Hex | null;
  result_hash: Hex | null;
  clearing_price_ppm: string | null;
  executable_quantity: string | null;
  sealed_at: string | null;
  executed_at: string | null;
  order_root: Hex | null;
  fill_root: Hex | null;
  bundle_hash: Hex | null;
  published_at: string | null;
};

export type PublicBatchBundle = JsonObject & {
  schemaVersion: string;
  batchId: Hex;
  policyVersion: string;
  policyHash: Hex;
  orderRoot: Hex;
  fillRoot: Hex;
  inputRoot: Hex;
  resultHash: Hex;
  bundleHash: Hex;
};

export type EventPage = {
  protocol: "airarena.arc.events.v1";
  events: ExchangeEvent[];
  resumeCursor: string;
};

export type ErrorCatalog = Record<string, { status: number; message: string; retryable: boolean }>;
export type OperatorMarketResult = {
  marketId: Hex;
  externalIdHash: Hex;
  job: JobSummary;
};
export type OperatorJobResult = { job: JobSummary };

export type ExchangeEvent = {
  type: "event";
  sequence: string;
  resumeCursor: string;
  eventId: Hex;
  topic: EventTopic;
  entityId: string;
  eventType: string;
  payload: JsonValue;
  payloadHash: Hex;
  sourceRoot: Hex | null;
  occurredAt: string;
};
