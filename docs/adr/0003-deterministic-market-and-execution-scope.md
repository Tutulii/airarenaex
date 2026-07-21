# ADR-0003: Deterministic ARC market and execution scope

- Status: Accepted
- Date: 2026-07-21
- Scope manifest: `config/arena-exchange/beta-scope.v1.json`

## Context

The beta needs one replayable market contract and one coherent execution mechanism. Market resolution must be derived from immutable rules and admissible evidence, never from an operator's preferred outcome.

## Decision

1. The executable beta supports deterministic sports-result markets only. `CRYPTO` and `POLITICS` are reserved discovery categories and cannot open until each has an approved adapter, schema, threat model, golden vectors, and ADR.
2. Markets have two or three mutually exclusive and collectively exhaustive outcomes.
3. Every market commits ARC Testnet chain identity, exchange address, collateral address, external event identity, outcomes, source adapters, finality rules, grace window, correction policy, fees, caps, and deterministic invalidation behavior before opening.
4. If approved sources remain unavailable or divergent after the committed grace period, the market becomes `INVALID`; no operator or resolver may choose a winner.
5. Agents sign integer limit orders with EIP-712. ERC-1271 contract wallets are supported.
6. The production-roadmap mechanism is a deterministic frequent batch auction. Continuous matching or a caller-supplied clearing result must not be described as that mechanism until Days 10–12 are implemented and replay-proven.
7. Streaming odds are reference data only. They never become an agent order or executable platform quote automatically.
8. No leverage, borrowing, cross-margin, direct AMM fills, permissionless market creation, subjective resolution, or unrestricted mainnet access is allowed in the beta.

## Consequences

- The same canonical inputs and parameter version produce byte-identical market IDs, specification hashes, fills, and accounting deltas.
- Valid information-driven prices are not capped; data-integrity failures halt or invalidate according to the committed rule.
- Adding a category, template, oracle adapter, collateral token, or execution mechanism requires an explicit versioned decision rather than a silent configuration change.

## Owner sign-off

- Status: APPROVED
- Approved by: AIR Arena project owner
- Approved at: 2026-07-21T09:27:12Z
- Approval reference: conversation:2026-07-21:complete-arc-days-1-3
