# AIR Arena Exchange Days 15–18 Verification

Date: 2026-07-23

Network: Arc Testnet (`5042002`)

Frozen exchange: `0x6B42F8Ec16EE7C580213D0d07076019aBD6eE071`

## Pass 1 — Day 15

| REQUIREMENT | STATUS | EVIDENCE | GAPS |
|---|---|---|---|
| ABI and storage layout frozen | DONE | `bash arc-stack/contracts/scripts/check-frozen-arena-exchange.sh` → `ArenaExchange frozen ABI: MATCH`; `ArenaExchange frozen storage layout: MATCH` | none |
| Market identity and EIP-712 domain | DONE | `forge test --root arc-stack/contracts --match-contract ArenaExchangeDay15Test` → 5 passed, including `testFrozenChainCollateralDomainAndOrderFormat` and unchanged EOA/ERC-1271 order/cancel compatibility | none |
| Five-role separation | DONE | Same command → `testCrossRoleCallsRevertAndPauseCannotMoveOrResolveFunds` and `testRoleMembershipCannotOverlap` passed | none |
| Chain and collateral constants | DONE | Same command → wrong-chain and wrong-decimals deployments reverted; `arc-chain-role-checklist.md` binds chain `5042002`, USDC `0x3600…0000`, and 6 decimals | none |
| Checked-in inspection evidence | DONE | `forge inspect ArenaExchange abi` and `forge inspect ArenaExchange storage-layout` are captured in `arc-stack/contracts/artifacts/day15/`; fresh comparison reports both `MATCH` | none |

## Pass 1 — Day 16

| REQUIREMENT | STATUS | EVIDENCE | GAPS |
|---|---|---|---|
| Exact USDC deposit and withdrawal | DONE | `forge test --force --root arc-stack/contracts` → `testDepositWithdrawalMovesExactUSDCAndNeverReservedAtoms` passed | none |
| Complete-set and custody invariants | DONE | Same command → mint/trade/merge, immediate redeem, resolved redeem, and pre-resolution failure tests passed after every transition | none |
| No naked shorts and checked integer accounting | DONE | Same command → invariant and overflow/underflow tests passed; all accounting values are integer atoms | none |
| Continuous solvency | DONE | Same command → `testFuzzDepositWithdrawPreservesSolvency` passed 1,000 runs and operation-by-operation custody assertions passed | none |
| Reentrancy resistance | DONE | Same command → double-withdraw and double-redeem attacker tests passed | none |

## Pass 1 — Day 17

| REQUIREMENT | STATUS | EVIDENCE | GAPS |
|---|---|---|---|
| Sequencer-only committed proposals | DONE | `forge test --force --root arc-stack/contracts` → non-sequencer and conflicting proposal test passed | none |
| Restartable exactly-once application | DONE | Same command → restart/replay/conflict/finalization test passed | none |
| Conservation and atomic finalization | DONE | Same command → randomized conservation fuzz tests passed 2,000 combined runs; atomic failure test passed | none |
| Lifecycle and abort terminality | DONE | Same command → OPEN/SEALED/CLEARED/COMMITTED/APPLIED/FINALIZED and ABORTED terminal paths passed | none |
| Non-finalized collateral unavailable | DONE | Same command → pending collateral withdrawal rejection passed | none |

## Pass 1 — Day 18

| REQUIREMENT | STATUS | EVIDENCE | GAPS |
|---|---|---|---|
| No bare caller-selected winner | DONE | `forge test --force --root arc-stack/contracts` → `testSelfAssertedOutcomeWithoutBoundEvidenceReverts` passed | none |
| Evidence validation and replayability | DONE | Same command → all source, identity, finality, freshness, skew, range, signature, spec/domain, and stored-report checks passed | none |
| Divergence/staleness fail to INVALID | DONE | Same command → authenticated divergent and stale reports produced INVALID and never selected a winner | none |
| Grace invalidation is deterministic | DONE | Same command → grace expiry and equal payout dust rule test passed | none |
| Outcome-derived redemption | DONE | Same command → winner received exactly `payoutAtoms`, loser received zero, and INVALID outcomes received the deterministic equal payout | none |

## Pass 2 — Days 1–18

