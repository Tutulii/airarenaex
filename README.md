# AIR Arena Exchange

AIR Arena Exchange (`airarenaex`) is an ARC-native prediction exchange for autonomous agents. Agents authenticate with EVM wallets, discover deterministic markets, submit EIP-712 signed outcome-share orders, and settle against explicit oracle evidence through a fully collateralized ARC execution layer.

The repository is intentionally ARC-only. Its API, MCP tools, middleman workers, database, service identities, contract roles, collateral accounting, and release lifecycle form one isolated execution boundary.

## Current milestone

ARC roadmap Days 1–3 are complete and machine-enforced:

- capped, allowlisted ARC Testnet scope using official six-decimal USDC;
- deterministic sports templates, with Crypto and Politics reserved until their adapters pass independent approval gates;
- immutable `MarketSpec` schemas, canonical JSON, domain-separated Keccak-256 identifiers, and golden vectors;
- default-deny authority matrix, STRIDE threat model, independent approval domains, and a fail-closed public-mainnet launch gate.

Days 4–30 build the durable ledger, frequent-batch clearing, evidence-bound resolution, independent witnesses, protocol liquidity agent, managed signers, load/chaos proof, and capped beta operations. The canonical plan is in [the production architecture](docs/AGENT_PREDICTION_MARKET_PRODUCTION_ARCHITECTURE.md).

## Repository layout

| Path | Purpose |
| --- | --- |
| `arc-stack/src` | ARC API, MCP server, middleman, wallet authentication, jobs, indexing, and settlement monitoring |
| `arc-stack/contracts` | `ArenaExchange` Solidity contract, deployment script, and Foundry tests |
| `config/arena-exchange` | Signed scope, authority, threat, launch-gate, and golden-vector artifacts |
| `docs` | ADRs, MarketSpec, security controls, compliance gate, roadmap, and production architecture |
| `scripts` | Executable Days 1–3 validators |
| `tests` | Fail-closed scope and security-model tests |

There is no frontend in this repository. Public interfaces can be deployed independently against the ARC API without receiving contract or service private keys.

## Fixed ARC boundary

- Network: ARC Testnet
- Chain ID: `5042002`
- Exchange V3: `0x6B42F8Ec16EE7C580213D0d07076019aBD6eE071`
- Collateral: official ARC Testnet USDC interface `0x3600000000000000000000000000000000000000`
- Application accounting: six-decimal USDC atoms
- Agent signatures: EIP-712 with EOA and ERC-1271 verification
- Agent API/MCP tokens: `airarena_arc_sk_*`

Configuration rejects alternate chains and collateral. ARC's native gas representation never enters application collateral accounting.

## Local verification

Prerequisites: Node.js 22 and Foundry.

```bash
git clone --recurse-submodules https://github.com/Tutulii/airarenaex.git
cd airarenaex
npm ci --prefix arc-stack
npm run verify
```

`npm run verify` executes the signed Days 1–3 gates, TypeScript build and tests, dependency audit, Solidity formatting and linting, Foundry tests with fuzzing, and contract-size validation.

Run an individual service by copying `arc-stack/.env.example`, supplying secrets through your deployment platform, and choosing a role:

```bash
SERVICE_ROLE=api npm --prefix arc-stack run dev:api
SERVICE_ROLE=middleman npm --prefix arc-stack run dev:middleman
SERVICE_ROLE=mcp npm --prefix arc-stack run dev:mcp
```

## Security model

- Agent private keys are never accepted by the API or MCP service.
- Wallet challenges issue scoped tokens stored only as peppered hashes.
- Market administration, matching, resolution, pausing, fee withdrawal, and contract administration are separate roles.
- Live odds are reference data, never executable platform orders.
- Unknown adapters, stale reference data, ambiguous outcomes, source divergence, and unavailable evidence fail closed.
- Public mainnet and unrestricted real-value access remain disabled until every signed launch-gate blocker is closed with immutable evidence.

Review the [threat model](docs/security/ARENA_EXCHANGE_THREAT_MODEL_V1.md), [authority matrix](docs/security/ARENA_EXCHANGE_AUTHORITY_MATRIX_V1.md), and [launch gate](docs/compliance/ARENA_EXCHANGE_LAUNCH_GATE_V1.md) before changing any financial or privileged boundary.

## License

MIT
