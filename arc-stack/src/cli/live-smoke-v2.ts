import pg from "pg";
import {
  encodeFunctionData,
  erc20Abi,
  getAddress,
  isAddress,
  verifyTypedData,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  acceptanceDomain,
  acceptanceTypes,
  arenaExchangeAbi,
  arcTestnet,
  createArcPublicClient,
  createArcWalletClient,
  hashOrderAcceptance,
  orderDomain,
  orderTypes,
  cancelTypes,
  type ArcOrder,
  type OrderAcceptance,
} from "../chain.js";
import { ARC_CHAIN_ID, ARC_USDC_ADDRESS } from "../config.js";

const { Pool } = pg;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing_environment:${name}`);
  return value;
}

function privateKey(name: string): Hex {
  const value = required(name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`invalid_private_key:${name}`);
  return value as Hex;
}

function address(name: string): Address {
  const value = required(name);
  if (!isAddress(value)) throw new Error(`invalid_address:${name}`);
  return getAddress(value);
}

const rpcUrl = required("ARC_RPC_URL");
const apiUrl = required("ARC_API_URL").replace(/\/$/, "");
const exchangeAddress = address("ARC_EXCHANGE_ADDRESS");
const erc1271Wallet = address("ERC1271_WALLET_ADDRESS");
const operatorToken = required("ARC_OPERATOR_TOKEN");
const buyerKey = privateKey("EOA_BUYER_PRIVATE_KEY");
const sellerKey = privateKey("EOA_SELLER_PRIVATE_KEY");
const buyer = privateKeyToAccount(buyerKey);
const seller = privateKeyToAccount(sellerKey);
const deployerKey = privateKey("ARC_DEPLOYER_PRIVATE_KEY");
const deployer = privateKeyToAccount(deployerKey);
const databaseUrl = required("DATABASE_URL");
const publicClient = createArcPublicClient({ rpcUrl });
const buyerClient = createArcWalletClient({ rpcUrl }, buyerKey);
const sellerClient = createArcWalletClient({ rpcUrl }, sellerKey);
const deployerClient = createArcWalletClient({ rpcUrl }, deployerKey);
const db = new Pool({ connectionString: databaseUrl, max: 4, application_name: "airarena-v2-live-smoke" });

type JsonObject = Record<string, any>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion_failed:${message}`);
}

async function request(path: string, init: RequestInit = {}, token?: string): Promise<JsonObject> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`${apiUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(20_000) });
  const body = await response.json() as JsonObject;
  if (!response.ok || body.success === false) {
    throw new Error(`api_request_failed:${path}:${response.status}:${String(body.error ?? "unknown")}`);
  }
  return body;
}

async function waitFor<T>(label: string, action: () => Promise<T | null>, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await action();
    if (value !== null) return value;
    if (Date.now() >= deadline) throw new Error(`timeout:${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

async function waitTransaction(hash: Hex): Promise<Hex> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 45_000 });
  assert(receipt.status === "success", `transaction_reverted:${hash}`);
  return hash;
}

async function authenticate(wallet: Address, signer: typeof buyer): Promise<string> {
  const challenge = (await request("/v1/auth/challenge", {
    method: "POST",
    body: JSON.stringify({ wallet }),
  })).data;
  const signature = await signer.signMessage({ message: challenge.message as string });
  const issued = (await request("/v1/auth/token", {
    method: "POST",
    body: JSON.stringify({ wallet, nonce: challenge.nonce, signature }),
  })).data;
  assert(issued.wallet === wallet, "authenticated_wallet_mismatch");
  return issued.token as string;
}

async function waitJob(token: string, id: string): Promise<JsonObject> {
  return waitFor(`job:${id}`, async () => {
    const job = (await request(`/v1/jobs/${id}`, {}, token)).data as JsonObject | null;
    if (!job || ["PENDING", "RUNNING", "FAILED"].includes(job.status)) return null;
    if (job.status !== "SUCCEEDED") throw new Error(`job_failed:${id}:${job.status}:${String(job.last_error ?? "")}`);
    return job;
  });
}

async function waitOrder(token: string, orderHash: Hex, expected: string): Promise<JsonObject> {
  return waitFor(`order:${orderHash}:${expected}`, async () => {
    const orders = (await request("/v1/orders?limit=100", {}, token)).data as JsonObject[];
    const order = orders.find((candidate) => candidate.order_hash.toLowerCase() === orderHash.toLowerCase());
    return order?.status === expected ? order : null;
  });
}

