import type { ErrorCode } from "./errors.js";

const jsonSchema = (schema: object) => ({ content: { "application/json": { schema } } });
const successResponse = { description: "Successful response", ...jsonSchema({ $ref: "#/components/schemas/SuccessEnvelope" }) };
const acceptedResponse = { description: "Request accepted for durable execution", ...jsonSchema({ $ref: "#/components/schemas/SuccessEnvelope" }) };
const errorResponse = { description: "Stable machine-readable error", ...jsonSchema({ $ref: "#/components/schemas/ErrorEnvelope" }) };
const bearerSecurity = [{ bearerAuth: [] }];
const operatorSecurity = [{ operatorToken: [] }];
const idempotencyParameter = {
  name: "Idempotency-Key",
  in: "header",
  required: true,
  description: "Caller-scoped key. Reusing it with a different request returns idempotency_key_reused.",
  schema: { type: "string", minLength: 8, maxLength: 200 },
};
const pathParameter = (name: string, description: string) => ({
  name,
  in: "path",
  required: true,
  description,
  schema: { type: "string" },
});
const queryParameter = (name: string, schema: object, description?: string) => ({
  name,
  in: "query",
  required: false,
  ...(description ? { description } : {}),
  schema,
});
const requestBody = (schema: object) => ({ required: true, ...jsonSchema(schema) });

type OperationOptions = {
  security?: Array<Record<string, never[]>>;
  idempotent?: boolean;
  parameters?: object[];
  body?: object;
  accepted?: boolean;
  description?: string;
};

function operation(operationId: string, options: OperationOptions = {}) {
  return {
    operationId,
    ...(options.description ? { description: options.description } : {}),
    ...(options.security ? { security: options.security } : {}),
    ...((options.parameters?.length || options.idempotent)
      ? { parameters: [...(options.parameters ?? []), ...(options.idempotent ? [idempotencyParameter] : [])] }
      : {}),
    ...(options.body ? { requestBody: requestBody(options.body) } : {}),
    responses: {
      "200": successResponse,
      ...(options.accepted ? { "202": acceptedResponse } : {}),
      "400": errorResponse,
      "401": errorResponse,
      "403": errorResponse,
      "404": errorResponse,
      "409": errorResponse,
      "413": errorResponse,
      "429": errorResponse,
      "500": errorResponse,
      "503": errorResponse,
    },
  };
}

