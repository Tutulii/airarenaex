import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  acceptanceDomain,
  acceptanceTypes,
  hashOrderAcceptance,
  type OrderAcceptance,
} from "./chain.js";
import type { ArcConfig } from "./config.js";
import type { Database, DatabaseClient } from "./db.js";
import { appendExchangeEvent } from "./exchange-events.js";

export type OrderEventType =
  | "LEGACY_IMPORTED"
  | "ORDER_ACCEPTED"
  | "ORDER_CHAIN_ACTIVE"
  | "ORDER_CANCEL_ACCEPTED"
  | "ORDER_CANCELLED"
  | "ORDER_BATCH_ASSIGNED"
  | "ORDER_BATCH_RELEASED"
  | "ORDER_BATCH_SEALED"
  | "ORDER_FILLED"
  | "ORDER_REJECTED";

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

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function payloadHash(payload: unknown): Hex {
  return keccak256(stringToHex(canonicalJson(payload)));
}

export function orderRequestHash(orderHash: Hex, signature: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }],
      [orderHash, keccak256(signature)],
    ),
  );
}

export async function claimNonce(
  db: Database | DatabaseClient,
  makerInput: string,
  namespace: "ORDER" | "CANCEL",
  nonce: bigint,
  digest: Hex,
): Promise<"created" | "existing"> {
  const maker = getAddress(makerInput);
  const inserted = await db.query(
    `INSERT INTO arc_nonce_claims(maker, namespace, nonce, digest, state)
     VALUES ($1,$2,$3,$4,'ACCEPTED') ON CONFLICT DO NOTHING`,
    [maker, namespace, nonce.toString(), digest],
  );
  if ((inserted.rowCount ?? 0) === 1) return "created";
  const existing = await db.query<{ digest: string }>(
    `SELECT digest FROM arc_nonce_claims WHERE maker = $1 AND namespace = $2 AND nonce = $3`,
    [maker, namespace, nonce.toString()],
  );
  if (existing.rows[0]?.digest.toLowerCase() !== digest.toLowerCase()) throw new Error("nonce_digest_conflict");
  return "existing";
}

export async function appendOrderEvent(
  db: Database | DatabaseClient,
  orderHash: Hex,
  eventType: OrderEventType,
  payload: unknown,
  occurredAt?: Date,
): Promise<{ sequence: bigint; occurredAt: Date }> {
  const canonicalPayload = canonicalize(payload);
  const hashedPayload = payloadHash(canonicalPayload);
  const eventKey = payloadHash({ eventType, orderHash: orderHash.toLowerCase(), payloadHash: hashedPayload });
  const result = await db.query<{ sequence: string; occurred_at: Date }>(
    `INSERT INTO arc_order_events(order_hash, event_type, payload, event_key, payload_hash, occurred_at)
     VALUES ($1,$2,$3::jsonb,$4,$5,COALESCE($6,clock_timestamp()))
     ON CONFLICT (event_key) DO NOTHING
     RETURNING sequence::text, occurred_at`,
    [orderHash, eventType, JSON.stringify(canonicalPayload), eventKey, hashedPayload, occurredAt ?? null],
  );
  const existing = result.rows[0]
    ? result
    : await db.query<{ sequence: string; occurred_at: Date }>(
      "SELECT sequence::text, occurred_at FROM arc_order_events WHERE event_key = $1",
      [eventKey],
    );
  const row = existing.rows[0];
  if (!row) throw new Error("order_event_insert_failed");
  await appendExchangeEvent(db, {
    topic: "ORDER",
    entityId: orderHash,
    eventType,
    payload: canonicalPayload,
    eventKey,
    payloadHash: hashedPayload,
    sourceRoot: hashedPayload,
    occurredAt: row.occurred_at,
  });
  return { sequence: BigInt(row.sequence), occurredAt: row.occurred_at };
}

type ReceiptRow = {
  order_hash: Hex;
  maker: string;
  sequence: string;
  accepted_at: Date;
  request_hash: Hex;
  receipt_digest: Hex;
  signer_key_id: string;
  signer_address: string;
  signature: Hex;
};

function mapReceipt(row: ReceiptRow): AcceptanceReceipt {
  return {
    orderHash: row.order_hash,
    maker: getAddress(row.maker),
    sequence: row.sequence,
    acceptedAt: row.accepted_at.toISOString(),
    acceptedAtUnix: Math.floor(row.accepted_at.getTime() / 1000).toString(),
    requestHash: row.request_hash,
    receiptDigest: row.receipt_digest,
    signerKeyId: row.signer_key_id,
    signerAddress: getAddress(row.signer_address),
    signature: row.signature,
  };
}

export async function readAcceptanceReceipt(
  db: Database | DatabaseClient,
  orderHash: Hex,
): Promise<AcceptanceReceipt | null> {
  const result = await db.query<ReceiptRow>(
    `SELECT order_hash, maker, sequence::text, accepted_at, request_hash, receipt_digest,
            signer_key_id, signer_address, signature
       FROM arc_order_receipts WHERE order_hash = $1`,
    [orderHash],
  );
  return result.rows[0] ? mapReceipt(result.rows[0]) : null;
}

export async function createAcceptanceReceipt(
  db: DatabaseClient,
  config: Pick<ArcConfig, "exchangeAddress" | "receiptSignerPrivateKey" | "receiptSignerKeyId">,
  input: { orderHash: Hex; maker: Address; sequence: bigint; acceptedAt: Date; requestHash: Hex },
): Promise<AcceptanceReceipt> {
  if (!config.exchangeAddress || !config.receiptSignerPrivateKey) throw new Error("receipt_signer_unavailable");
  if (input.sequence > 18_446_744_073_709_551_615n) throw new Error("receipt_sequence_overflow");
  const account = privateKeyToAccount(config.receiptSignerPrivateKey);
  const acceptance: OrderAcceptance = {
    orderHash: input.orderHash,
    maker: input.maker,
    sequence: input.sequence,
    acceptedAt: BigInt(Math.floor(input.acceptedAt.getTime() / 1000)),
    requestHash: input.requestHash,
  };
  const signature = await account.signTypedData({
    domain: acceptanceDomain(config.exchangeAddress),
    types: acceptanceTypes,
    primaryType: "OrderAcceptance",
    message: acceptance,
  });
  const digest = hashOrderAcceptance(config.exchangeAddress, acceptance);
  const inserted = await db.query<ReceiptRow>(
    `INSERT INTO arc_order_receipts(
       order_hash, sequence, maker, accepted_at, request_hash, receipt_digest,
       signer_key_id, signer_address, signature
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING order_hash, maker, sequence::text, accepted_at, request_hash, receipt_digest,
               signer_key_id, signer_address, signature`,
    [
      input.orderHash,
      input.sequence.toString(),
      input.maker,
      input.acceptedAt,
      input.requestHash,
      digest,
      config.receiptSignerKeyId,
      account.address,
      signature,
    ],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("receipt_insert_failed");
  return mapReceipt(row);
}
