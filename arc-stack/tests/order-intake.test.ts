import { recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { acceptanceDomain, acceptanceTypes } from "../src/chain.js";
import type { DatabaseClient } from "../src/db.js";
import {
  appendOrderEvent,
  canonicalJson,
  claimNonce,
  createAcceptanceReceipt,
  orderRequestHash,
} from "../src/order-intake.js";

const maker = "0x00000000000000000000000000000000000000a1";
const orderHash = `0x${"11".repeat(32)}` as Hex;

describe("durable order intake primitives", () => {
  it("canonicalizes payload keys and binds the request hash to both digest and signature", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 } })).toBe('{"a":{"b":3,"y":2},"z":1}');
    expect(orderRequestHash(orderHash, "0x1234")).toBe(orderRequestHash(orderHash, "0x1234"));
    expect(orderRequestHash(orderHash, "0x1234")).not.toBe(orderRequestHash(orderHash, "0x1235"));
  });

  it("makes nonce claims idempotent for one digest and rejects a conflicting digest", async () => {
    const createdDb = {
      query: vi.fn().mockResolvedValueOnce({ rowCount: 1, rows: [] }),
    } as unknown as DatabaseClient;
    await expect(claimNonce(createdDb, maker, "ORDER", 7n, orderHash)).resolves.toBe("created");

    const existingDb = {
      query: vi.fn()
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ digest: orderHash }] }),
    } as unknown as DatabaseClient;
    await expect(claimNonce(existingDb, maker, "ORDER", 7n, orderHash)).resolves.toBe("existing");

    const conflictingDb = {
      query: vi.fn()
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ digest: `0x${"22".repeat(32)}` }] }),
    } as unknown as DatabaseClient;
    await expect(claimNonce(conflictingDb, maker, "ORDER", 7n, orderHash)).rejects.toThrow("nonce_digest_conflict");
  });

  it("returns the original sequence when an append-only event is replayed", async () => {
    const occurredAt = new Date("2026-07-22T00:00:00.000Z");
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ sequence: "42", occurred_at: occurredAt }] })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ sequence: "108" }] }),
    } as unknown as DatabaseClient;
    await expect(appendOrderEvent(db, orderHash, "ORDER_ACCEPTED", { maker })).resolves.toEqual({
      sequence: 42n,
      occurredAt,
    });
  });

  it("creates a verifiable EIP-712 acceptance receipt from the committed sequence", async () => {
    const signerKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    const signer = privateKeyToAccount(signerKey);
    const exchange = "0x00000000000000000000000000000000000000b2";
    const acceptedAt = new Date("2026-07-22T00:00:00.000Z");
    const requestHash = `0x${"33".repeat(32)}` as Hex;
    const query = vi.fn(async (_sql: string, values?: unknown[]) => ({
      rowCount: 1,
      rows: [{
        order_hash: values![0],
        sequence: String(values![1]),
        maker: values![2],
        accepted_at: values![3],
        request_hash: values![4],
        receipt_digest: values![5],
        signer_key_id: values![6],
        signer_address: values![7],
        signature: values![8],
      }],
    }));
    const receipt = await createAcceptanceReceipt({ query } as unknown as DatabaseClient, {
      exchangeAddress: exchange,
      receiptSignerPrivateKey: signerKey,
      receiptSignerKeyId: "receipt-key-v1",
    }, {
      orderHash,
      maker,
      sequence: 42n,
      acceptedAt,
      requestHash,
    });
    expect(receipt.signerAddress).toBe(signer.address);
    expect(receipt.sequence).toBe("42");
    await expect(recoverTypedDataAddress({
      domain: acceptanceDomain(exchange),
      types: acceptanceTypes,
      primaryType: "OrderAcceptance",
      message: {
        orderHash,
        maker,
        sequence: 42n,
        acceptedAt: BigInt(acceptedAt.getTime() / 1000),
        requestHash,
      },
      signature: receipt.signature,
    })).resolves.toBe(signer.address);
  });
});
