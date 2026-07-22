import {
  getAddress,
  hashMessage,
  recoverAddress,
  type Address,
  type Hex,
} from "viem";
import type { createArcPublicClient } from "./chain.js";

const ERC1271_MAGIC_VALUE = "0x1626ba7e";
const erc1271Abi = [
  {
    type: "function",
    name: "isValidSignature",
    stateMutability: "view",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "magicValue", type: "bytes4" }],
  },
] as const;

export type SignaturePublicClient = Pick<
  ReturnType<typeof createArcPublicClient>,
  "getBytecode" | "readContract"
>;

/** Fail-closed EOA/ERC-1271 digest verification shared by auth, orders and cancellations. */
export async function verifyWalletDigest(
  client: SignaturePublicClient,
  signerInput: Address | string,
  digest: Hex,
  signature: Hex,
): Promise<boolean> {
  const signer = getAddress(signerInput);
  let bytecode: Hex | undefined;
  try {
    bytecode = await client.getBytecode({ address: signer });
  } catch {
    return false;
  }

  if (!bytecode || bytecode === "0x") {
    try {
      return getAddress(await recoverAddress({ hash: digest, signature })) === signer;
    } catch {
      return false;
    }
  }

  try {
    const result = await client.readContract({
      address: signer,
      abi: erc1271Abi,
      functionName: "isValidSignature",
      args: [digest, signature],
    });
    return result.toLowerCase() === ERC1271_MAGIC_VALUE;
  } catch {
    return false;
  }
}

export function walletMessageDigest(message: string): Hex {
  return hashMessage(message);
}

export async function verifyWalletMessage(
  client: SignaturePublicClient,
  signer: Address | string,
  message: string,
  signature: Hex,
): Promise<boolean> {
  return verifyWalletDigest(client, signer, walletMessageDigest(message), signature);
}
