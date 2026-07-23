import { once } from "node:events";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { subscribeExchangeEvents } from "../src/stream.js";
import type { ExchangeEvent } from "../src/types.js";

const servers: WebSocketServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function event(sequence: number): ExchangeEvent {
  const hex = sequence.toString(16).padStart(64, "0");
  return {
    type: "event",
    sequence: sequence.toString(),
    resumeCursor: sequence.toString(),
    eventId: `0x${hex}`,
    topic: "ORDER",
    entityId: `order-${sequence}`,
    eventType: "ORDER_ACCEPTED",
    payload: { sequence },
    payloadHash: `0x${hex}`,
    sourceRoot: `0x${hex}`,
    occurredAt: "2026-07-22T00:00:00.000Z",
  };
}

describe("resumable exchange stream", () => {
  it("reconnects from the committed cursor without gaps or duplicates", async () => {
    const server = new WebSocketServer({ port: 0 });
    servers.push(server);
    await once(server, "listening");
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("websocket_test_address_missing");
    let connections = 0;
    server.on("connection", (socket, request) => {
      expect(request.headers.authorization).toBe("Bearer test-token");
      const cursor = Number(new URL(request.url ?? "/", "http://localhost").searchParams.get("cursor") ?? "0");
      connections += 1;
      if (connections === 1) {
        expect(cursor).toBe(0);
        socket.send(JSON.stringify(event(1)));
        socket.send(JSON.stringify(event(2)));
        socket.close();
      } else {
        expect(cursor).toBe(2);
        socket.send(JSON.stringify(event(3)));
      }
    });

    const received: string[] = [];
    let resolve!: () => void;
    const complete = new Promise<void>((done) => { resolve = done; });
    const subscription = subscribeExchangeEvents({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "test-token",
      reconnectMinMs: 10,
      reconnectMaxMs: 20,
    }, (message) => {
      received.push(message.sequence);
      if (message.sequence === "3") resolve();
    });
    await Promise.race([
      complete,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("stream_test_timeout")), 3_000)),
    ]);
    subscription.close();
    expect(received).toEqual(["1", "2", "3"]);
    expect(subscription.cursor()).toBe("3");
    expect(connections).toBe(2);
  });

  it("does not advance the cursor when the consumer fails", async () => {
    const server = new WebSocketServer({ port: 0 });
    servers.push(server);
    await once(server, "listening");
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("websocket_test_address_missing");
    const cursors: string[] = [];
    server.on("connection", (socket, request) => {
      cursors.push(new URL(request.url ?? "/", "http://localhost").searchParams.get("cursor") ?? "0");
      socket.send(JSON.stringify(event(1)));
    });
    let attempts = 0;
    let successful = 0;
    let resolve!: () => void;
    const complete = new Promise<void>((done) => { resolve = done; });
    const subscription = subscribeExchangeEvents({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "test-token",
      reconnectMinMs: 10,
      reconnectMaxMs: 20,
    }, () => {
      attempts += 1;
      if (attempts === 1) throw new Error("consumer_failed");
      successful += 1;
      resolve();
    });
    await Promise.race([
      complete,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("stream_retry_timeout")), 3_000)),
    ]);
    subscription.close();
    expect(cursors.slice(0, 2)).toEqual(["0", "0"]);
    expect(successful).toBe(1);
    expect(subscription.cursor()).toBe("1");
  });
});
