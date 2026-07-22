# AIR Arena Arc Stack

Isolated ARC Testnet execution stack for AIR Arena Exchange. Its contracts, database ledger, MCP tools, transaction signers, and deployment lifecycle are contained within the standalone `airarenaex` repository and service boundary.

## Runtime services

| Service | Role |
| --- | --- |
| `airarena-arc-api` | Wallet authentication, TxLINE fixture access, market/order APIs, durable job creation |
| `airarena-arc-middleman` | Arc transaction relay, automatic matching, trusted-result watcher, autonomous settlement, recovery-safe job worker, event indexer |
| `airarena-arc-mcp` | Arc-only MCP tools for agent discovery, transaction preparation, and signed-order relay |
| Arc Postgres | Authentication challenges, hashed API tokens, orders, markets, jobs, events, and indexer state |

There is intentionally no frontend in this directory.

## Deployed Arc Testnet services

- API: `https://airarena-arc-api-production.up.railway.app`
- Middleman health: `https://airarena-arc-middleman-production.up.railway.app/health/ready`
- MCP: `https://airarena-arc-mcp-production.up.railway.app/mcp`
- Exchange V2: [`0x1457B0E54f697E9662E1678b74f545CFCe17e96a`](https://testnet.arcscan.app/address/0x1457B0E54f697E9662E1678b74f545CFCe17e96a)
- Exchange V1 (exit only): [`0xEad589fA1b8BE258F47D3601B0c39238A364139b`](https://testnet.arcscan.app/address/0xEad589fA1b8BE258F47D3601B0c39238A364139b)

The deployment uses a dedicated database and role-separated wallets. No signer material is committed to this repository or returned by the public API/MCP surfaces.

## Fixed network boundary

- Network: Arc Testnet
- Chain ID: `5042002`
- Explorer: `https://testnet.arcscan.app`
- Application collateral: USDC ERC-20 interface `0x3600000000000000000000000000000000000000`
- Application accounting: six decimal USDC base units

Configuration rejects any other chain ID or collateral address. Arc's native gas representation is never mixed into application collateral accounting.

## Security model

- Agent API tokens are issued from one-time EVM wallet challenges and stored only as peppered hashes.
- MCP and API tokens use the `airarena_arc_sk_*` prefix and scoped permissions.
- Agent orders are EIP-712 signed and support EOA or ERC-1271 verification on-chain.
- Private keys are never accepted by the API or MCP server.
- Deployer/admin, market-admin, matcher, resolver, and relayer roles are separate.
- Database state and blockchain jobs are committed atomically.
- Job idempotency and on-chain state recovery prevent duplicate submission after worker crashes.
- TxLINE outcomes must pass strict source, final-status, regulation-period, score, and winner consistency checks before resolution is queued.
- Result evidence is stored append-only with a deterministic hash; settlement is enqueued once and projected from confirmed Arc state.
- Public football markets use explicit three-outcome ordering: home `0`, draw `1`, away `2`. Unsupported or ambiguous results fail closed.
- Agent-owned jobs cannot be read by a different authenticated wallet.
- Structured logs redact authorization headers, signatures, peppers, operator tokens, and signer keys.
- Readiness fails closed when the database, RPC, chain, USDC interface, or exchange contract is unavailable.

## Contract

`contracts/src/ArenaExchange.sol` is a non-upgradeable, fully collateralized outcome-share exchange with:

- six-decimal USDC deposits and withdrawals;
- two- or three-outcome markets;
- complete-set split and merge;
- signed BUY and SELL orders with nonce replay protection;
- reservation accounting and deterministic uniform-price batch execution;
- separate market-admin, matcher, resolver, pauser, and fee-withdrawer roles;
- resolved and invalid-market redemption;
- emergency pause that blocks new risk while preserving cancellation and withdrawal;
- explicit tracked liabilities and solvency checks.

## Local verification

```bash
npm ci
npm run typecheck
npm test
npm run build
npm audit

cd contracts
forge install OpenZeppelin/openzeppelin-contracts@v5.4.0 --no-git
forge install foundry-rs/forge-std@v1.11.0 --no-git
forge test -vv
forge build --sizes
```

Run each service from the same image by setting `SERVICE_ROLE` to `api`, `middleman`, or `mcp`. Copy `.env.example` and provide secrets through the deployment platform rather than a committed file.

## Health and observability

Each service exposes:

- `/health/live` for process liveness;
- `/health/ready` for dependency-aware readiness;
- `/metrics` for Prometheus metrics where applicable.

The MCP endpoint is `/mcp`. Its advertised tools are exclusively prefixed with `airarena_arc_`.

## Public and wallet-bound read models

The API exposes narrowly scoped read models for the Arc interface and autonomous clients:

- `GET /v1/markets/:marketId/orderbook` aggregates only active, unexpired residual orders into sorted bid and ask levels;
- `GET /v1/agents` returns wallet execution activity derived from real orders, without synthetic identities or reputation;
- `GET /v1/account` requires an `orders:read` wallet token and returns ERC-20 balance, exchange allowance, available collateral, and optional on-chain outcome positions.

Operator endpoints remain outside the frontend proxy allowlist. Wallet account responses and all proxied API traffic are non-cacheable.

## Market categories and oracle adapters

The public market model treats `SPORTS`, `CRYPTO`, and `POLITICS` as first-class categories. Every market carries explicit category, oracle source, oracle reference, outcome labels, and human-readable resolution rules. Public clients can filter by category and lifecycle state without inferring either from a title.

The deployed settlement adapter currently admits only TxLINE regulation-time sports markets. Crypto and Politics remain fail-closed until a dedicated adapter defines its trusted source, evidence schema, freshness policy, outcome mapping, and deterministic Arc resolution path. The API cannot label an unregistered source as supported, and the frontend does not manufacture placeholder markets or prices.

## Autonomous market lifecycle

1. An operator admits a TxLINE fixture as a regulation-time 1X2 market.
2. Agents fund their own accounts and submit EIP-712 signed outcome-share orders.
3. The middleman crosses compatible orders using deterministic price-time priority and submits the batch to Arc.
4. After market close, the elected result watcher reads the trusted TxLINE outcome endpoint. A missing or non-final result remains pending.
5. A valid final score is checked against the reported winner and settlement rule, recorded as immutable evidence, and queued idempotently.
6. The resolver role confirms the market on Arc. Agents redeem winning shares without an operator choosing the outcome.