async function verifyReceipt(receipt: JsonObject): Promise<void> {
  const message: OrderAcceptance = {
    orderHash: receipt.orderHash as Hex,
    maker: getAddress(receipt.maker),
    sequence: BigInt(receipt.sequence),
    acceptedAt: BigInt(receipt.acceptedAtUnix),
    requestHash: receipt.requestHash as Hex,
  };
  const digest = hashOrderAcceptance(exchangeAddress, message);
  assert(digest.toLowerCase() === String(receipt.receiptDigest).toLowerCase(), "receipt_digest_mismatch");
  const valid = await verifyTypedData({
    address: getAddress(receipt.signerAddress),
    domain: acceptanceDomain(exchangeAddress),
    types: acceptanceTypes,
    primaryType: "OrderAcceptance",
    message,
    signature: receipt.signature as Hex,
  });
  assert(valid, "receipt_signature_invalid");
}

type PreparedOrder = { orderHash: Hex; order: ArcOrder; receipt: JsonObject; job: JsonObject };

async function submitOrder(input: {
  token: string;
  maker: Address;
  signer: typeof buyer;
  marketId: Hex;
  outcome: number;
  side: "BUY" | "SELL";
  pricePpm: bigint;
  quantity: bigint;
  nonce: bigint;
  label: string;
}): Promise<PreparedOrder> {
  const expiry = BigInt(Math.floor(Date.now() / 1_000) + 600);
  const prepared = (await request("/v1/orders/prepare", {
    method: "POST",
    body: JSON.stringify({
      marketId: input.marketId,
      outcome: input.outcome,
      side: input.side,
      pricePpm: input.pricePpm.toString(),
      quantity: input.quantity.toString(),
      expiry: expiry.toString(),
      nonce: input.nonce.toString(),
      clientOrderId: input.label,
    }),
  }, input.token)).data;
  const order: ArcOrder = {
    maker: getAddress(prepared.order.maker),
    marketId: prepared.order.marketId as Hex,
    outcome: Number(prepared.order.outcome),
    isBuy: Boolean(prepared.order.isBuy),
    pricePpm: BigInt(prepared.order.pricePpm),
    quantity: BigInt(prepared.order.quantity),
    expiry: BigInt(prepared.order.expiry),
    nonce: BigInt(prepared.order.nonce),
    clientOrderId: prepared.order.clientOrderId as Hex,
  };
  assert(order.maker === input.maker, `${input.label}:maker_mismatch`);
  const signature = await input.signer.signTypedData({
    domain: orderDomain(exchangeAddress),
    types: orderTypes,
    primaryType: "Order",
    message: order,
  });
  const submitted = (await request("/v1/orders/submit", {
    method: "POST",
    headers: { "idempotency-key": `smoke-submit-${input.label}-${Date.now()}` },
    body: JSON.stringify({ order: prepared.order, signature }),
  }, input.token)).data;
  await verifyReceipt(submitted.receipt);
  await waitJob(input.token, submitted.job.id);
  await waitOrder(input.token, submitted.orderHash as Hex, "ACTIVE");
  return { orderHash: submitted.orderHash as Hex, order, receipt: submitted.receipt, job: submitted.job };
}

async function cancelBySignature(input: {
  token: string;
  maker: Address;
  signer: typeof buyer;
  orderHash: Hex;
  nonce: bigint;
  label: string;
}): Promise<Hex> {
  const deadline = BigInt(Math.floor(Date.now() / 1_000) + 300);
  const prepared = (await request("/v1/orders/cancellations/prepare", {
    method: "POST",
    body: JSON.stringify({ orderHash: input.orderHash, nonce: input.nonce.toString(), deadline: deadline.toString() }),
  }, input.token)).data;
  const cancellation = {
    maker: getAddress(prepared.cancellation.maker),
    orderHash: prepared.cancellation.orderHash as Hex,
    nonce: BigInt(prepared.cancellation.nonce),
    deadline: BigInt(prepared.cancellation.deadline),
  };
  assert(cancellation.maker === input.maker, `${input.label}:cancel_maker_mismatch`);
  const signature = await input.signer.signTypedData({
    domain: orderDomain(exchangeAddress),
    types: cancelTypes,
    primaryType: "Cancel",
    message: cancellation,
  });
  const submitted = (await request("/v1/orders/cancellations/submit", {
    method: "POST",
    headers: { "idempotency-key": `smoke-cancel-${input.label}-${Date.now()}` },
    body: JSON.stringify({ cancellation: prepared.cancellation, signature }),
  }, input.token)).data;
  const job = await waitJob(input.token, submitted.job.id);
  await waitOrder(input.token, input.orderHash, "CANCELLED");
  return job.tx_hash as Hex;
}

