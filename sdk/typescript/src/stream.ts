import WebSocket from "ws";
import type { EventTopic, ExchangeEvent } from "./types.js";

export type EventSubscriptionOptions = {
  baseUrl: string;
  token: string;
  cursor?: string;
  topics?: EventTopic[];
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  WebSocket?: typeof WebSocket;
  onError?: (error: Error) => void;
};

export type EventSubscription = {
  close(): void;
  cursor(): string;
};

function websocketUrl(baseUrl: string, cursor: string, topics: EventTopic[]): string {
  const root = baseUrl.replace(/\/$/, "");
  const url = new URL(`${root.endsWith("/v1/exchange") ? root : `${root}/v1/exchange`}/stream`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("cursor", cursor);
  if (topics.length) url.searchParams.set("topics", topics.join(","));
  return url.toString();
}

export function subscribeExchangeEvents(
  options: EventSubscriptionOptions,
  onEvent: (event: ExchangeEvent) => void | Promise<void>,
): EventSubscription {
  if (!options.token) throw new Error("token_required");
  let cursor = options.cursor ?? "0";
  if (!/^(0|[1-9][0-9]*)$/.test(cursor)) throw new Error("invalid_resume_cursor");
  let stopped = false;
  let socket: WebSocket | undefined;
  let retryMs = options.reconnectMinMs ?? 250;
  const maxRetryMs = options.reconnectMaxMs ?? 10_000;
  const WebSocketImplementation = options.WebSocket ?? WebSocket;
  const seen = new Map<string, string>();
  let processing = Promise.resolve();
  let handlerFailed = false;

  const connect = () => {
    if (stopped) return;
    handlerFailed = false;
    socket = new WebSocketImplementation(websocketUrl(options.baseUrl, cursor, options.topics ?? []), {
      headers: { authorization: `Bearer ${options.token}` },
      perMessageDeflate: false,
      maxPayload: 64 * 1024,
    });
    socket.on("open", () => { retryMs = options.reconnectMinMs ?? 250; });
    socket.on("message", (raw) => {
      processing = processing.then(async () => {
        if (handlerFailed) return;
        const decoded = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (decoded.type === "error") {
          const error = decoded.error as { message?: string } | undefined;
          throw new Error(error?.message ?? "event_stream_error");
        }
        if (decoded.type !== "event") return;
        const message = decoded as ExchangeEvent;
        const sequence = BigInt(message.sequence);
        if (sequence <= BigInt(cursor) || seen.has(message.eventId.toLowerCase())) return;
        await onEvent(message);
        cursor = message.resumeCursor;
        seen.set(message.eventId.toLowerCase(), cursor);
        while (seen.size > 10_000) seen.delete(seen.keys().next().value!);
      }).catch((error: unknown) => {
        handlerFailed = true;
        options.onError?.(error instanceof Error ? error : new Error("event_handler_failed"));
        socket?.terminate();
      });
    });
    socket.on("error", (error) => options.onError?.(error));
    socket.on("close", () => {
      if (stopped) return;
      const wait = retryMs;
      retryMs = Math.min(maxRetryMs, retryMs * 2);
      setTimeout(connect, wait).unref();
    });
  };
  connect();
  return {
    close() {
      stopped = true;
      socket?.close(1000, "client_closed");
    },
    cursor: () => cursor,
  };
}
