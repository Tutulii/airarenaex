# AIR Arena ARC MarketSpec v1

**Status:** Frozen for the capped ARC Testnet beta
**Implementation:** `arc-stack/src/market-spec.ts`
**Golden vector:** `config/arena-exchange/vectors/arc-market-spec-1x2.v1.json`
**Scope:** `config/arena-exchange/beta-scope.v1.json`

## Contract boundary

MarketSpec v1 is the immutable market-definition contract for the isolated ARC exchange. It binds every market to ARC Testnet chain ID `5042002`, `ArenaExchange` at `0xEad589fA1b8BE258F47D3601B0c39238A364139b`, and official ARC Testnet USDC at `0x3600000000000000000000000000000000000000` with six application decimals.

The strict Zod schemas are executable. Unknown properties, alternate chains, alternate exchanges, alternate collateral, unsafe policy combinations, and operator-selected outcomes are rejected. A market is not eligible to open until its finalized `marketId` and `specHash` reproduce from the stored draft.

## Supported beta templates

| Template | Outcomes | Settlement basis |
|---|---|---|
| `sports.result.1x2.v1` | `home`, `draw`, `away` | Regulation time |
| `sports.result.to-advance.v1` | `home`, `away` | Team advancing under the committed competition rule |

`SPORTS` is the only executable category. `CRYPTO` and `POLITICS` remain reserved until separate adapter, schema, threat-model, golden-vector, and ADR approval gates pass.

Outcome indices are immutable. Inputs normalize by index before hashing. Final status and action tokens are unique, disjoint, and lexicographically sorted.

## Numeric and time representation

- Collateral, payout, quantity, reserve, cap, and minimum-fee amounts are canonical unsigned `uint128` decimal strings.
- The market nonce is a canonical unsigned `uint256` decimal string.
- Leading zeroes, negatives, floating-point amounts, and overflow are rejected.
- Prices use integer parts per million with scale `1_000_000`.
- Policy counts, basis points, and millisecond values are safe JSON integers.
- Timestamps use exact UTC second precision: `YYYY-MM-DDTHH:mm:ssZ`.
- Value-moving implementations must use checked integer arithmetic; no floating point enters accounting or settlement.

## Fees, invalidation, and caps

Trade fees use integer ceiling:

```text
fee_atoms = max(minimum_fee_atoms, ceil(notional_atoms * trade_fee_bps / 10_000))
```

A zero-basis-point policy must also declare a zero minimum fee. Invalid markets pay each outcome token equally:

```text
payout_per_outcome_atoms = floor(payout_atoms / outcome_count)
remainder_atoms = payout_atoms % outcome_count
```

The disclosed remainder goes to `PROTOCOL_DUST_VAULT`. Cap validation enforces:

```text
max_order <= wallet_open_order_reserve <= wallet_collateral <= market_collateral <= global_collateral
treasury_market_budget <= market_collateral
minimum_order <= max_order
complete_set_payout <= wallet_collateral
```

## Resolution and reference-data invariants

- The adapter, fixture, field mapping, sources, finality tokens, grace period, correction policy, and invalidation rules are committed before opening.
- Primary and witness source identifiers must differ; the oracle policy requires two independent sources.
- Divergence or unavailability after the grace period resolves to `INVALID`; no resolver may choose a preferred outcome.
- Integrity failure halts processing.
- Live odds are `REFERENCE_ONLY`: they never become an agent order or executable platform quote.
- Stale reference data suspends matching under the committed policy.
- Settlement observations require the committed ARC confirmation threshold.

## Canonical serialization and hashing

AIR Arena canonical JSON v1:

1. Parses through the strict schema and normalizes EVM addresses to checksum form.
2. Sorts outcomes by index and final status/action tokens lexicographically.
3. Sorts every object key lexicographically while preserving normalized array order.
4. Encodes UTF-8 JSON without whitespace.
5. Accepts only strings, booleans, null, arrays, plain objects, and safe non-negative or signed integer JSON policy values; it rejects negative zero, floats, `undefined`, `bigint`, dates, class instances, and non-finite numbers.

The identity commits schema, chain, exchange, collateral, nonce, category, template, fixture, scheduled start, settlement basis, parameter version, and indexed outcomes.

```text
market_id = Keccak256(
  UTF8("air-arena/arc/market-id/v1\0") || UTF8(canonical_identity_json)
)
```

The specification payload is the normalized draft plus `marketId`, excluding `specHash` to avoid a circular preimage.

```text
spec_hash = Keccak256(
  UTF8("air-arena/arc/market-spec/v1\0") || UTF8(canonical_spec_payload_json)
)
```

Both outputs are EVM `bytes32` hex values. Changing a field, canonicalization rule, domain separator, template meaning, or rounding rule requires a new version and new golden vectors. Existing hashes must never be reinterpreted.

## Verification

```bash
npm run roadmap:day2:gate
npm --prefix arc-stack run market-spec:vector
```

The committed vector locks canonical bytes and both hashes. Tests cover positive interoperability, permutation stability, address normalization, tampering, overflows, invalid times, invalid templates, unsafe fees/caps/batches, non-independent sources, ambiguous finality, and reference-odds execution attempts.
