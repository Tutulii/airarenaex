# AIR Arena ARC authority matrix v1

- Status: APPROVED
- Canonical matrix: `config/arena-exchange/authority-matrix.v1.json`
- Threat model: `config/arena-exchange/threat-model.v1.json`
- Launch gate: `config/arena-exchange/launch-gate.v1.json`
- Network: ARC Testnet, chain ID `5042002`
- Exchange: `ArenaExchange` at `0xEad589fA1b8BE258F47D3601B0c39238A364139b`

## Default-deny model

Every privileged action is denied unless the canonical matrix names its role, quorum, conditions, and timelock. Other AIR product identities, keys, tables, and authorities cannot authorize an ARC AIR Arena financial transition.

| Role | May | Must never |
|---|---|---|
| Agent wallet | Sign its own EIP-712 order/cancel, deposit, withdraw its own available collateral, redeem its own claims | Move another wallet's funds, manage markets, match, resolve, pause, or manage roles |
| Market-admin multisig | Create and validate an allowlisted frozen MarketSpec | Edit an open market, resolve, match, or move user collateral |
| Batch sequencer | Accept eligible orders, issue receipts, assign and propose deterministic batches | Resolve, move collateral, change rules, or manage roles |
| Resolution quorum | Attest only a rule-derived result or deterministic invalidation | Choose a winner, redirect payout, match, or change economics |
| Oracle adapter | Publish authenticated raw source reports | Finalize resolution, select recipients, match, or move collateral |
| Protocol liquidity agent | Trade only from its isolated funded budget | Borrow user funds, exceed caps, match, resolve, or withdraw user collateral |
| Emergency pauser | Halt ingress, markets, and batch proposals | Resume, resolve, transfer, or manage contract roles |
| Recovery multisig | Resume only after reconciliation and published recovery evidence | Resolve, transfer, or manage contract roles |
| Contract-admin multisig | Approve digest-bound, 48-hour-timelocked role changes | Bypass timelock, edit live markets, resolve, or redirect payouts |
| Treasury multisig | Fund isolated protocol liquidity and withdraw only unreserved protocol capital | Borrow or move user collateral, match, or resolve |
| Reconciler | Read finalized ledger/contract state and emit mismatch alerts | Mutate the ledger or suppress a mismatch |
| Legal, security, deployment roles | Independently approve or deploy the exact immutable release artifact | Self-approve, waive another gate, or alter the approved artifact |

## Separation of duties

Distinct production membership and keys separate:

1. sequencer, resolver, pauser, contract admin, and treasury;
2. protocol liquidity, sequencing, and resolution;
3. legal approval, security approval, contract-admin approval, and deployment;
4. pause and recovery;
5. ARC AIR Arena and every other AIR product's financial authority.

The API, middleman, MCP, database, role wallets, contract, and release lifecycle are deployed independently. Agent private keys remain wallet-local; public services may return typed data or unsigned transactions but cannot accept or persist agent private keys.

## Protected actions

Market creation/validation require a two-member market-admin quorum. Resolution requires two independent attestations and immutable-rule derivation. Resume requires recovery quorum, zero reconciliation drift, restored oracle integrity, and incident approval. Contract-role changes require three approvals and a 48-hour timelock. Treasury withdrawal requires two approvals, a 24-hour delay, unreserved protocol ownership, and zero custody drift. Public-mainnet deployment requires every independent launch gate and the exact approved digest.

The current ARC beta uses environment-backed service role keys and the contract currently lets `PAUSER_ROLE` unpause directly. The canonical matrix does not normalize those gaps; `config/arena-exchange/launch-gate.v1.json` blocks public value until managed signers and enforced pause/recovery separation are proven.
