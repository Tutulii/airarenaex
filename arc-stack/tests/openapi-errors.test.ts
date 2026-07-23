import { describe, expect, it } from "vitest";
import { ERROR_CATALOG, normalizeError } from "../src/errors.js";
import { buildExchangeOpenApi } from "../src/openapi.js";

describe("versioned API contract", () => {
  it("publishes every required read/write, replay, and stream route", () => {
    const spec = buildExchangeOpenApi(Object.keys(ERROR_CATALOG) as Array<keyof typeof ERROR_CATALOG>);
    expect(spec.openapi).toBe("3.1.0");
    for (const path of [
      "/markets", "/markets/{marketId}/orderbook", "/orders/prepare", "/orders/submit",
      "/orders/cancellations/prepare", "/orders/cancellations/submit", "/batches/{batchId}/bundle",
      "/events", "/stream", "/errors",
    ]) expect(spec.paths).toHaveProperty(path);
    expect(spec.paths["/orders/submit"].post).toMatchObject({
      security: [{ bearerAuth: [] }],
      requestBody: { required: true },
      parameters: [{ name: "Idempotency-Key", required: true }],
    });
    expect(spec.paths["/operator/markets"].post).toMatchObject({
      security: [{ operatorToken: [] }],
      requestBody: { required: true },
    });
    expect(spec.components.schemas.CreateMarketRequest.required).toEqual(["fixtureId", "outcomeCount", "closeTime"]);
  });

  it("has unique operation IDs and only resolvable local schema references", () => {
    const spec = buildExchangeOpenApi(Object.keys(ERROR_CATALOG) as Array<keyof typeof ERROR_CATALOG>);
    const serialized = JSON.stringify(spec);
    const refs = [...serialized.matchAll(/#\/components\/schemas\/([A-Za-z0-9_]+)/g)].map((match) => match[1]!);
    for (const reference of refs) expect(spec.components.schemas).toHaveProperty(reference);

    const operationIds = Object.values(spec.paths).flatMap((path) =>
      Object.values(path)
        .filter((value): value is { operationId: string } =>
          typeof value === "object" && value !== null && "operationId" in value,
        )
        .map((operation) => operation.operationId),
    );
    expect(new Set(operationIds).size).toBe(operationIds.length);
  });

  it("uses stable codes and never leaks unknown internal errors", () => {
    expect(normalizeError(new Error("market_closed"))).toMatchObject({ code: "market_closed" });
    expect(normalizeError(Object.assign(new Error("too large"), { statusCode: 413 })))
      .toMatchObject({ code: "payload_too_large" });
    expect(normalizeError(Object.assign(new Error("rate limit"), { statusCode: 429 })))
      .toMatchObject({ code: "rate_limited" });
    expect(normalizeError(new Error("txline_source_http_502")))
      .toMatchObject({ code: "txline_source_unavailable" });
    expect(normalizeError(new Error("database_password=secret"))).toMatchObject({ code: "internal_error" });
  });
});
