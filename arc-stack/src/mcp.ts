import Fastify, { type FastifyRequest } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { encodeFunctionData, erc20Abi, getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import { z } from "zod";
import { arenaExchangeAbi } from "./chain.js";
import type { ArcConfig } from "./config.js";
import type { Logger } from "./logger.js";

type JsonRpcId = string | number | null;
type JsonRpcRequest = { jsonrpc?: string; id?: JsonRpcId; method?: string; params?: unknown };
type ToolCall = { name?: string; arguments?: Record<string, unknown> };

const UintString = z.string().regex(/^(0|[1-9][0-9]*)$/);
const Hex32 = z.string().refine((value) => isHex(value, { strict: true }) && value.length === 66);
const PrepareOrderInput = z.object({
  marketId: Hex32,
  outcome: z.number().int().min(0).max(2),
  side: z.enum(["BUY", "SELL"]),
  pricePpm: UintString,
  quantity: UintString,
  expiry: UintString,
  nonce: UintString,
  clientOrderId: z.string().min(1).max(128),
});
const SubmitOrderInput = z.object({
  order: z.record(z.string(), z.unknown()),
  signature: z.string().refine((value) => isHex(value, { strict: true })),
  idempotencyKey: z.string().min(8).max(200),
});
const PrepareCancellationInput = z.object({
  orderHash: Hex32,
  nonce: UintString,
  deadline: UintString,
});
const SubmitCancellationInput = z.object({
  cancellation: z.record(z.string(), z.unknown()),
  signature: z.string().refine((value) => isHex(value, { strict: true })),
  idempotencyKey: z.string().min(8).max(200),
});

const COMMON_NETWORK_NOTE =
  "Arc Testnet only (chain ID 5042002). USDC application amounts use the six-decimal ERC-20 interface. Agents sign transactions with their own EVM wallet; this MCP never accepts private keys.";

export const ARC_MCP_TOOLS = [
  {
    name: "airarena_arc_get_network",
    description: `Return the fixed AIR Arena Arc network and deployed contract configuration. ${COMMON_NETWORK_NOTE}`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "airarena_arc_list_fixtures",
    description: "List TxLINE sports fixtures available to the Arc market layer.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
      additionalProperties: false,
    },
  },
  {
    name: "airarena_arc_list_markets",
    description: "List AIR Arena markets deployed or queued for Arc Testnet.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["QUEUED", "OPEN", "RESOLVED", "INVALID"] },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "airarena_arc_prepare_deposit",
    description: `Prepare USDC approval and exchange deposit calls for signing by the agent wallet. ${COMMON_NETWORK_NOTE}`,
    inputSchema: {
      type: "object",
      properties: { amount: { type: "string", pattern: "^(0|[1-9][0-9]*)$", description: "USDC base units (6 decimals)" } },
      required: ["amount"],
      additionalProperties: false,
    },
  },
  {
    name: "airarena_arc_prepare_withdrawal",
    description: `Prepare an exchange withdrawal transaction for agent signing. ${COMMON_NETWORK_NOTE}`,
    inputSchema: {
      type: "object",
      properties: {
        amount: { type: "string", pattern: "^(0|[1-9][0-9]*)$", description: "USDC base units (6 decimals)" },
        recipient: { type: "string", description: "EVM recipient address" },
      },
      required: ["amount", "recipient"],
      additionalProperties: false,
    },
  },
  {
    name: "airarena_arc_prepare_complete_set",
    description: "Prepare a fully collateralized complete-set split transaction for agent signing.",
    inputSchema: {
      type: "object",
      properties: {
        marketId: { type: "string", description: "bytes32 market ID" },
        quantity: { type: "string", pattern: "^(0|[1-9][0-9]*)$", description: "Share/USDC base units" },
      },
      required: ["marketId", "quantity"],
      additionalProperties: false,
    },
  },
  {
    name: "airarena_arc_prepare_order",
    description: "Prepare EIP-712 typed data for a funded BUY or SELL outcome-share order. Requires orders:write.",
    inputSchema: {
      type: "object",
      properties: {
        marketId: { type: "string" },
        outcome: { type: "integer", minimum: 0, maximum: 2 },
        side: { type: "string", enum: ["BUY", "SELL"] },
        pricePpm: { type: "string", description: "Price from 1 to 999999, where 1000000 equals 1 USDC" },
        quantity: { type: "string", description: "Outcome-share base units (6 decimals)" },
        expiry: { type: "string", description: "Unix timestamp seconds" },
        nonce: { type: "string" },
        clientOrderId: { type: "string", minLength: 1, maxLength: 128 },
      },
      required: ["marketId", "outcome", "side", "pricePpm", "quantity", "expiry", "nonce", "clientOrderId"],
      additionalProperties: false,
    },
  },
  {
    name: "airarena_arc_submit_signed_order",
    description: "Submit an agent-signed EIP-712 order to the durable Arc relayer queue. Requires orders:write.",
    inputSchema: {
      type: "object",
      properties: {
        order: { type: "object" },
        signature: { type: "string", description: "0x-prefixed EIP-712 signature" },
        idempotencyKey: { type: "string", minLength: 8, maxLength: 200 },
      },
      required: ["order", "signature", "idempotencyKey"],
      additionalProperties: false,
    },
  },
  {
    name: "airarena_arc_list_my_orders",
    description: "List orders for the wallet bound to the Arc MCP token. Requires orders:read.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
      additionalProperties: false,
    },
  },
  {
    name: "airarena_arc_get_job",
    description: "Get durable relayer job status and the Arcscan transaction link. Requires orders:read.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string", format: "uuid" } },
      required: ["jobId"],
      additionalProperties: false,
    },
  },
  {
    name: "airarena_arc_prepare_cancel_order",
    description: "Prepare an EIP-712 cancellation envelope for maker signing and permissionless relay.",
    inputSchema: {
      type: "object",
      properties: {
        orderHash: { type: "string", description: "bytes32 EIP-712 order hash" },
        nonce: { type: "string", description: "Cancellation-namespace nonce" },
        deadline: { type: "string", description: "Unix timestamp seconds" },
      },
      required: ["orderHash", "nonce", "deadline"],
      additionalProperties: false,
    },
  },
  {
    name: "airarena_arc_submit_signed_cancellation",
    description: "Submit a maker-signed EIP-712 cancellation to the durable Arc relayer queue.",
    inputSchema: {
      type: "object",
      properties: {
        cancellation: { type: "object" },
        signature: { type: "string", description: "0x-prefixed EIP-712 signature" },
        idempotencyKey: { type: "string", minLength: 8, maxLength: 200 },
      },
      required: ["cancellation", "signature", "idempotencyKey"],
      additionalProperties: false,
    },
  },
  {
    name: "airarena_arc_prepare_redeem",
    description: "Prepare a resolved or invalid market redemption call for agent signing.",
    inputSchema: {
      type: "object",
      properties: { marketId: { type: "string", description: "bytes32 market ID" } },
      required: ["marketId"],
      additionalProperties: false,
    },
  },
] as const;

