# ADR-0001: ARC capped-beta platform and collateral

- Status: Accepted
- Date: 2026-07-21
- Scope manifest: `config/arena-exchange/beta-scope.v1.json`

## Context

AIR Arena is moving its production-roadmap exchange to an isolated EVM execution stack on ARC. The beta must prove deterministic accounting, custody, recovery, and resolution before it can accept unrestricted access or additional collateral.

## Decision

1. The beta runs only on ARC Testnet, EVM chain ID `5042002`.
2. Application collateral is the official ARC Testnet USDC ERC-20 interface at `0x3600000000000000000000000000000000000000`, accounted in six-decimal base units.
3. ARC's native gas representation is not application collateral and must never enter prediction-market accounting.
4. Exactly one collateral token is allowlisted. Deposits are allowlisted and must be capped per wallet, market, treasury, and globally before the capped beta opens.
5. The beta is testnet-only, carries no real-world value requirement, and is not an unrestricted public-mainnet launch.
6. Collateral cannot earn yield and cannot be lent, rehypothecated, bridged, cross-margined, or reused by protocol liquidity beyond an independently funded and capped vault.
7. Every service must reject a chain ID or collateral address different from this scope before processing financial commands.

## Consequences

- Custody and liabilities reconcile against one ERC-20 address and one integer atom scale.
- Network gas semantics cannot be confused with application USDC accounting.
- A new collateral token, network, or mainnet deployment requires a new ADR, parameter version, threat-model review, and signed release decision.

## Owner sign-off

- Status: APPROVED
- Approved by: AIR Arena project owner
- Approved at: 2026-07-21T09:27:12Z
- Approval reference: conversation:2026-07-21:complete-arc-days-1-3