async function ensureEoaDeposit(
  account: typeof buyer,
  walletClient: ReturnType<typeof createArcWalletClient>,
  minimumAvailable: bigint,
): Promise<Hex[]> {
  const transactions: Hex[] = [];
  const available = await publicClient.readContract({
    address: exchangeAddress,
    abi: arenaExchangeAbi,
    functionName: "availableCollateral",
    args: [account.address],
  });
  if (available >= minimumAvailable) return transactions;
  const amount = minimumAvailable - available;
  const approve = await walletClient.writeContract({
    account,
    chain: arcTestnet,
    address: ARC_USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "approve",
    args: [exchangeAddress, amount],
  });
  transactions.push(await waitTransaction(approve));
  const deposit = await walletClient.writeContract({
    account,
    chain: arcTestnet,
    address: exchangeAddress,
    abi: arenaExchangeAbi,
    functionName: "deposit",
    args: [amount],
  });
  transactions.push(await waitTransaction(deposit));
  return transactions;
}

const walletAbi = [
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [{ name: "target", type: "address" }, { name: "data", type: "bytes" }],
    outputs: [{ name: "", type: "bytes" }],
  },
] as const;

async function executeWallet(target: Address, data: Hex): Promise<Hex> {
  const hash = await buyerClient.writeContract({
    account: buyer,
    chain: arcTestnet,
    address: erc1271Wallet,
    abi: walletAbi,
    functionName: "execute",
    args: [target, data],
  });
  return waitTransaction(hash);
}

async function ensure1271Deposit(minimumAvailable: bigint): Promise<Hex[]> {
  const transactions: Hex[] = [];
  const available = await publicClient.readContract({
    address: exchangeAddress,
    abi: arenaExchangeAbi,
    functionName: "availableCollateral",
    args: [erc1271Wallet],
  });
  if (available >= minimumAvailable) return transactions;
  const amount = minimumAvailable - available;
  const applicationBalance = await publicClient.readContract({
    address: ARC_USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [erc1271Wallet],
  });
  if (applicationBalance < amount) {
    const funding = await deployerClient.writeContract({
      account: deployer,
      chain: arcTestnet,
      address: ARC_USDC_ADDRESS,
      abi: erc20Abi,
      functionName: "transfer",
      args: [erc1271Wallet, amount - applicationBalance],
    });
    transactions.push(await waitTransaction(funding));
  }
  const approveData = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [exchangeAddress, amount],
  });
  transactions.push(await executeWallet(ARC_USDC_ADDRESS, approveData));
  const depositData = encodeFunctionData({ abi: arenaExchangeAbi, functionName: "deposit", args: [amount] });
  transactions.push(await executeWallet(exchangeAddress, depositData));
  return transactions;
}

async function createMarket(): Promise<{ marketId: Hex; closeTime: string; createTxHash: Hex }> {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const fixtureId = `airarena-v2-smoke-${suffix}`;
  const closeSeconds = Number(process.env.SMOKE_CLOSE_SECONDS ?? "180");
  const closeTime = new Date(Date.now() + closeSeconds * 1_000).toISOString();
  const created = (await request("/v1/operator/markets", {
    method: "POST",
    headers: {
      "x-airarena-operator-token": operatorToken,
      "idempotency-key": `smoke-market-${suffix}`,
    },
    body: JSON.stringify({
      fixtureId,
      outcomeCount: 3,
      closeTime,
      category: "SPORTS",
      oracleSource: "TXLINE",
      displayTitle: "AIR Arena V2 production smoke",
      outcomeLabels: ["Alpha", "Draw", "Beta"],
      resolutionRules: "Controlled Arc Testnet production deployment smoke",
    }),
  })).data;
  const row = await waitFor(`market:${created.marketId}:open`, async () => {
    const result = await db.query<{ status: string; create_tx_hash: Hex | null }>(
      "SELECT status, create_tx_hash FROM arc_markets WHERE market_id = $1",
      [created.marketId],
    );
    return result.rows[0]?.status === "OPEN" && result.rows[0].create_tx_hash ? result.rows[0] : null;
  });
  return { marketId: created.marketId as Hex, closeTime, createTxHash: row.create_tx_hash! };
}

