# AIR Arena ARC exchange threat model v1

- Status: APPROVED
- Scope: capped ARC Testnet beta and the fail-closed public-mainnet boundary
- Canonical model: `config/arena-exchange/threat-model.v1.json`
- Authority matrix: `config/arena-exchange/authority-matrix.v1.json`
- Launch gate: `config/arena-exchange/launch-gate.v1.json`

## Boundary

The model covers wallet-signed EIP-712/ ERC-1271 orders, the isolated ARC API, middleman and MCP services, the `arc_` database namespace, deterministic batch/replay data, source adapters, resolution verification, ARC RPC, `ArenaExchange`, official ARC Testnet USDC custody, protocol liquidity, privileged roles, and release controls.

Other AIR products may share operational platforms, but they do not share ARC financial tables, balances, ledgers, keys, contract roles, API contracts, MCP tools, or SDK contracts. Subjective markets, cross-chain bridges, leverage, lending, yield, and cross-margin are outside this scope and fail closed.

## Security invariants

1. Only a wallet may authorize its own order, cancel, deposit, withdrawal, or claim.
2. Every accepted financial command is durable, idempotent, integer-only, and reconcilable.
3. The sequencer cannot resolve a market, move collateral, or change market rules.
4. Resolution is derived from the frozen MarketSpec and authenticated independent evidence; divergence becomes `INVALID`.
5. The emergency pauser can halt risk but cannot resume, resolve, transfer, or manage contract roles.
6. Protocol liquidity is separately funded and cannot borrow user collateral.
7. ARC and other AIR financial authorities are isolated.
8. Missing, stale, divergent, unaudited, or unreconciled evidence halts rather than guesses.
9. Public mainnet and unrestricted real-value access remain blocked until every independent approval and blocker closes with immutable evidence.

## Threat coverage

The canonical model contains twenty asset-centric STRIDE abuse cases and twenty-four controls. Together they cover spoofed or replayed wallet messages, market-rule mutation, sequencer censorship, batch tampering, reservation races, resolver capture, oracle faults, pause abuse, contract-admin compromise, liquidity-vault abuse, key exfiltration, sensitive order disclosure, denial of service, lost acknowledgements, supply-chain compromise, RPC/reorg faults, product-boundary contamination, and launch bypass.

The Day 15-18 implementation closes two previously recorded contract gaps: resolution now requires authenticated, MarketSpec-bound evidence, and the emergency pauser cannot unpause or invoke any other authority. The remaining public-value release blockers are the later-roadmap controls for timelocked administration and managed non-exportable service signers. Day 3 remains complete because the model preserves each attack path, control, evidence owner, response, and fail-closed launch effect.

## Trust assumptions

The model records external dependencies on ARC consensus/EVM execution, the pinned exchange bytecode, official USDC behavior, independent result sources, plaintext visibility of the capped-beta sequencer, managed key custody, durable storage, product isolation, and independent legal/compliance review. If any assumption fails, the defined behavior is halt, revoke, reconcile, wait, or deterministically invalidate—never operator-selected settlement.

## Change control

A new category, collateral token, contract, resolver model, key-custody model, execution mechanism, bridge, leverage feature, or release class requires a versioned threat-model update and reapproval. The machine-readable JSON is authoritative; this document is its reviewer-facing summary.
