# AIR Arena ARC roadmap — Days 1–3 evidence

**Milestone status:** COMPLETE
**Scope:** Days 1–3 of `docs/AGENT_PREDICTION_MARKET_PRODUCTION_ARCHITECTURE.md` for the isolated ARC deployment
**Approval reference:** `conversation:2026-07-21:complete-arc-days-1-3`

This evidence record distinguishes completion of the design-and-control milestone from implementation of Days 4–30. Open public-mainnet blockers are the required output of Day 3 and remain fail closed.

## Day 1 — beta scope and architecture decisions

| Exit requirement | Evidence |
|---|---|
| ARC Testnet and official USDC frozen | `config/arena-exchange/beta-scope.v1.json` |
| Deterministic sports only | Active category `SPORTS`; `CRYPTO` and `POLITICS` reserved and non-executable |
| No leverage, borrowing, cross-margin, yield, rehypothecation, AMM fill, permissionless creation, or unrestricted public mainnet | Eighteen explicit exclusions enforced by validator |
| Isolated product boundary | Dedicated contract, API, middleman, MCP, database namespace, keys, and deployment lifecycle |
| Signed decisions | `docs/adr/0001-*`, `0002-*`, and `0003-*` |
| Negative enforcement | `tests/arena-arc-day1-scope.test.mjs` |

Gate: `npm run roadmap:day1:gate`

## Day 2 — canonical ARC MarketSpec

| Exit requirement | Evidence |
|---|---|
| Strict market/outcome/resolution/invalidation schema | `arc-stack/src/market-spec.ts` |
| Fees, caps, batch, oracle, reference-data, and confirmation parameters | Strict schemas plus cross-field semantic invariants |
| ARC identity binding | Chain ID `5042002`, scoped `ArenaExchange`, official ARC Testnet USDC |
| Deterministic serialization | Sorted, normalized canonical JSON with integer-only value movement |
| EVM hashes | Domain-separated Keccak-256 `bytes32` market ID and spec hash |
| Golden interoperability vector | `config/arena-exchange/vectors/arc-market-spec-1x2.v1.json` |
| Adversarial verification | `arc-stack/tests/market-spec.test.ts` |
| Reviewer contract | `docs/contracts/ARENA_EXCHANGE_MARKET_SPEC_V1.md` |

Gate: `npm run roadmap:day2:gate`

## Day 3 — threat, authority, and launch controls

| Exit requirement | Evidence |
|---|---|
| Default-deny authority matrix | 14 roles, 11 protected actions, separation of duties, key policy |
| Threat model | 20 asset-centric STRIDE abuse cases, 24 controls, 8 trust assumptions, 9 trust boundaries |
| Legal/compliance checkpoint | 6 independent approval domains; no self-approval or emergency override |
| Explicit public-value launch gate | 13 open hard blockers; public mainnet and unrestricted real-value access disabled |
| Current-code truth | Gate reads `ArenaExchange.sol`, ARC config, and middleman source to verify resolver, pauser, admin, and environment-key boundaries |
| Negative enforcement | `tests/arena-day3-security-model.test.mjs` |

Machine-readable sources:

- `config/arena-exchange/authority-matrix.v1.json`
- `config/arena-exchange/threat-model.v1.json`
- `config/arena-exchange/launch-gate.v1.json`

Gate: `npm run roadmap:day3:gate`

## Completion rule

Days 1–3 are complete only when the signed scope gate, golden-vector gate, threat/authority/launch gate, negative tests, ARC TypeScript regression, Foundry regression, dependency audit, and repository consistency checks all pass twice from the same working tree. Any schema, hash, role, blocker, source-boundary, or approval mutation fails closed.