async function coreSmoke(): Promise<void> {
  assert(await publicClient.getChainId() === ARC_CHAIN_ID, "wrong_chain");
  assert(await publicClient.getBytecode({ address: exchangeAddress }) !== undefined, "exchange_has_no_code");
  assert(await publicClient.getBytecode({ address: erc1271Wallet }) !== undefined, "erc1271_wallet_has_no_code");

  const fundingTransactions = [
    ...await ensureEoaDeposit(buyer, buyerClient, 1_000_000n),
    ...await ensureEoaDeposit(seller, sellerClient, 2_000_000n),
    ...await ensure1271Deposit(1_000_000n),
  ];
  const market = await createMarket();
  const sellerPosition = await publicClient.readContract({
    address: exchangeAddress,
    abi: arenaExchangeAbi,
    functionName: "positions",
    args: [market.marketId, 1, seller.address],
  });
  if (sellerPosition < 1_000_000n) {
    const split = await sellerClient.writeContract({
      account: seller,
      chain: arcTestnet,
      address: exchangeAddress,
      abi: arenaExchangeAbi,
      functionName: "splitCompleteSet",
      args: [market.marketId, 1_000_000n],
    });
    fundingTransactions.push(await waitTransaction(split));
  }

  const buyerToken = await authenticate(buyer.address, buyer);
  const sellerToken = await authenticate(seller.address, seller);
  const contractToken = await authenticate(erc1271Wallet, buyer);
  const nonceBase = BigInt(Date.now()) * 100n;

  const eoaCancelOrder = await submitOrder({
    token: buyerToken, maker: buyer.address, signer: buyer, marketId: market.marketId,
    outcome: 0, side: "BUY", pricePpm: 300_000n, quantity: 10_000n,
    nonce: nonceBase + 1n, label: `eoa-cancel-${nonceBase}`,
  });
  const eoaCancellationTx = await cancelBySignature({
    token: buyerToken, maker: buyer.address, signer: buyer, orderHash: eoaCancelOrder.orderHash,
    nonce: nonceBase + 1n, label: `eoa-cancel-${nonceBase}`,
  });

  const contractCancelOrder = await submitOrder({
    token: contractToken, maker: erc1271Wallet, signer: buyer, marketId: market.marketId,
    outcome: 0, side: "BUY", pricePpm: 310_000n, quantity: 10_000n,
    nonce: nonceBase + 2n, label: `erc1271-cancel-${nonceBase}`,
  });
  const erc1271CancellationTx = await cancelBySignature({
    token: contractToken, maker: erc1271Wallet, signer: buyer, orderHash: contractCancelOrder.orderHash,
    nonce: nonceBase + 2n, label: `erc1271-cancel-${nonceBase}`,
  });

  const auctionOrders = await Promise.all([
    submitOrder({
      token: buyerToken, maker: buyer.address, signer: buyer, marketId: market.marketId,
      outcome: 1, side: "BUY", pricePpm: 600_000n, quantity: 100_000n,
      nonce: nonceBase + 3n, label: `auction-buy-600-${nonceBase}`,
    }),
    submitOrder({
      token: contractToken, maker: erc1271Wallet, signer: buyer, marketId: market.marketId,
      outcome: 1, side: "BUY", pricePpm: 550_000n, quantity: 100_000n,
      nonce: nonceBase + 4n, label: `auction-buy-550-${nonceBase}`,
    }),
    submitOrder({
      token: sellerToken, maker: seller.address, signer: seller, marketId: market.marketId,
      outcome: 1, side: "SELL", pricePpm: 400_000n, quantity: 100_000n,
      nonce: nonceBase + 5n, label: `auction-sell-400-${nonceBase}`,
    }),
    submitOrder({
      token: sellerToken, maker: seller.address, signer: seller, marketId: market.marketId,
      outcome: 1, side: "SELL", pricePpm: 500_000n, quantity: 100_000n,
      nonce: nonceBase + 6n, label: `auction-sell-500-${nonceBase}`,
    }),
  ]);

  const batch = await waitFor("uniform-price-batch", async () => {
    const result = await db.query<{
      batch_id: Hex;
      status: string;
      clearing_price_ppm: string;
      executable_quantity: string;
      execution_job_id: string;
      tx_hash: Hex | null;
      fill_count: string;
    }>(
      `SELECT b.batch_id, b.status, b.clearing_price_ppm::text, b.executable_quantity::text,
              b.execution_job_id, j.tx_hash, count(f.fill_index)::text AS fill_count
         FROM arc_batches b
         LEFT JOIN arc_jobs j ON j.id = b.execution_job_id
         LEFT JOIN arc_batch_fills f ON f.batch_id = b.batch_id
        WHERE b.market_id = $1 AND b.outcome = 1 AND b.status = 'EXECUTED'
        GROUP BY b.batch_id, j.tx_hash
        ORDER BY b.executed_at DESC LIMIT 1`,
      [market.marketId],
    );
    const row = result.rows[0];
    return row?.tx_hash ? row : null;
  }, 120_000);
  assert(batch.clearing_price_ppm === "525000", "unexpected_uniform_clearing_price");
  assert(batch.executable_quantity === "200000", "unexpected_uniform_executable_quantity");
  assert(Number(batch.fill_count) >= 2, "auction_not_multi_order");
  for (const order of auctionOrders) {
    const stored = await publicClient.readContract({
      address: exchangeAddress,
      abi: arenaExchangeAbi,
      functionName: "getOrder",
      args: [order.orderHash],
    });
    assert(Number(stored.status) === 2 && stored.filledQuantity === 100_000n, `auction_order_not_filled:${order.orderHash}`);
  }
  assert(await publicClient.readContract({
    address: exchangeAddress,
    abi: arenaExchangeAbi,
    functionName: "isSolvent",
  }), "exchange_insolvent_after_auction");

  const state = {
    exchangeAddress,
    erc1271Wallet,
    market,
    auth: { buyer: buyer.address, seller: seller.address },
    fundingTransactions,
    eoa: { orderHash: eoaCancelOrder.orderHash, cancellationTx: eoaCancellationTx },
    erc1271: { orderHash: contractCancelOrder.orderHash, cancellationTx: erc1271CancellationTx },
    auction: {
      batchId: batch.batch_id,
      executionJobId: batch.execution_job_id,
      transactionHash: batch.tx_hash,
      clearingPricePpm: batch.clearing_price_ppm,
      executableQuantity: batch.executable_quantity,
      fillCount: batch.fill_count,
      orderHashes: auctionOrders.map((order) => order.orderHash),
    },
    receiptSigner: auctionOrders[0]!.receipt.signerAddress,
    recordedAt: new Date().toISOString(),
  };
  await db.query(
    `INSERT INTO arc_runtime_state(key, value, updated_at) VALUES ('v2_live_smoke', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(state)],
  );
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
}

async function directCancellationPrepare(): Promise<void> {
  assert(await publicClient.getChainId() === ARC_CHAIN_ID, "wrong_chain");
  assert(await publicClient.getBytecode({ address: exchangeAddress }) !== undefined, "exchange_has_no_code");

  await ensureEoaDeposit(buyer, buyerClient, 250_000n);
  await ensureEoaDeposit(seller, sellerClient, 500_000n);
  const market = await createMarket();
  const sellerPosition = await publicClient.readContract({
    address: exchangeAddress,
    abi: arenaExchangeAbi,
    functionName: "positions",
    args: [market.marketId, 2, seller.address],
  });
  if (sellerPosition < 100_000n) {
    const split = await sellerClient.writeContract({
      account: seller,
      chain: arcTestnet,
      address: exchangeAddress,
      abi: arenaExchangeAbi,
      functionName: "splitCompleteSet",
      args: [market.marketId, 100_000n],
    });
    await waitTransaction(split);
  }

  const buyerToken = await authenticate(buyer.address, buyer);
  const sellerToken = await authenticate(seller.address, seller);
  const nonceBase = BigInt(Date.now()) * 100n;
  const buy = await submitOrder({
    token: buyerToken,
    maker: buyer.address,
    signer: buyer,
    marketId: market.marketId,
    outcome: 2,
    side: "BUY",
    pricePpm: 600_000n,
    quantity: 100_000n,
    nonce: nonceBase + 1n,
    label: `sealed-cancel-buy-${nonceBase}`,
  });
  const sell = await submitOrder({
    token: sellerToken,
    maker: seller.address,
    signer: seller,
    marketId: market.marketId,
    outcome: 2,
    side: "SELL",
    pricePpm: 400_000n,
    quantity: 100_000n,
    nonce: nonceBase + 2n,
    label: `sealed-cancel-sell-${nonceBase}`,
  });
  const assignment = await waitFor("sealed-cancel-batch-assignment", async () => {
    const result = await db.query<{
      batch_id: Hex;
      batch_end: string;
      assigned: string;
    }>(
      `SELECT b.batch_id, b.batch_end::text, count(*)::text AS assigned
         FROM arc_batches b
         JOIN arc_orders o ON o.assigned_batch_id = b.batch_id
        WHERE b.market_id = $1 AND b.outcome = 2 AND b.status = 'OPEN'
          AND o.order_hash = ANY($2::text[])
        GROUP BY b.batch_id, b.batch_end
       HAVING count(*) = 2
        ORDER BY b.batch_end DESC LIMIT 1`,
      [market.marketId, [buy.orderHash, sell.orderHash]],
    );
    return result.rows[0] ?? null;
  });
  const state = {
    market,
    batchId: assignment.batch_id,
    batchEnd: assignment.batch_end,
    buyOrderHash: buy.orderHash,
    sellOrderHash: sell.orderHash,
    buyer: buyer.address,
    seller: seller.address,
    preparedAt: new Date().toISOString(),
  };
  await db.query(
    `INSERT INTO arc_runtime_state(key, value, updated_at) VALUES ('v2_direct_cancel_smoke', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(state)],
  );
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
}