| ITEM | STATUS | EVIDENCE | GAPS |
|---|---|---|---|
| Day 1 — beta scope and ADRs | DONE | `npm run roadmap:day1:gate` within `npm run verify` → 10/10 passed | none |
| Day 2 — MarketSpec and golden vectors | DONE | `npm run roadmap:day2:gate` → 21/21 tests and artifact gate PASS; original V2 vector unchanged | none |
| Day 3 — threat and authority gates | DONE | `npm run roadmap:day3:gate` → artifact gate PASS and 18/18 security tests | none |
| Day 4 — database migrations | DONE | Fresh database plus `ARC_TEST_DATABASE_URL=… npm --prefix arc-stack test` → 18 files, 81/81 tests | none |
| Day 5 — ledger and reservations | DONE | Database-backed ledger/reservation/idempotency tests included in the 81/81 pass | none |
| Day 6 — complete-set accounting | DONE | Forge Day 16 invariant suite plus database accounting tests passed | none |
| Day 7 — market state machine | DONE | State-transition, batch-lifecycle, and invalid-transition suites passed | none |
| Day 8 — signed orders and cancellations | DONE | Forge EOA/ERC-1271 compatibility test plus signature/domain/replay API tests passed; original type hashes unchanged | none |
| Day 9 — durable intake and recovery | DONE | PostgreSQL append-log, signed-receipt, assignment, and recovery tests passed | none |
| Day 10 — uniform-price clearing | DONE | Deterministic clearing and golden-vector tests passed | none |
| Day 11 — pro-rata, netting, partial fills, cutoff | DONE | Clearing property/fuzz and cancellation-cutoff tests passed | none |
| Day 12 — roots, bundle, replay CLI | DONE | Service/replay byte-identical hash tests passed | none |
| Day 13 — versioned API and errors | DONE | OpenAPI, stable error, write/read, and idempotency integration tests passed | none |
| Day 14 — resumable stream and SDK | DONE | WebSocket resume tests passed; SDK build and 5/5 tests passed | none |
| Day 15 — frozen contract surface | DONE | Frozen ABI/storage comparison and 5/5 Day 15 tests passed | none |
| Day 16 — custody and redemption | DONE | 8/8 custody/reentrancy tests passed including 1,000 fuzz runs | none |
| Day 17 — committed batch lifecycle | DONE | 5/5 tests passed including 2,000 fuzz runs | none |
| Day 18 — evidence-bound resolution | DONE | 5/5 evidence and payout tests passed | none |

## Full gate output summary

`npm run verify` exited `0`: Day 1 `10/10`, Day 2 `21/21`, Day 3 `18/18`, backend no-DB `73/73` with 8 DB-gated skips, SDK `5/5`, dependency audits `0 vulnerabilities`, Forge `23/23`, contract runtime `24,576` bytes.

The fresh database-backed rerun exited `0`: `18` files and `81/81` tests passed with zero skips. The explicit pre-deploy rerun exited `0`: fresh `forge build`, `forge test` (`23/23`), TypeScript build, and database-backed `81/81` tests.

Launch-gate confirmation:

- No contract call accepts an unproven caller-selected winner: proven by the Day 18 negative test and the absence of a bare-outcome resolution entrypoint in the frozen ABI.
- ArenaExchange passes chain/address, role, USDC transfer, storage, reentrancy, replay, resolution, solvency, and arithmetic review: proven by the frozen artifact gate and 23-test Forge suite.

Days 19–30 were not implemented or modified in this release.

## Arc Testnet and Railway deployment evidence

Contract deployment:

- ArenaExchange V3: `0x6B42F8Ec16EE7C580213D0d07076019aBD6eE071`
- Transaction: `0x56b961da2cb0c12a8ba626f473174ae5ce5646a1d4f57c3bd58777f1d7fd8ff1` (`status=0x1`, block `53245927`)
- Resolution verifier: `0x9fadda17E713a4216FcA32190975cb6F6cb80ABb`
- Transaction: `0xfa081633ddd45cf2190cd97fa873851c4b5b48e03e53b9a3ba096a8375cdaed1`

Fresh `cast` reads through `https://rpc.testnet.arc.network` returned chain `5042002`, exchange runtime `24576` bytes, verifier runtime `3107` bytes, collateral `0x3600000000000000000000000000000000000000`, collateral decimals `6`, payout atoms `1000000`, and the expected verifier address.

Railway deployments:

| Service | Deployment | Status | Live check |
|---|---|---|---|
| API | `c4e12b2f-e316-4ed2-8edc-e5b5f7e7e396` | SUCCESS | `/health/ready` HTTP 200; database, RPC, chain, USDC, exchange all `true` |
| Middleman | `a786dcf0-fd68-45eb-946a-3bde6f14cffb` | SUCCESS | `/health/ready` HTTP 200; database, RPC, contract, relayer, upgrade multisig, sequencer, resolver, result watcher all `true` |
| MCP | `02aec2f5-6092-43fd-869f-b7a1a27da8e7` | SUCCESS | `/health/ready` HTTP 200; upstream API `200`; `/health/live` reports 13 tools |

Live API `/v1/network` returned chain `5042002`, official USDC, 6 application decimals, and exchange `0x6B42F8Ec16EE7C580213D0d07076019aBD6eE071`.

The dedicated V3 PostgreSQL database reports migrations `1,2,3,4,5,6,7,8`, immutable deployment binding `5042002 | 0x6B42F8Ec16EE7C580213D0d07076019aBD6eE071`, and empty new `arc_resolution_reports` and `arc_order_events` tables. No V1/V2 financial state was copied.
