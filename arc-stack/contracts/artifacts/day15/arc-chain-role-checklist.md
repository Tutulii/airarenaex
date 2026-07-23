# ArenaExchange V3 frozen deployment checklist

Checked against `config/arena-exchange/vectors/arc-market-spec-1x2.v1.json` and the deployed V3 release.

- [x] Chain ID: vector `5042002`; contract constant `5042002`; deployment chain `5042002`.
- [x] Exchange address format: V2 vector address and V3 deployment address are checksummed 20-byte EVM addresses.
- [x] Frozen V3 exchange: `0x6B42F8Ec16EE7C580213D0d07076019aBD6eE071`.
- [x] V3 deployment transaction: `0x56b961da2cb0c12a8ba626f473174ae5ce5646a1d4f57c3bd58777f1d7fd8ff1`.
- [x] Frozen verifier: `0x9fadda17E713a4216FcA32190975cb6F6cb80ABb`.
- [x] Verifier deployment transaction: `0xfa081633ddd45cf2190cd97fa873851c4b5b48e03e53b9a3ba096a8375cdaed1`.
- [x] Collateral address: vector and contract use only `0x3600000000000000000000000000000000000000`.
- [x] Collateral decimals: vector and contract use `6`.
- [x] EIP-712 domain: `AIR Arena Arc`, version `1`, chain ID `5042002`, verifying contract V3.
- [x] Sequencer role: `0xac4f1890dc96c9a02330d1fa696648a38f3b282d2449c2d8e6f10507488c84c8`.
- [x] Resolver role: `0x92a19c77d2ea87c7f81d50c74403cb2f401780f3ad919571121efe2bdb427eb1`.
- [x] Protocol liquidity role: `0x54f7d8e1b9fcc06da9bc8995b5d8d9a6a65df076c937ff6b303fdd57fdb5760a`.
- [x] Emergency pauser role: `0x3b72b77b3d95d9b831cca52b36d7a9c3758f77be6c47ebd087c47739c743d369`.
- [x] Upgrade multisig role: `0x0000000000000000000000000000000000000000000000000000000000000000`.
- [x] Role membership is non-overlapping and the cross-role negative test passes.
- [x] The original V2 MarketSpec vector remains byte-for-byte valid; V3 MarketSpecs declare `arena-exchange-v3` and bind the new address.

The V2 contract remains immutable and available for its existing exits. New V3 orders and MarketSpecs must bind the V3 verifying contract and be re-signed.