async function directCancellationOnChain(): Promise<void> {
  const result = await db.query<{ value: JsonObject }>(
    "SELECT value FROM arc_runtime_state WHERE key = 'v2_direct_cancel_smoke'",
  );
  const state = result.rows[0]?.value;
  assert(state, "direct_cancel_state_missing");
  const orderHash = state.buyOrderHash as Hex;
  const storedBefore = await publicClient.readContract({
    address: exchangeAddress,
    abi: arenaExchangeAbi,
    functionName: "getOrder",
    args: [orderHash],
  });
  assert(Number(storedBefore.status) === 1, "direct_cancel_order_not_active");
  const hash = await buyerClient.writeContract({
    account: buyer,
    chain: arcTestnet,
    address: exchangeAddress,
    abi: arenaExchangeAbi,
    functionName: "cancelOrder",
    args: [orderHash],
  });
  await waitTransaction(hash);
  const storedAfter = await publicClient.readContract({
    address: exchangeAddress,
    abi: arenaExchangeAbi,
    functionName: "getOrder",
    args: [orderHash],
  });
  assert(Number(storedAfter.status) === 3, "direct_cancel_not_confirmed");
  const updated = { ...state, directCancellationTx: hash, cancelledAt: new Date().toISOString() };
  await db.query(
    "UPDATE arc_runtime_state SET value = $1::jsonb, updated_at = now() WHERE key = 'v2_direct_cancel_smoke'",
    [JSON.stringify(updated)],
  );
  process.stdout.write(`${JSON.stringify(updated, null, 2)}\n`);
}

