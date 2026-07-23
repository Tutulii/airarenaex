# ADR-0002: ARC exchange product and deployment boundary

- Status: Accepted
- Date: 2026-07-21
- Scope manifest: `config/arena-exchange/beta-scope.v1.json`

## Context

AIR Arena's Solana sports product and AIR OTC are separate financial products. The ARC exchange adds priced outcome shares, EIP-712 orders, complete sets, reservations, matching, and EVM settlement. Reusing another product's ledger, signer, contract, database, or MCP surface would make custody and rollback unsafe.

## Decision

1. ARC Testnet execution uses the dedicated non-upgradeable `ArenaExchange` Solidity contract and does not extend a Solana `Deal` or sport-position state machine.
2. ARC Testnet services use a dedicated API deployment, middleman, MCP server, Postgres database, role wallets, and deployment lifecycle.
3. The ARC API may use `/v1` because isolation is enforced by the dedicated ARC hostname and service. It must not mount AIR OTC or Solana financial routes.
4. ARC database objects use the `arc_` namespace. ARC MCP tools use only the `airarena_arc_` prefix.
5. Shared source-data access, logging libraries, and operational platforms are allowed; financial tables, collateral balances, orders, jobs, keys, contracts, and public client contracts are not shared.
6. Agent private keys are wallet-local. API and MCP surfaces may return typed data or unsigned transactions but must never accept, store, log, or derive agent private keys.
7. Migration between Solana balances, AIR OTC balances, and ARC balances is outside the beta.

## Consequences

- Each product can be reconciled, halted, restored, audited, and deployed independently.
- No equal-stake legacy record may be represented as a priced ARC exchange fill.
- A deployment that mixes another product's financial namespace, signer, or contract fails the release gate.

## Owner sign-off

- Status: APPROVED
- Approved by: AIR Arena project owner
- Approved at: 2026-07-23T11:36:44Z
- Approval reference: conversation:2026-07-23:deploy-and-verify-days-15-18
