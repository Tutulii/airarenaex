import { randomUUID } from "node:crypto";
import type {
  Address,
  ApiErrorBody,
  ApiSuccess,
  AcceptanceReceipt,
  AccountState,
  AgentDirectoryEntry,
  ArcCancellation,
  ArcOrder,
  AuthChallenge,
  AuthToken,
  BatchRecord,
  CreateMarketInput,
  ErrorCatalog,
  EventPage,
  FixtureResponse,
  Hex,
  JobSummary,
  MarketRecord,
  MarketCategory,
  MarketStatus,
  NetworkInfo,
  OperatorJobResult,
  OperatorMarketResult,
  OrderRecord,
  Orderbook,
  PrepareOrderInput,
  PublicBatchBundle,
  SubmitCancellationResult,
  SubmitOrderResult,
} from "./types.js";

export class AirArenaApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;
  readonly requestId?: string;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error.message);
    this.name = "AirArenaApiError";
    this.code = body.error.code;
    this.retryable = body.error.retryable;
    this.status = status;
    if (body.requestId) this.requestId = body.requestId;
  }
}

export type AgentClientOptions = {
  baseUrl: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
};

export class AirArenaAgentClient {
  readonly baseUrl: string;
  private token?: string;
  private readonly fetchImplementation: typeof globalThis.fetch;

  constructor(options: AgentClientOptions) {
    const root = options.baseUrl.replace(/\/$/, "");
    this.baseUrl = root.endsWith("/v1/exchange") ? root : `${root}/v1/exchange`;
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    if (!this.fetchImplementation) throw new Error("fetch_implementation_required");
    if (options.token) this.token = options.token;
  }

  setToken(token: string): void {
    if (!token) throw new Error("token_required");
    this.token = token;
  }

  getToken(): string | undefined {
    return this.token;
  }

  async request<T>(
    path: string,
    options: { method?: "GET" | "POST"; body?: unknown; idempotencyKey?: string; operatorToken?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
    if (options.operatorToken) headers["x-airarena-operator-token"] = options.operatorToken;
    const response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const body = await response.json() as ApiSuccess<T> | ApiErrorBody;
    if (!response.ok || body.success === false) {
      if (body.success === false && typeof body.error === "object") throw new AirArenaApiError(response.status, body);
      throw new Error(`airarena_http_${response.status}`);
    }
    return body.data;
  }

  network<T = NetworkInfo>(): Promise<T> { return this.request<T>("/network"); }
  fixtures<T = FixtureResponse>(limit = 50): Promise<T> { return this.request<T>(`/fixtures?limit=${limit}`); }
  markets<T = MarketRecord[]>(filters: { status?: MarketStatus; category?: MarketCategory; limit?: number } = {}): Promise<T> {
    const query = new URLSearchParams();
    if (filters.status) query.set("status", filters.status);
    if (filters.category) query.set("category", filters.category);
    if (filters.limit) query.set("limit", filters.limit.toString());
    return this.request<T>(`/markets${query.size ? `?${query}` : ""}`);
  }
  market<T = MarketRecord>(marketId: Hex): Promise<T> { return this.request<T>(`/markets/${marketId}`); }
  orderbook<T = Orderbook>(marketId: Hex): Promise<T> { return this.request<T>(`/markets/${marketId}/orderbook`); }
  agents<T = AgentDirectoryEntry[]>(limit = 50): Promise<T> { return this.request<T>(`/agents?limit=${limit}`); }
  account<T = AccountState>(marketId?: Hex): Promise<T> {
    return this.request<T>(`/account${marketId ? `?marketId=${marketId}` : ""}`);
  }
  authChallenge<T = AuthChallenge>(wallet: Address): Promise<T> {
    return this.request<T>("/auth/challenge", { method: "POST", body: { wallet } });
  }
  authToken<T = AuthToken>(input: { wallet: Address; nonce: string; signature: Hex }): Promise<T> {
    return this.request<T>("/auth/token", { method: "POST", body: input });
  }
  prepareOrder<T = { order: ArcOrder; orderHash: Hex; typedData: unknown }>(input: PrepareOrderInput): Promise<T> {
    return this.request<T>("/orders/prepare", { method: "POST", body: input });
  }
  submitOrder<T = SubmitOrderResult>(order: ArcOrder, signature: Hex, idempotencyKey = randomUUID()): Promise<T> {
    return this.request<T>("/orders/submit", { method: "POST", body: { order, signature }, idempotencyKey });
  }
  prepareCancellation<T = { cancellation: ArcCancellation; cancellationHash: Hex; typedData: unknown }>(
    input: { orderHash: Hex; nonce: string; deadline: string },
  ): Promise<T> {
    return this.request<T>("/orders/cancellations/prepare", { method: "POST", body: input });
  }
  submitCancellation<T = SubmitCancellationResult>(cancellation: ArcCancellation, signature: Hex, idempotencyKey = randomUUID()): Promise<T> {
    return this.request<T>("/orders/cancellations/submit", {
      method: "POST",
      body: { cancellation, signature },
      idempotencyKey,
    });
  }
  orders<T = OrderRecord[]>(limit = 50): Promise<T> { return this.request<T>(`/orders?limit=${limit}`); }
  order<T = OrderRecord>(orderHash: Hex): Promise<T> { return this.request<T>(`/orders/${orderHash}`); }
  receipt<T = AcceptanceReceipt | null>(orderHash: Hex): Promise<T> { return this.request<T>(`/orders/${orderHash}/receipt`); }
  job<T = JobSummary>(id: string): Promise<T> { return this.request<T>(`/jobs/${encodeURIComponent(id)}`); }
  batch<T = BatchRecord>(batchId: Hex): Promise<T> { return this.request<T>(`/batches/${batchId}`); }
  batchBundle<T = PublicBatchBundle>(batchId: Hex): Promise<T> { return this.request<T>(`/batches/${batchId}/bundle`); }
  events<T = EventPage>(cursor = "0", topics: string[] = [], limit = 100): Promise<T> {
    const query = new URLSearchParams({ cursor, limit: limit.toString() });
    if (topics.length) query.set("topics", topics.join(","));
    return this.request<T>(`/events?${query}`);
  }
  errorCatalog<T = ErrorCatalog>(): Promise<T> { return this.request<T>("/errors"); }
  createMarket<T = OperatorMarketResult>(input: CreateMarketInput, operatorToken: string, idempotencyKey = randomUUID()): Promise<T> {
    return this.request<T>("/operator/markets", {
      method: "POST", body: input, operatorToken, idempotencyKey,
    });
  }
  resolveMarket<T = OperatorJobResult>(marketId: Hex, winningOutcome: number, operatorToken: string, idempotencyKey = randomUUID()): Promise<T> {
    return this.request<T>(`/operator/markets/${marketId}/resolve`, {
      method: "POST", body: { winningOutcome }, operatorToken, idempotencyKey,
    });
  }
  invalidateMarket<T = OperatorJobResult>(marketId: Hex, operatorToken: string, idempotencyKey = randomUUID()): Promise<T> {
    return this.request<T>(`/operator/markets/${marketId}/invalidate`, {
      method: "POST", operatorToken, idempotencyKey,
    });
  }
  async openApi<T = unknown>(): Promise<T> {
    const response = await this.fetchImplementation(`${this.baseUrl}/openapi.json`, {
      headers: { accept: "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
    });
    const body = await response.json() as T | ApiErrorBody;
    if (!response.ok) {
      if ((body as ApiErrorBody).success === false) throw new AirArenaApiError(response.status, body as ApiErrorBody);
      throw new Error(`airarena_http_${response.status}`);
    }
    return body as T;
  }
}
