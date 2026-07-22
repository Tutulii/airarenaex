import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getAddress, isAddress, type Address } from "viem";
import type { ArcConfig } from "./config.js";
import type { Database } from "./db.js";
import { verifyWalletMessage, type SignaturePublicClient } from "./signatures.js";

export type AuthenticatedAgent = { wallet: Address; scopes: string[]; tokenId: string };

export function buildChallengeMessage(wallet: Address, nonce: string, expiresAt: Date): string {
  return [
    "AIR Arena Arc authentication",
    `Wallet: ${wallet}`,
    "Network: Arc Testnet",
    "Chain ID: 5042002",
    `Nonce: ${nonce}`,
    `Expiration Time: ${expiresAt.toISOString()}`,
    "Purpose: Issue a scoped AIR Arena Arc MCP/API token. This does not authorize a transaction.",
  ].join("\n");
}
export async function createChallenge(
  db: Database,
  config: Pick<ArcConfig, "authChallengeTtlSeconds">,
  walletInput: string,
): Promise<{ wallet: Address; nonce: string; message: string; expiresAt: string }> {
  if (!isAddress(walletInput)) throw new Error("invalid_wallet");
  const wallet = getAddress(walletInput);
  const nonce = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + config.authChallengeTtlSeconds * 1000);
  const message = buildChallengeMessage(wallet, nonce, expiresAt);
  await db.query(
    `INSERT INTO arc_auth_challenges(nonce, wallet, message, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [nonce, wallet, message, expiresAt],
  );
  return { wallet, nonce, message, expiresAt: expiresAt.toISOString() };
}

function tokenHash(token: string, pepper: string): string {
  return createHash("sha256").update(pepper).update("\0").update(token).digest("hex");
}

export async function exchangeChallengeForToken(
  db: Database,
  config: Pick<ArcConfig, "authTokenPepper">,
  input: { wallet: string; nonce: string; signature: `0x${string}` },
  publicClient: SignaturePublicClient,
): Promise<{ token: string; wallet: Address; scopes: string[] }> {
  if (!config.authTokenPepper) throw new Error("auth_token_issuer_unavailable");
  if (!isAddress(input.wallet)) throw new Error("invalid_wallet");
  const wallet = getAddress(input.wallet);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ wallet: string; message: string; expires_at: Date; consumed_at: Date | null }>(
      `SELECT wallet, message, expires_at, consumed_at
       FROM arc_auth_challenges WHERE nonce = $1 FOR UPDATE`,
      [input.nonce],
    );
    const challenge = result.rows[0];
    if (
      !challenge || challenge.consumed_at || challenge.expires_at.getTime() <= Date.now()
      || getAddress(challenge.wallet) !== wallet
    ) {
      throw new Error("challenge_invalid_or_expired");
    }
    const valid = await verifyWalletMessage(publicClient, wallet, challenge.message, input.signature);
    if (!valid) throw new Error("invalid_signature");

    const token = `airarena_arc_sk_${randomBytes(32).toString("base64url")}`;
    const scopes = ["markets:read", "orders:read", "orders:write"];
    await client.query("UPDATE arc_auth_challenges SET consumed_at = now() WHERE nonce = $1", [input.nonce]);
    await client.query(
      `INSERT INTO arc_api_tokens(wallet, token_hash, scopes) VALUES ($1, $2, $3::text[])`,
      [wallet, tokenHash(token, config.authTokenPepper), scopes],
    );
    await client.query("COMMIT");
    return { token, wallet, scopes };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function authenticateBearer(
  db: Database,
  config: Pick<ArcConfig, "authTokenPepper">,
  authorization: string | undefined,
  requiredScope?: string,
): Promise<AuthenticatedAgent> {
  if (!config.authTokenPepper) throw new Error("auth_unavailable");
  const match = authorization?.match(/^Bearer\s+(airarena_arc_sk_[A-Za-z0-9_-]+)$/);
  if (!match?.[1]) throw new Error("missing_or_invalid_bearer_token");
  const hash = tokenHash(match[1], config.authTokenPepper);
  const result = await db.query<{ id: string; wallet: string; scopes: string[] }>(
    `UPDATE arc_api_tokens SET last_used_at = now()
     WHERE token_hash = $1 AND revoked_at IS NULL
     RETURNING id, wallet, scopes`,
    [hash],
  );
  const row = result.rows[0];
  if (!row) throw new Error("invalid_bearer_token");
  if (requiredScope && !row.scopes.includes(requiredScope)) throw new Error("insufficient_scope");
  return { wallet: getAddress(row.wallet), scopes: row.scopes, tokenId: row.id };
}

export function operatorAuthorized(expected: string | undefined, supplied: string | undefined): boolean {
  if (!expected || !supplied) return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}