async function settlementAndWithdrawal(): Promise<void> {
  const result = await db.query<{ value: JsonObject }>(
    "SELECT value FROM arc_runtime_state WHERE key = 'v2_live_smoke'",
  );
  const state = result.rows[0]?.value;
  assert(state, "live_smoke_state_missing");
  const marketId = state.market.marketId as Hex;
  const market = await publicClient.readContract({
    address: exchangeAddress,
    abi: arenaExchangeAbi,
    functionName: "markets",
    args: [marketId],
  });
  assert(Number(market[3]) === 2 && Number(market[4]) === 1, "market_not_resolved_to_expected_outcome");

  const settlementTransactions: Record<string, Hex[]> = { buyer: [], seller: [], erc1271: [] };
  for (const entry of [
    { name: "buyer", account: buyer, client: buyerClient },
    { name: "seller", account: seller, client: sellerClient },
  ] as const) {
    const position = await publicClient.readContract({
      address: exchangeAddress,
      abi: arenaExchangeAbi,
      functionName: "positions",
      args: [marketId, 1, entry.account.address],
    });
    if (position > 0n) {
      const hash = await entry.client.writeContract({
        account: entry.account,
        chain: arcTestnet,
        address: exchangeAddress,
        abi: arenaExchangeAbi,
        functionName: "redeem",
        args: [marketId],
      });
      settlementTransactions[entry.name]!.push(await waitTransaction(hash));
    }
  }
  const contractPosition = await publicClient.readContract({
    address: exchangeAddress,
    abi: arenaExchangeAbi,
    functionName: "positions",
    args: [marketId, 1, erc1271Wallet],
  });
  if (contractPosition > 0n) {
    settlementTransactions.erc1271!.push(await executeWallet(exchangeAddress, encodeFunctionData({
      abi: arenaExchangeAbi,
      functionName: "redeem",
      args: [marketId],
    })));
  }

  const availableBeforeWithdraw: Record<string, string> = {};
  for (const entry of [
    { name: "buyer", account: buyer, client: buyerClient },
    { name: "seller", account: seller, client: sellerClient },
  ] as const) {
    const available = await publicClient.readContract({
      address: exchangeAddress,
      abi: arenaExchangeAbi,
      functionName: "availableCollateral",
      args: [entry.account.address],
    });
    availableBeforeWithdraw[entry.name] = available.toString();
    if (available > 0n) {
      const hash = await entry.client.writeContract({
        account: entry.account,
        chain: arcTestnet,
        address: exchangeAddress,
        abi: arenaExchangeAbi,
        functionName: "withdraw",
        args: [available, entry.account.address],
      });
      settlementTransactions[entry.name]!.push(await waitTransaction(hash));
    }
  }
  const contractAvailable = await publicClient.readContract({
    address: exchangeAddress,
    abi: arenaExchangeAbi,
    functionName: "availableCollateral",
    args: [erc1271Wallet],
  });
  availableBeforeWithdraw.erc1271 = contractAvailable.toString();
  if (contractAvailable > 0n) {
    settlementTransactions.erc1271!.push(await executeWallet(exchangeAddress, encodeFunctionData({
      abi: arenaExchangeAbi,
      functionName: "withdraw",
      args: [contractAvailable, erc1271Wallet],
    })));
  }

  const [solvent, liabilities, contractBalance] = await Promise.all([
    publicClient.readContract({ address: exchangeAddress, abi: arenaExchangeAbi, functionName: "isSolvent" }),
    publicClient.readContract({ address: exchangeAddress, abi: arenaExchangeAbi, functionName: "totalLiabilities" }),
    publicClient.readContract({ address: ARC_USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [exchangeAddress] }),
  ]);
  assert(solvent, "exchange_insolvent_after_withdrawals");
  assert(contractBalance >= liabilities, "collateral_balance_below_liabilities");
  const finalAvailable = await Promise.all([buyer.address, seller.address, erc1271Wallet].map((wallet) =>
    publicClient.readContract({
      address: exchangeAddress,
      abi: arenaExchangeAbi,
      functionName: "availableCollateral",
      args: [wallet],
    })));
  assert(finalAvailable.every((amount) => amount === 0n), "withdrawal_left_available_collateral");

  const settlementState = {
    marketId,
    winningOutcome: 1,
    settlementTransactions,
    availableBeforeWithdraw,
    finalAvailable: finalAvailable.map((amount) => amount.toString()),
    totalLiabilities: liabilities.toString(),
    contractCollateralBalance: contractBalance.toString(),
    solvent,
    completedAt: new Date().toISOString(),
  };
  await db.query(
    `INSERT INTO arc_runtime_state(key, value, updated_at) VALUES ('v2_settlement_smoke', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(settlementState)],
  );
  process.stdout.write(`${JSON.stringify(settlementState, null, 2)}\n`);
}

async function main(): Promise<void> {
  const mode = process.env.SMOKE_MODE ?? "core";
  if (mode === "core") return coreSmoke();
  if (mode === "direct-cancel-prepare") return directCancellationPrepare();
  if (mode === "direct-cancel-onchain") return directCancellationOnChain();
  if (mode === "settlement-withdraw") return settlementAndWithdrawal();
  throw new Error(`unsupported_smoke_mode:${mode}`);
}

try {
  await main();
} finally {
  await db.end();
}