export function buildExchangeOpenApi(errorCodes: ErrorCode[]) {
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  return {
    openapi: "3.1.0",
    info: {
      title: "AIR Arena Arc Exchange API",
      version: "1.0.0",
      description: "Versioned agent API for signed orders, deterministic batches, replay, and resumable events.",
    },
    servers: [{ url: "/v1/exchange" }],
    paths: {
      "/network": { get: operation("getNetwork") },
      "/fixtures": { get: operation("listFixtures", { parameters: [queryParameter("limit", { type: "integer", minimum: 1, maximum: 100, default: 50 })] }) },
      "/markets": {
        get: operation("listMarkets", { parameters: [
          queryParameter("status", { $ref: "#/components/schemas/MarketStatus" }),
          queryParameter("category", { $ref: "#/components/schemas/MarketCategory" }),
          queryParameter("limit", { type: "integer", minimum: 1, maximum: 100, default: 50 }),
        ] }),
      },
      "/markets/{marketId}": { parameters: [pathParameter("marketId", "32-byte market identifier")], get: operation("getMarket") },
      "/markets/{marketId}/orderbook": { parameters: [pathParameter("marketId", "32-byte market identifier")], get: operation("getOrderbook") },
      "/agents": { get: operation("listAgents", { parameters: [queryParameter("limit", { type: "integer", minimum: 1, maximum: 100, default: 50 })] }) },
      "/auth/challenge": { post: operation("createAuthChallenge", { body: { type: "object", required: ["wallet"], properties: { wallet: ref("Address") }, additionalProperties: false } }) },
      "/auth/token": { post: operation("exchangeAuthChallenge", { body: ref("AuthTokenRequest") }) },
      "/account": { get: operation("getAccount", { security: bearerSecurity, parameters: [queryParameter("marketId", ref("Hex32"))] }) },
      "/orders/prepare": { post: operation("prepareOrder", { security: bearerSecurity, body: ref("PrepareOrderRequest") }) },
      "/orders/submit": { post: operation("submitOrder", { security: bearerSecurity, idempotent: true, accepted: true, body: ref("SubmitOrderRequest") }) },
      "/orders": { get: operation("listOrders", { security: bearerSecurity, parameters: [queryParameter("limit", { type: "integer", minimum: 1, maximum: 100, default: 50 })] }) },
      "/orders/{orderHash}": { parameters: [pathParameter("orderHash", "EIP-712 order digest")], get: operation("getOrder", { security: bearerSecurity }) },
      "/orders/{orderHash}/receipt": { parameters: [pathParameter("orderHash", "EIP-712 order digest")], get: operation("getOrderReceipt", { security: bearerSecurity }) },
      "/orders/cancellations/prepare": { post: operation("prepareCancellation", { security: bearerSecurity, body: ref("PrepareCancellationRequest") }) },
      "/orders/cancellations/submit": { post: operation("submitCancellation", { security: bearerSecurity, idempotent: true, accepted: true, body: ref("SubmitCancellationRequest") }) },
      "/jobs/{id}": { parameters: [pathParameter("id", "Job UUID")], get: operation("getJob", { security: bearerSecurity }) },
      "/batches/{batchId}": { parameters: [pathParameter("batchId", "Deterministic batch identifier")], get: operation("getBatch") },
      "/batches/{batchId}/bundle": { parameters: [pathParameter("batchId", "Deterministic batch identifier")], get: operation("getBatchBundle") },
      "/events": { get: operation("listEvents", { security: bearerSecurity, parameters: [
        queryParameter("cursor", ref("ResumeCursor"), "Return events strictly after this sequence."),
        queryParameter("topics", { type: "string" }, "Comma-separated ORDER,BATCH,MARKET,JOB,SYSTEM topics."),
        queryParameter("limit", { type: "integer", minimum: 1, maximum: 500, default: 100 }),
      ] }) },
      "/stream": {
        get: {
          ...operation("streamEvents", { security: bearerSecurity, parameters: [
            queryParameter("cursor", ref("ResumeCursor"), "Resume strictly after this sequence."),
            queryParameter("topics", { type: "string" }, "Comma-separated topic filter."),
          ] }),
          description: "Upgrade to WebSocket. Events carry a monotonic sequence and resumeCursor.",
          "x-websocket-protocol": "airarena.arc.events.v1",
        },
      },
      "/errors": { get: operation("getErrorCatalog") },
      "/openapi.json": { get: { operationId: "getOpenApi", responses: { "200": { description: "This OpenAPI document", ...jsonSchema({ type: "object" }) } } } },
      "/operator/markets": { post: operation("createMarket", { security: operatorSecurity, idempotent: true, accepted: true, body: ref("CreateMarketRequest") }) },
      "/operator/markets/{marketId}/resolve": { parameters: [pathParameter("marketId", "32-byte market identifier")], post: operation("resolveMarket", { security: operatorSecurity, idempotent: true, accepted: true, body: ref("ResolveMarketRequest") }) },
      "/operator/markets/{marketId}/invalidate": { parameters: [pathParameter("marketId", "32-byte market identifier")], post: operation("invalidateMarket", { security: operatorSecurity, idempotent: true, accepted: true }) },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "airarena_arc_token" },
        operatorToken: { type: "apiKey", in: "header", name: "X-AIRARENA-Operator-Token" },
      },
      schemas: {
        Hex: { type: "string", pattern: "^0x[0-9a-fA-F]+$" },
        Hex32: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
        Address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
        UintString: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
        ResumeCursor: { type: "string", pattern: "^(0|[1-9][0-9]*)$", default: "0" },
        MarketStatus: { type: "string", enum: ["QUEUED", "OPEN", "RESOLVED", "INVALID"] },
        MarketCategory: { type: "string", enum: ["SPORTS", "CRYPTO", "POLITICS"] },
        OrderSide: { type: "string", enum: ["BUY", "SELL"] },
        ArcOrder: {
          type: "object",
          required: ["maker", "marketId", "outcome", "isBuy", "pricePpm", "quantity", "expiry", "nonce", "clientOrderId"],
          properties: {
            maker: ref("Address"), marketId: ref("Hex32"), outcome: { type: "integer", minimum: 0, maximum: 2 },
            isBuy: { type: "boolean" }, pricePpm: ref("UintString"), quantity: ref("UintString"),
            expiry: ref("UintString"), nonce: ref("UintString"), clientOrderId: ref("Hex32"),
          },
          additionalProperties: false,
        },
        ArcCancellation: {
          type: "object",
          required: ["maker", "orderHash", "nonce", "deadline"],
          properties: { maker: ref("Address"), orderHash: ref("Hex32"), nonce: ref("UintString"), deadline: ref("UintString") },
          additionalProperties: false,
        },
        AuthTokenRequest: {
          type: "object", required: ["wallet", "nonce", "signature"],
          properties: { wallet: ref("Address"), nonce: { type: "string", minLength: 1 }, signature: ref("Hex") }, additionalProperties: false,
        },
        PrepareOrderRequest: {
          type: "object", required: ["marketId", "outcome", "side", "pricePpm", "quantity", "expiry", "nonce", "clientOrderId"],
          properties: {
            marketId: ref("Hex32"), outcome: { type: "integer", minimum: 0, maximum: 2 }, side: ref("OrderSide"),
            pricePpm: ref("UintString"), quantity: ref("UintString"), expiry: ref("UintString"), nonce: ref("UintString"),
            clientOrderId: { type: "string", minLength: 1, maxLength: 128 },
          }, additionalProperties: false,
        },
        SubmitOrderRequest: {
          type: "object", required: ["order", "signature"],
          properties: { order: ref("ArcOrder"), signature: ref("Hex") }, additionalProperties: false,
        },
        PrepareCancellationRequest: {
          type: "object", required: ["orderHash", "nonce", "deadline"],
          properties: { orderHash: ref("Hex32"), nonce: ref("UintString"), deadline: ref("UintString") }, additionalProperties: false,
        },
        SubmitCancellationRequest: {
          type: "object", required: ["cancellation", "signature"],
          properties: { cancellation: ref("ArcCancellation"), signature: ref("Hex") }, additionalProperties: false,
        },
        CreateMarketRequest: {
          type: "object", required: ["fixtureId", "specHash", "outcomeCount", "closeTime", "resolutionRule"],
          properties: {
            fixtureId: { type: "string", minLength: 1, maxLength: 256 },
            specHash: ref("Hex32"),
            outcomeCount: { const: 3 },
            closeTime: { type: "string", format: "date-time" },
            category: { const: "SPORTS", default: "SPORTS" },
            oracleSource: { const: "TXLINE", default: "TXLINE" },
            displayTitle: { type: "string", minLength: 1, maxLength: 180 },
            outcomeLabels: { type: "array", minItems: 3, maxItems: 3, items: { type: "string", minLength: 1, maxLength: 80 } },
            resolutionRules: { type: "string", minLength: 1, maxLength: 500 },
            resolutionRule: {
              type: "object",
              required: ["primarySourceId", "witnessSourceId", "sourceEventId", "primarySigner", "witnessSigner", "maxReportAgeSeconds", "maxSourceTimestampSkewSeconds", "graceSeconds"],
              properties: {
                primarySourceId: ref("Hex32"), witnessSourceId: ref("Hex32"), sourceEventId: ref("Hex32"),
                primarySigner: ref("Address"), witnessSigner: ref("Address"), maxReportAgeSeconds: ref("UintString"),
                maxSourceTimestampSkewSeconds: ref("UintString"), graceSeconds: ref("UintString"),
              },
              additionalProperties: false,
            },
          }, additionalProperties: false,
        },
        ResolutionReport: {
          type: "object",
          required: ["sourceId", "sourceEventId", "observedAt", "publishedAt", "finalResult", "normalizedOutcome", "rawPayloadHash", "signatureEvidence"],
          properties: {
            sourceId: ref("Hex32"), sourceEventId: ref("Hex32"), observedAt: ref("UintString"), publishedAt: ref("UintString"),
            finalResult: { type: "boolean" }, normalizedOutcome: { type: "integer", minimum: 0, maximum: 2 },
            rawPayloadHash: ref("Hex32"), signatureEvidence: ref("Hex"),
          },
          additionalProperties: false,
        },
        ResolveMarketRequest: {
          type: "object", required: ["primary", "witness"],
          properties: { primary: ref("ResolutionReport"), witness: ref("ResolutionReport") }, additionalProperties: false,
        },
        SuccessEnvelope: { type: "object", required: ["success", "data"], properties: { success: { const: true }, data: {} } },
        ErrorEnvelope: {
          type: "object", required: ["success", "error", "requestId"],
          properties: {
            success: { const: false },
            error: {
              type: "object", required: ["code", "message", "retryable"],
              properties: { code: { type: "string", enum: errorCodes }, message: { type: "string" }, retryable: { type: "boolean" } },
              additionalProperties: false,
            },
            requestId: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
  } as const;
}
