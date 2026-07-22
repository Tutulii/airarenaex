import { hashMessage, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { verifyWalletDigest, verifyWalletMessage } from "../src/signatures.js";

const privateKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

describe("shared EOA and ERC-1271 verifier", () => {
  it("verifies an EOA digest and fails closed on a forged signature", async () => {
    const account = privateKeyToAccount(privateKey);
    const digest = hashMessage("AIR Arena order digest");
    const signature = await account.sign({ hash: digest });
    const client = {
      getBytecode: vi.fn(async () => undefined),
      readContract: vi.fn(async () => "0xffffffff" as Hex),
    };
    await expect(verifyWalletDigest(client, account.address, digest, signature)).resolves.toBe(true);
    await expect(verifyWalletDigest(client, "0x00000000000000000000000000000000000000A1", digest, signature)).resolves.toBe(false);
  });

  it("calls ERC-1271 for contract wallets and requires the exact magic value", async () => {
    const wallet = "0x00000000000000000000000000000000000000A1" as Address;
    const digest = `0x${"11".repeat(32)}` as Hex;
    const signature = "0x1234" as Hex;
    const client = {
      getBytecode: vi.fn(async () => "0x6000" as Hex),
      readContract: vi.fn(async () => "0x1626ba7e" as Hex),
    };
    await expect(verifyWalletDigest(client, wallet, digest, signature)).resolves.toBe(true);
    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: wallet,
      functionName: "isValidSignature",
      args: [digest, signature],
    }));
    client.readContract.mockResolvedValueOnce("0xffffffff" as Hex);
    await expect(verifyWalletDigest(client, wallet, digest, signature)).resolves.toBe(false);
    client.readContract.mockRejectedValueOnce(new Error("RPC unavailable"));
    await expect(verifyWalletDigest(client, wallet, digest, signature)).resolves.toBe(false);
  });

  it("uses the same fail-closed verifier for authentication messages", async () => {
    const account = privateKeyToAccount(privateKey);
    const message = "AIR Arena Arc authentication";
    const signature = await account.signMessage({ message });
    const client = {
      getBytecode: vi.fn(async () => undefined),
      readContract: vi.fn(async () => "0xffffffff" as Hex),
    };
    await expect(verifyWalletMessage(client, account.address, message, signature)).resolves.toBe(true);
  });
});
