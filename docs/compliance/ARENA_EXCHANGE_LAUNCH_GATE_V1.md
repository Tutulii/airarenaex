# AIR Arena ARC launch checkpoint v1

- Status: BLOCKED for public mainnet and unrestricted real-value access
- Canonical gate: `config/arena-exchange/launch-gate.v1.json`
- Threat model: `config/arena-exchange/threat-model.v1.json`
- Authority matrix: `config/arena-exchange/authority-matrix.v1.json`
- Current release class: capped ARC Testnet beta only

This checkpoint is a technical release-control design and is not legal advice. Its technical approval does not grant legal, regulatory, security-audit, custody, operations, or public-mainnet approval.

## Current allowed boundary

Development may continue only on ARC Testnet chain ID `5042002`, using the pinned `ArenaExchange` deployment and official six-decimal ARC Testnet USDC. Access remains allowlisted and capped. Subjective markets, leverage, server-held agent keys, unrestricted public value, and marketing as mainnet production remain disabled.

## Independent approval domains

Public launch requires independently owned approval for:

- legal classification, licensing/registration, eligibility, sanctions, consumer protection, disputes, and tax;
- privacy inventory, lawful basis, retention, processors, transfers, deletion, and breach response;
- independent Solidity security audit, bytecode attestation, P0/P1 closure, SBOM/provenance, and key drills;
- contract roles, USDC transfer accounting, complete sets, reservations, batches, resolution evidence, invalidation, solvency, and caps;
- load, restore, failover, rollback, oracle/RPC/key incidents, reconciliation, on-call, and a 48-hour zero-drift ARC Testnet soak;
- reproducible artifacts, immutable digests, environment attestation, migrations, and a signed go/no-go record.

No owner may self-approve or waive another domain. A status can change from pending only when its evidence references immutable artifacts for the exact deployed scope.

## Hard blockers

All thirteen blockers in the canonical gate are open. They cover jurisdiction, privacy, independent audit and bytecode matching, custody proof, frequent-batch-auction fairness, managed key custody, live operational evidence, artifact provenance, product isolation, resolver evidence binding, environment-backed service keys, pauser/recovery separation, and contract-admin timelock enforcement.

The gate is fail closed: all domains must be approved, all blockers closed, all P0/P1 findings resolved, audited bytecode matched, and the signed go/no-go tied to the approved digest. No configuration flag or emergency override can weaken these rules.

## Required disclosures

Before public value, users must be able to understand market rules and cutoffs, result sources and witnesses, correction and invalidation behavior, fees and caps, collateral and withdrawals, sequencer visibility, contract/stablecoin/RPC risks, eligibility restrictions, and incident/support/dispute channels.