function authorization(request: FastifyRequest): string | undefined {
  const value = request.headers.authorization;
  return Array.isArray(value) ? value[0] : value;
}

function jsonRpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function toolContent(data: unknown, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    ...(isError ? { isError: true } : {}),
  };
}

async function apiRequest(
  config: ArcConfig,
  request: FastifyRequest,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body) headers.set("content-type", "application/json");
  const auth = authorization(request);
  if (auth) headers.set("authorization", auth);
  const response = await fetch(`${config.apiUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(15_000) });
  const data = await response.json().catch(() => ({ success: false, error: `api_http_${response.status}` }));
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function network(config: ArcConfig, request: FastifyRequest): Promise<Record<string, unknown>> {
  const response = await apiRequest(config, request, "/v1/network") as { data?: Record<string, unknown> };
  if (!response.data?.exchangeAddress || typeof response.data.exchangeAddress !== "string") {
    throw new Error("arc_exchange_not_configured");
  }
  return response.data;
}

function transaction(to: Address, data: Hex, description: string) {
  return { network: "arc-testnet", chainId: 5_042_002, to, data, value: "0", description };
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  config: ArcConfig,
  request: FastifyRequest,
): Promise<unknown> {
  switch (name) {
    case "airarena_arc_get_network":
      return apiRequest(config, request, "/v1/network");
    case "airarena_arc_list_fixtures": {
      const limit = Math.min(100, Math.max(1, Number(args.limit ?? 50) || 50));
      return apiRequest(config, request, `/v1/fixtures?limit=${limit}`);
    }
    case "airarena_arc_list_markets": {
      const params = new URLSearchParams({ limit: String(Math.min(100, Math.max(1, Number(args.limit ?? 50) || 50))) });
      if (typeof args.status === "string") params.set("status", args.status);
      return apiRequest(config, request, `/v1/markets?${params}`);
    }
    case "airarena_arc_prepare_deposit": {
      const amount = UintString.parse(args.amount);
      if (BigInt(amount) <= 0n) throw new Error("amount_must_be_positive");
      const net = await network(config, request);
      const exchange = getAddress(String(net.exchangeAddress));
      const usdc = getAddress(String(net.usdcAddress));
      return {
        sequence: [
          transaction(
            usdc,
            encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [exchange, BigInt(amount)] }),
            "Approve the AIR Arena Arc exchange to transfer this exact USDC amount",
          ),
          transaction(
            exchange,
            encodeFunctionData({ abi: arenaExchangeAbi, functionName: "deposit", args: [BigInt(amount)] }),
            "Deposit six-decimal USDC into the agent's exchange balance",
          ),
        ],
      };
    }
    case "airarena_arc_prepare_withdrawal": {
      const amount = UintString.parse(args.amount);
      const recipient = z.string().refine(isAddress).transform((value) => getAddress(value)).parse(args.recipient);
      if (BigInt(amount) <= 0n) throw new Error("amount_must_be_positive");
      const net = await network(config, request);
      const exchange = getAddress(String(net.exchangeAddress));
      return transaction(
        exchange,
        encodeFunctionData({ abi: arenaExchangeAbi, functionName: "withdraw", args: [BigInt(amount), recipient] }),
        "Withdraw available six-decimal USDC to the selected EVM address",
      );
    }
    case "airarena_arc_prepare_complete_set": {
      const marketId = Hex32.parse(args.marketId) as Hex;
      const quantity = UintString.parse(args.quantity);
      if (BigInt(quantity) <= 0n) throw new Error("quantity_must_be_positive");
      const net = await network(config, request);
      const exchange = getAddress(String(net.exchangeAddress));
      return transaction(
        exchange,
        encodeFunctionData({ abi: arenaExchangeAbi, functionName: "splitCompleteSet", args: [marketId, BigInt(quantity)] }),
        "Lock collateral and mint one share for every market outcome",
      );
    }
    case "airarena_arc_prepare_order": {
      const input = PrepareOrderInput.parse(args);
      return apiRequest(config, request, "/v1/orders/prepare", { method: "POST", body: JSON.stringify(input) });
    }
    case "airarena_arc_submit_signed_order": {
      const input = SubmitOrderInput.parse(args);
      return apiRequest(config, request, "/v1/orders/submit", {
        method: "POST",
        headers: { "idempotency-key": input.idempotencyKey },
        body: JSON.stringify({ order: input.order, signature: input.signature }),
      });
    }
    case "airarena_arc_list_my_orders": {
      const limit = Math.min(100, Math.max(1, Number(args.limit ?? 50) || 50));
      return apiRequest(config, request, `/v1/orders?limit=${limit}`);
    }
    case "airarena_arc_get_job": {
      const jobId = z.string().uuid().parse(args.jobId);
      return apiRequest(config, request, `/v1/jobs/${encodeURIComponent(jobId)}`);
    }
    case "airarena_arc_prepare_cancel_order": {
      const input = PrepareCancellationInput.parse(args);
      return apiRequest(config, request, "/v1/orders/cancellations/prepare", {
        method: "POST",
        body: JSON.stringify(input),
      });
    }
    case "airarena_arc_submit_signed_cancellation": {
      const input = SubmitCancellationInput.parse(args);
      return apiRequest(config, request, "/v1/orders/cancellations/submit", {
        method: "POST",
        headers: { "idempotency-key": input.idempotencyKey },
        body: JSON.stringify({ cancellation: input.cancellation, signature: input.signature }),
      });
    }
    case "airarena_arc_prepare_redeem": {
      const marketId = Hex32.parse(args.marketId) as Hex;
      const net = await network(config, request);
      const exchange = getAddress(String(net.exchangeAddress));
      return transaction(
        exchange,
        encodeFunctionData({ abi: arenaExchangeAbi, functionName: "redeem", args: [marketId] }),
        "Redeem the agent's resolved or invalid market positions into available USDC",
      );
    }
    default:
      throw new Error(`unknown_arc_tool:${name}`);
  }
}

export async function startMcp(config: ArcConfig, logger: Logger): Promise<void> {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024, trustProxy: true });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute", ban: 2 });
  app.get("/health/live", async () => ({ status: "ok", service: "airarena-arc-mcp", tools: ARC_MCP_TOOLS.length }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      const response = await fetch(`${config.apiUrl}/health/ready`, { signal: AbortSignal.timeout(10_000) });
      return reply.status(response.ok ? 200 : 503).send({ status: response.ok ? "ready" : "not_ready", api: response.status });
    } catch {
      return reply.status(503).send({ status: "not_ready", api: "unreachable" });
    }
  });
  app.post<{ Body: JsonRpcRequest }>("/mcp", async (request, reply) => {
    const rpc = request.body ?? {};
    const id = rpc.id ?? null;
    if (rpc.jsonrpc !== "2.0" || !rpc.method) return reply.status(400).send(jsonRpcError(id, -32600, "Invalid Request"));
    if (rpc.method === "initialize") {
      return jsonRpcResult(id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "airarena-arc-mcp", version: "0.1.0" },
        instructions: COMMON_NETWORK_NOTE,
      });
    }
    if (rpc.method === "notifications/initialized") return reply.status(202).send();
    if (rpc.method === "ping") return jsonRpcResult(id, {});
    if (rpc.method === "tools/list") return jsonRpcResult(id, { tools: ARC_MCP_TOOLS });
    if (rpc.method === "tools/call") {
      const params = (rpc.params ?? {}) as ToolCall;
      if (!params.name) return jsonRpcError(id, -32602, "Tool name is required");
      try {
        const result = await callTool(params.name, params.arguments ?? {}, config, request);
        return jsonRpcResult(id, toolContent(result));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn({ requestId: request.id, tool: params.name, err: error }, "arc_mcp_tool_failed");
        return jsonRpcResult(id, toolContent({ error: message, requestId: request.id }, true));
      }
    }
    return jsonRpcError(id, -32601, "Method not found");
  });

  await app.listen({ host: "0.0.0.0", port: config.port });
  logger.info({ port: config.port, tools: ARC_MCP_TOOLS.length }, "arc_mcp_started");
}
