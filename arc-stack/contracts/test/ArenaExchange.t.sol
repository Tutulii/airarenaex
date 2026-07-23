// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { stdError } from "forge-std/StdError.sol";
import { StdStorage, stdStorage } from "forge-std/StdStorage.sol";
import { ArenaExchange } from "../src/ArenaExchange.sol";
import { ArenaResolutionVerifier } from "../src/ArenaResolutionVerifier.sol";
import { IArenaResolutionVerifier } from "../src/IArenaResolutionVerifier.sol";
import { MockUSDC } from "../src/MockUSDC.sol";
import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract Mock1271Wallet is IERC1271 {
    using ECDSA for bytes32;

    address public immutable owner;
    bool public reject;
    bool public shouldRevert;

    constructor(address owner_) {
        owner = owner_;
    }

    function configure(bool reject_, bool shouldRevert_) external {
        require(msg.sender == owner, "not owner");
        reject = reject_;
        shouldRevert = shouldRevert_;
    }

    function execute(address target, bytes calldata data) external returns (bytes memory) {
        require(msg.sender == owner, "not owner");
        (bool ok, bytes memory result) = target.call(data);
        require(ok, "call failed");
        return result;
    }

    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        if (shouldRevert) revert("signature check reverted");
        if (reject || digest.recover(signature) != owner) return bytes4(0xffffffff);
        return IERC1271.isValidSignature.selector;
    }
}

contract ReentrantUSDC is MockUSDC {
    address public exchange;
    address public recipient;
    address public callbackTarget;
    uint256 public amount;
    bytes public callbackData;
    bool public attempted;
    bool public reentrySucceeded;

    function arm(address exchange_, address recipient_, uint256 amount_) external {
        exchange = exchange_;
        recipient = recipient_;
        amount = amount_;
        callbackTarget = address(0);
        delete callbackData;
    }

    function armCallback(address exchange_, address callbackTarget_, bytes calldata callbackData_) external {
        exchange = exchange_;
        callbackTarget = callbackTarget_;
        callbackData = callbackData_;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (msg.sender == exchange && !attempted) {
            attempted = true;
            if (callbackTarget == address(0)) {
                (reentrySucceeded,) =
                    exchange.call(abi.encodeCall(ArenaExchange.withdraw, (amount, recipient)));
            } else {
                (reentrySucceeded,) = callbackTarget.call(callbackData);
            }
        }
        return super.transfer(to, value);
    }
}

contract ReentrantRedeemer {
    ArenaExchange private immutable exchange;
    ReentrantUSDC private immutable token;
    bytes32 private immutable marketId;

    constructor(ArenaExchange exchange_, ReentrantUSDC token_, bytes32 marketId_) {
        exchange = exchange_;
        token = token_;
        marketId = marketId_;
    }

    function prepare(uint256 amount) external {
        token.approve(address(exchange), amount);
        exchange.deposit(amount);
        exchange.splitCompleteSet(marketId, amount);
    }

    function redeemAndWithdraw(uint256 amount) external {
        exchange.redeem(marketId);
        token.armCallback(address(exchange), address(this), abi.encodeCall(this.reenterRedeem, (marketId)));
        exchange.withdraw(amount, address(this));
    }

    function reenterRedeem(bytes32 id) external {
        require(msg.sender == address(token), "only token");
        exchange.redeem(id);
    }
}

contract WrongDecimalsUSDC is MockUSDC {
    function decimals() public pure override returns (uint8) {
        return 18;
    }
}

abstract contract ArenaExchangeTestBase is Test {
    using stdStorage for StdStorage;

    uint128 internal constant UNIT = 1_000_000;
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    uint256 internal buyerKey = 0xB0B;
    uint256 internal sellerKey = 0xA11CE;
    uint256 internal primaryKey = 0x1111;
    uint256 internal witnessKey = 0x2222;
    address internal buyer;
    address internal seller;
    address internal primarySigner;
    address internal witnessSigner;
    address internal sequencer = makeAddr("sequencer");
    address internal resolver = makeAddr("resolver");
    address internal liquidity = makeAddr("protocol-liquidity");
    address internal pauser = makeAddr("emergency-pauser");
    address internal upgrade = makeAddr("upgrade-multisig");
    bytes32 internal marketId = keccak256("txline:france-england:v3");
    bytes32 internal specHash = keccak256("canonical-market-spec-v3");

    MockUSDC internal usdc;
    ArenaResolutionVerifier internal verifier;
    ArenaExchange internal exchange;

    function setUp() public virtual {
        vm.chainId(5_042_002);
        buyer = vm.addr(buyerKey);
        seller = vm.addr(sellerKey);
        primarySigner = vm.addr(primaryKey);
        witnessSigner = vm.addr(witnessKey);
        MockUSDC implementation = new MockUSDC();
        vm.etch(ARC_USDC, address(implementation).code);
        usdc = MockUSDC(ARC_USDC);
        verifier = new ArenaResolutionVerifier();
        exchange = new ArenaExchange(sequencer, resolver, liquidity, pauser, upgrade, address(verifier), 50);
        usdc.mint(buyer, 100 * UNIT);
        usdc.mint(seller, 100 * UNIT);
        _deposit(buyer, 100 * UNIT);
        _deposit(seller, 100 * UNIT);
        _createMarket(marketId, specHash);
    }

    function _rule() internal view returns (IArenaResolutionVerifier.ResolutionRule memory) {
        return IArenaResolutionVerifier.ResolutionRule({
            primarySourceId: keccak256("txline-primary"),
            witnessSourceId: keccak256("approved-result-witness"),
            sourceEventId: keccak256("fixture:18179552"),
            primarySigner: primarySigner,
            witnessSigner: witnessSigner,
            maxReportAgeSeconds: 120,
            maxSourceTimestampSkewSeconds: 30,
            graceSeconds: 900
        });
    }

    function _createMarket(bytes32 id, bytes32 marketSpecHash) internal {
        vm.prank(upgrade);
        exchange.createMarket(
            id,
            marketSpecHash,
            keccak256(abi.encode("18179552", id)),
            3,
            uint64(block.timestamp + 1 days),
            _rule()
        );
    }

    function _deposit(address account, uint256 amount) internal {
        vm.startPrank(account);
        usdc.approve(address(exchange), amount);
        exchange.deposit(amount);
        vm.stopPrank();
        _assertSolvent();
    }

    function _order(
        address maker,
        bool isBuy,
        uint8 outcome,
        uint64 price,
        uint128 quantity,
        uint256 nonce,
        string memory clientId
    ) internal view returns (ArenaExchange.Order memory) {
        return ArenaExchange.Order({
            maker: maker,
            marketId: marketId,
            outcome: outcome,
            isBuy: isBuy,
            pricePpm: price,
            quantity: quantity,
            expiry: uint64(block.timestamp + 1 hours),
            nonce: nonce,
            clientOrderId: keccak256(bytes(clientId))
        });
    }

    function _signature(uint256 signerKey, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _report(
        bytes32 sourceId,
        uint8 outcome,
        uint64 observedAt,
        uint64 publishedAt,
        bool finalResult,
        bytes32 rawHash
    ) internal view returns (IArenaResolutionVerifier.ResolutionReport memory report) {
        report = IArenaResolutionVerifier.ResolutionReport({
                sourceId: sourceId,
                sourceEventId: keccak256("fixture:18179552"),
                observedAt: observedAt,
                publishedAt: publishedAt,
                finalResult: finalResult,
                normalizedOutcome: outcome,
                rawPayloadHash: rawHash,
                signatureEvidence: ""
            });
    }

    function _signReport(
        bytes32 id,
        bytes32 marketSpecHash,
        IArenaResolutionVerifier.ResolutionReport memory report,
        uint256 key
    ) internal view returns (IArenaResolutionVerifier.ResolutionReport memory) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, keccak256("AIR Arena Arc"), keccak256("1"), block.chainid, address(exchange)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                verifier.REPORT_TYPEHASH(),
                id,
                marketSpecHash,
                report.sourceId,
                report.sourceEventId,
                report.observedAt,
                report.publishedAt,
                report.finalResult,
                report.normalizedOutcome,
                report.rawPayloadHash
            )
        );
        report.signatureEvidence =
            _signature(key, keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash)));
        return report;
    }

    function _freshReports(bytes32 id, bytes32 marketSpecHash, uint8 outcome)
        internal
        view
        returns (
            IArenaResolutionVerifier.ResolutionReport memory primary,
            IArenaResolutionVerifier.ResolutionReport memory witness
        )
    {
        uint64 now_ = uint64(block.timestamp);
        primary =
            _report(keccak256("txline-primary"), outcome, now_ - 2, now_ - 1, true, keccak256("raw-primary"));
        witness = _report(
            keccak256("approved-result-witness"), outcome, now_ - 2, now_ - 1, true, keccak256("raw-witness")
        );
        primary = _signReport(id, marketSpecHash, primary, primaryKey);
        witness = _signReport(id, marketSpecHash, witness, witnessKey);
    }

    function _publishLegacyBatch(
        bytes32 id,
        uint8 outcome,
        uint64 price,
        ArenaExchange.Match[] memory matches_
    ) internal {
        bytes32 commitment = keccak256(abi.encode("AIR_ARENA_LEGACY_BATCH_V1", id, outcome, price, matches_));
        vm.prank(sequencer);
        exchange.publishDataCommitment(commitment);
        vm.roll(block.number + 1);
    }

    function _assertSolvent() internal view {
        assertTrue(exchange.isSolvent());
        assertGe(usdc.balanceOf(address(exchange)), exchange.totalLiabilities());
    }
}

contract ArenaExchangeDay15Test is ArenaExchangeTestBase {
    function testFrozenChainCollateralDomainAndOrderFormat() external view {
        assertEq(exchange.ARC_CHAIN_ID(), 5_042_002);
        assertEq(address(exchange.collateral()), ARC_USDC);
        assertEq(exchange.COLLATERAL_DECIMALS(), 6);
        assertEq(exchange.PAYOUT_ATOMS(), UNIT);
        assertEq(
            exchange.ORDER_TYPEHASH(),
            keccak256(
                "Order(address maker,bytes32 marketId,uint8 outcome,bool isBuy,uint64 pricePpm,uint128 quantity,uint64 expiry,uint256 nonce,bytes32 clientOrderId)"
            )
        );
        (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,,
        ) = exchange.eip712Domain();
        assertEq(fields, hex"0f");
        assertEq(name, "AIR Arena Arc");
        assertEq(version, "1");
        assertEq(chainId, 5_042_002);
        assertEq(verifyingContract, address(exchange));
        (bytes32 storedSpecHash,,,,,,) = exchange.markets(marketId);
        assertEq(storedSpecHash, specHash);
    }

    function testCrossRoleCallsRevertAndPauseCannotMoveOrResolveFunds() external {
        vm.prank(pauser);
        vm.expectRevert();
        exchange.withdrawProtocolRevenue(1, 0, pauser);

        vm.prank(resolver);
        vm.expectRevert();
        exchange.withdrawProtocolRevenue(1, 0, resolver);

        vm.prank(liquidity);
        vm.expectRevert();
        exchange.publishDataCommitment(keccak256("liquidity-is-not-sequencer"));

        vm.prank(sequencer);
        vm.expectRevert();
        exchange.createMarket(
            keccak256("sequencer-cannot-create"),
            keccak256("spec"),
            keccak256("external"),
            3,
            uint64(block.timestamp + 1 days),
            _rule()
        );

        vm.warp(block.timestamp + 1 days + 2);
        (
            IArenaResolutionVerifier.ResolutionReport memory primary,
            IArenaResolutionVerifier.ResolutionReport memory witness
        ) = _freshReports(marketId, specHash, 2);
        vm.prank(pauser);
        vm.expectRevert();
        exchange.resolveMarket(marketId, primary, witness);

        vm.prank(resolver);
        vm.expectRevert();
        exchange.pause();
        vm.prank(sequencer);
        vm.expectRevert();
        exchange.unpause();
    }

    function testRoleMembershipCannotOverlap() external {
        bytes32 resolverRole = exchange.RESOLVER_ROLE();
        vm.prank(upgrade);
        vm.expectRevert(ArenaExchange.RoleCollision.selector);
        exchange.grantRole(resolverRole, sequencer);
    }

    function testWrongChainAndWrongDecimalsFailClosed() external {
        vm.chainId(1);
        vm.expectRevert(ArenaExchange.WrongChain.selector);
        new ArenaExchange(sequencer, resolver, liquidity, pauser, upgrade, address(verifier), 50);

        vm.chainId(5_042_002);
        WrongDecimalsUSDC wrongDecimals = new WrongDecimalsUSDC();
        vm.etch(ARC_USDC, address(wrongDecimals).code);
        vm.expectRevert(ArenaExchange.UnsupportedCollateral.selector);
        new ArenaExchange(sequencer, resolver, liquidity, pauser, upgrade, address(verifier), 50);
    }

    function testEOAAndERC1271OrdersAndSignedCancellationsRemainCompatible() external {
        ArenaExchange.Order memory eoaOrder = _order(buyer, true, 0, 400_000, UNIT, 1_001, "eoa");
        bytes32 eoaOrderHash = exchange.hashOrder(eoaOrder);
        exchange.submitOrder(eoaOrder, _signature(buyerKey, eoaOrderHash));
        ArenaExchange.Cancel memory eoaCancel = ArenaExchange.Cancel({
            maker: buyer, orderHash: eoaOrderHash, nonce: 91, deadline: uint64(block.timestamp + 1 hours)
        });
        exchange.cancelOrderBySig(eoaCancel, _signature(buyerKey, exchange.hashCancel(eoaCancel)));
        assertEq(uint8(exchange.getOrder(eoaOrderHash).status), uint8(ArenaExchange.OrderStatus.CANCELLED));

        uint256 ownerKey = 0xBEEF;
        address owner = vm.addr(ownerKey);
        Mock1271Wallet wallet = new Mock1271Wallet(owner);
        usdc.mint(address(wallet), 2 * UNIT);
        vm.startPrank(owner);
        wallet.execute(address(usdc), abi.encodeCall(usdc.approve, (address(exchange), 2 * UNIT)));
        wallet.execute(address(exchange), abi.encodeCall(exchange.deposit, (2 * UNIT)));
        vm.stopPrank();

        ArenaExchange.Order memory contractOrder =
            _order(address(wallet), true, 1, 600_000, UNIT, 1_002, "erc1271");
        bytes32 contractOrderHash = exchange.hashOrder(contractOrder);
        exchange.submitOrder(contractOrder, _signature(ownerKey, contractOrderHash));
        ArenaExchange.Cancel memory contractCancel = ArenaExchange.Cancel({
            maker: address(wallet),
            orderHash: contractOrderHash,
            nonce: 92,
            deadline: uint64(block.timestamp + 1 hours)
        });
        exchange.cancelOrderBySig(contractCancel, _signature(ownerKey, exchange.hashCancel(contractCancel)));
        assertEq(
            uint8(exchange.getOrder(contractOrderHash).status), uint8(ArenaExchange.OrderStatus.CANCELLED)
        );
        assertTrue(exchange.usedCancellationNonces(address(wallet), 92));
    }
}

contract ArenaExchangeDay16Test is ArenaExchangeTestBase {
    using stdStorage for StdStorage;

    function testMintTradeMergeAndIssuanceInvariantsAfterEveryOpenStep() external {
        vm.prank(seller);
        exchange.splitCompleteSet(marketId, 2 * UNIT);
        _assertIssuanceInvariant(2 * UNIT);

        ArenaExchange.Order memory buy = _order(buyer, true, 1, 500_000, UNIT, 1, "mint-trade-buy");
        ArenaExchange.Order memory sell = _order(seller, false, 1, 500_000, UNIT, 2, "mint-trade-sell");
        bytes32 buyHash = exchange.hashOrder(buy);
        bytes32 sellHash = exchange.hashOrder(sell);
        exchange.submitOrder(buy, _signature(buyerKey, buyHash));
        exchange.submitOrder(sell, _signature(sellerKey, sellHash));
        ArenaExchange.Match[] memory matches_ = new ArenaExchange.Match[](1);
        matches_[0] = ArenaExchange.Match(buyHash, sellHash, UNIT);
        _publishLegacyBatch(marketId, 1, 500_000, matches_);
        vm.prank(sequencer);
        exchange.executeBatch(marketId, 1, 500_000, matches_);
        _assertIssuanceInvariant(2 * UNIT);

        vm.prank(seller);
        exchange.mergeCompleteSet(marketId, UNIT);
        _assertIssuanceInvariant(UNIT);
        _assertSolvent();
    }

    function testDepositWithdrawalMovesExactUSDCAndNeverReservedAtoms() external {
        uint256 before = usdc.balanceOf(buyer);
        ArenaExchange.Order memory buy = _order(buyer, true, 0, 500_000, 10 * UNIT, 9, "reserved");
        bytes32 hash = exchange.hashOrder(buy);
        exchange.submitOrder(buy, _signature(buyerKey, hash));
        uint256 available = exchange.availableCollateral(buyer);
        vm.prank(buyer);
        vm.expectRevert(ArenaExchange.InsufficientCollateral.selector);
        exchange.withdraw(available + 1, buyer);
        vm.prank(buyer);
        exchange.withdraw(UNIT, buyer);
        assertEq(usdc.balanceOf(buyer), before + UNIT);
        _assertSolvent();
    }

    function testRedeemImmediatelyAfterMintAndResolvedWinnerLoserAmounts() external {
        vm.prank(seller);
        exchange.splitCompleteSet(marketId, 3 * UNIT);
        vm.prank(seller);
        exchange.mergeCompleteSet(marketId, UNIT);
        _assertIssuanceInvariant(2 * UNIT);

        ArenaExchange.Order memory buy = _order(buyer, true, 1, 500_000, UNIT, 10, "loser-buy");
        ArenaExchange.Order memory sell = _order(seller, false, 1, 500_000, UNIT, 11, "loser-sell");
        bytes32 buyHash = exchange.hashOrder(buy);
        bytes32 sellHash = exchange.hashOrder(sell);
        exchange.submitOrder(buy, _signature(buyerKey, buyHash));
        exchange.submitOrder(sell, _signature(sellerKey, sellHash));
        ArenaExchange.Match[] memory matches_ = new ArenaExchange.Match[](1);
        matches_[0] = ArenaExchange.Match(buyHash, sellHash, UNIT);
        _publishLegacyBatch(marketId, 1, 500_000, matches_);
        vm.prank(sequencer);
        exchange.executeBatch(marketId, 1, 500_000, matches_);

        vm.warp(block.timestamp + 1 days + 2);
        (
            IArenaResolutionVerifier.ResolutionReport memory primary,
            IArenaResolutionVerifier.ResolutionReport memory witness
        ) = _freshReports(marketId, specHash, 0);
        vm.prank(resolver);
        exchange.resolveMarket(marketId, primary, witness);
        uint256 sellerBefore = exchange.availableCollateral(seller);
        vm.prank(seller);
        exchange.redeem(marketId);
        assertEq(exchange.availableCollateral(seller), sellerBefore + 2 * UNIT);
        uint256 buyerBefore = exchange.availableCollateral(buyer);
        vm.prank(buyer);
        exchange.redeem(marketId);
        assertEq(exchange.availableCollateral(buyer), buyerBefore);
        assertEq(exchange.marketCollateral(marketId), 0);
        _assertSolvent();
    }

    function testMintTradeThenRedeemAndPreResolutionRedemptionFailsClosed() external {
        vm.prank(seller);
        exchange.splitCompleteSet(marketId, UNIT);
        ArenaExchange.Order memory buy = _order(buyer, true, 2, 500_000, UNIT, 401, "mtr-buy");
        ArenaExchange.Order memory sell = _order(seller, false, 2, 500_000, UNIT, 402, "mtr-sell");
        bytes32 buyHash = exchange.hashOrder(buy);
        bytes32 sellHash = exchange.hashOrder(sell);
        exchange.submitOrder(buy, _signature(buyerKey, buyHash));
        exchange.submitOrder(sell, _signature(sellerKey, sellHash));
        ArenaExchange.Match[] memory matches_ = new ArenaExchange.Match[](1);
        matches_[0] = ArenaExchange.Match(buyHash, sellHash, UNIT);
        _publishLegacyBatch(marketId, 2, 500_000, matches_);
        vm.prank(sequencer);
        exchange.executeBatch(marketId, 2, 500_000, matches_);
        _assertSolvent();

        vm.prank(buyer);
        vm.expectRevert(ArenaExchange.InvalidMarketState.selector);
        exchange.redeem(marketId);

        vm.warp(block.timestamp + 1 days + 2);
        (
            IArenaResolutionVerifier.ResolutionReport memory primary,
            IArenaResolutionVerifier.ResolutionReport memory witness
        ) = _freshReports(marketId, specHash, 2);
        vm.prank(resolver);
        exchange.resolveMarket(marketId, primary, witness);
        uint256 before = exchange.availableCollateral(buyer);
        vm.prank(buyer);
        exchange.redeem(marketId);
        assertEq(exchange.availableCollateral(buyer) - before, UNIT);
        vm.prank(buyer);
        vm.expectRevert(ArenaExchange.InvalidAmount.selector);
        exchange.redeem(marketId);
        assertEq(exchange.marketCollateral(marketId), 0);
        _assertSolvent();
    }

    function testCheckedArithmeticOverflowAndUnderflowRevert() external {
        vm.prank(seller);
        exchange.splitCompleteSet(marketId, UNIT);
        vm.prank(seller);
        vm.expectRevert(ArenaExchange.InsufficientShares.selector);
        exchange.mergeCompleteSet(marketId, 2 * UNIT);

        stdstore.target(address(exchange)).sig(exchange.claimSupplyAtoms.selector).with_key(marketId)
            .with_key(uint8(0)).checked_write(type(uint256).max);
        vm.prank(seller);
        vm.expectRevert(stdError.arithmeticError);
        exchange.splitCompleteSet(marketId, UNIT);
    }

    function testFuzzDepositWithdrawPreservesSolvency(uint96 rawAmount) external {
        uint256 amount = bound(uint256(rawAmount), 1, 50 * UNIT);
        address account = makeAddr("fuzz-account");
        usdc.mint(account, amount);
        _deposit(account, amount);
        vm.prank(account);
        exchange.withdraw(amount, account);
        assertEq(exchange.availableCollateral(account), 0);
        assertEq(usdc.balanceOf(account), amount);
        _assertSolvent();
    }

    function _assertIssuanceInvariant(uint256 expectedAtoms) private view {
        assertEq(exchange.completeSetAtomsOutstanding(marketId), expectedAtoms);
        assertEq(expectedAtoms % UNIT, 0);
        assertEq(exchange.marketCollateral(marketId), expectedAtoms);
        for (uint8 outcome; outcome < 3; ++outcome) {
            assertEq(exchange.claimSupplyAtoms(marketId, outcome), expectedAtoms);
        }
    }
}

contract ArenaExchangeReentrancyTest is Test {
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    function testReentrantTokenCannotDoubleWithdraw() external {
        vm.chainId(5_042_002);
        ReentrantUSDC implementation = new ReentrantUSDC();
        vm.etch(ARC_USDC, address(implementation).code);
        ReentrantUSDC token = ReentrantUSDC(ARC_USDC);
        ArenaResolutionVerifier verifier = new ArenaResolutionVerifier();
        ArenaExchange exchange = new ArenaExchange(
            makeAddr("seq"),
            makeAddr("resolver"),
            makeAddr("liq"),
            makeAddr("pause"),
            makeAddr("upgrade"),
            address(verifier),
            50
        );
        address user = makeAddr("user");
        token.mint(user, 2_000_000);
        vm.startPrank(user);
        token.approve(address(exchange), 2_000_000);
        exchange.deposit(2_000_000);
        vm.stopPrank();
        token.arm(address(exchange), user, 1_000_000);
        vm.prank(user);
        exchange.withdraw(1_000_000, user);
        assertTrue(token.attempted());
        assertFalse(token.reentrySucceeded());
        assertEq(exchange.availableCollateral(user), 1_000_000);
        assertEq(token.balanceOf(user), 1_000_000);
        assertTrue(exchange.isSolvent());
    }

    function testReentrantAttackerCannotDoubleRedeem() external {
        vm.chainId(5_042_002);
        ReentrantUSDC implementation = new ReentrantUSDC();
        vm.etch(ARC_USDC, address(implementation).code);
        ReentrantUSDC token = ReentrantUSDC(ARC_USDC);
        ArenaResolutionVerifier verifier = new ArenaResolutionVerifier();
        address sequencer = makeAddr("redeem-sequencer");
        address resolver = makeAddr("redeem-resolver");
        address upgrade = makeAddr("redeem-upgrade");
        ArenaExchange exchange = new ArenaExchange(
            sequencer,
            resolver,
            makeAddr("redeem-liquidity"),
            makeAddr("redeem-pauser"),
            upgrade,
            address(verifier),
            50
        );
        bytes32 marketId = keccak256("reentrant-redeem-market");
        IArenaResolutionVerifier.ResolutionRule memory rule = IArenaResolutionVerifier.ResolutionRule({
            primarySourceId: keccak256("primary"),
            witnessSourceId: keccak256("witness"),
            sourceEventId: keccak256("event"),
            primarySigner: makeAddr("primary-signer"),
            witnessSigner: makeAddr("witness-signer"),
            maxReportAgeSeconds: 10,
            maxSourceTimestampSkewSeconds: 1,
            graceSeconds: 1
        });
        vm.prank(upgrade);
        exchange.createMarket(
            marketId,
            keccak256("reentrant-spec"),
            keccak256("reentrant-external"),
            3,
            uint64(block.timestamp + 10),
            rule
        );
        ReentrantRedeemer attacker = new ReentrantRedeemer(exchange, token, marketId);
        token.mint(address(attacker), 1_000_000);
        attacker.prepare(1_000_000);
        vm.warp(block.timestamp + 11);
        exchange.invalidateAfterGrace(marketId);
        attacker.redeemAndWithdraw(1_000_000);
        assertTrue(token.attempted());
        assertFalse(token.reentrySucceeded());
        assertEq(token.balanceOf(address(attacker)), 1_000_000);
        assertEq(exchange.marketCollateral(marketId), 0);
        assertTrue(exchange.isSolvent());
    }
}

contract ArenaExchangeDay17Test is ArenaExchangeTestBase {
    function testRestartableBatchReplayConflictConservationAndFinalization() external {
        vm.prank(seller);
        exchange.splitCompleteSet(marketId, 2 * UNIT);
        ArenaExchange.Match[2] memory matchList;
        bytes32[2] memory buyHashes;
        bytes32[2] memory sellHashes;
        for (uint256 i; i < 2; ++i) {
            ArenaExchange.Order memory buy =
                _order(buyer, true, 0, 500_000, UNIT, 100 + i, i == 0 ? "b0" : "b1");
            ArenaExchange.Order memory sell =
                _order(seller, false, 0, 500_000, UNIT, 200 + i, i == 0 ? "s0" : "s1");
            buyHashes[i] = exchange.hashOrder(buy);
            sellHashes[i] = exchange.hashOrder(sell);
            exchange.submitOrder(buy, _signature(buyerKey, buyHashes[i]));
            exchange.submitOrder(sell, _signature(sellerKey, sellHashes[i]));
            matchList[i] = ArenaExchange.Match(buyHashes[i], sellHashes[i], UNIT);
        }

        bytes32 dataCommitment = keccak256("published-batch-bundle");
        vm.prank(sequencer);
        exchange.publishDataCommitment(dataCommitment);
        vm.roll(block.number + 1);
        vm.prank(sequencer);
        bytes32 batchId = exchange.openBatch(marketId, 0, bytes32(0), dataCommitment);
        vm.prank(sequencer);
        exchange.sealBatch(batchId, keccak256("order-root"));

        bytes32 leaf0 = _batchLeaf(batchId, 0, matchList[0]);
        bytes32 leaf1 = _batchLeaf(batchId, 1, matchList[1]);
        bytes32 root = _hashPair(leaf0, leaf1);
        uint256 debit = 500_000;
        uint256 fee = 2_500;
        uint256 credit = debit - fee;
        bytes32 rolling = keccak256(abi.encode(bytes32(0), leaf0, debit, credit, fee, UNIT));
        rolling = keccak256(abi.encode(rolling, leaf1, debit, credit, fee, UNIT));

        vm.prank(sequencer);
        exchange.clearBatch(batchId, 0, 500_000, root, 2, 2 * debit, 2 * credit, 2 * fee, 2 * UNIT, rolling);
        vm.prank(sequencer);
        exchange.commitBatch(batchId);

        bytes32[] memory proof0 = new bytes32[](1);
        proof0[0] = leaf1;
        vm.prank(sequencer);
        exchange.applyBatchMatch(batchId, 0, matchList[0], proof0);
        assertEq(exchange.pendingBatchShares(batchId, buyer), UNIT);
        uint256 available = exchange.availableCollateral(seller);
        vm.prank(seller);
        vm.expectRevert(ArenaExchange.InsufficientCollateral.selector);
        exchange.withdraw(available + 1, seller);

        // Simulated worker restart replays the confirmed unit and then resumes at the cursor.
        vm.prank(sequencer);
        exchange.applyBatchMatch(batchId, 0, matchList[0], proof0);
        assertEq(exchange.pendingBatchShares(batchId, buyer), UNIT);

        bytes32[] memory proof1 = new bytes32[](1);
        proof1[0] = leaf0;
        vm.prank(sequencer);
        exchange.applyBatchMatch(batchId, 1, matchList[1], proof1);
        vm.prank(sequencer);
        exchange.finalizeBatch(batchId);
        vm.prank(buyer);
        exchange.claimBatchSettlement(batchId);
        vm.prank(seller);
        exchange.claimBatchSettlement(batchId);
        assertEq(exchange.positions(marketId, 0, buyer), 2 * UNIT);
        assertEq(exchange.lastFinalizedLedgerRoot(marketId), rolling);
        assertEq(exchange.nextBatchSequence(marketId), 1);
        _assertSolvent();

        vm.prank(sequencer);
        exchange.applyBatchMatch(batchId, 1, matchList[1], proof1);
        vm.prank(sequencer);
        vm.expectRevert(ArenaExchange.BatchConflict.selector);
        exchange.applyBatchMatch(
            batchId, 1, ArenaExchange.Match(buyHashes[1], sellHashes[1], UNIT - 1), proof1
        );
    }

    function testNonSequencerAndConflictingProposalRevertAndAbortIsTerminal() external {
        bytes32 commitment = keccak256("commitment");
        vm.prank(sequencer);
        exchange.publishDataCommitment(commitment);
        vm.roll(block.number + 1);
        vm.prank(buyer);
        vm.expectRevert();
        exchange.openBatch(marketId, 0, bytes32(0), commitment);
        vm.prank(sequencer);
        bytes32 batchId = exchange.openBatch(marketId, 0, bytes32(0), commitment);
        vm.prank(sequencer);
        vm.expectRevert(ArenaExchange.InvalidBatch.selector);
        exchange.openBatch(marketId, 0, bytes32(0), commitment);
        vm.prank(sequencer);
        exchange.abortBatch(batchId);
        assertEq(exchange.activeBatchByMarket(marketId), bytes32(0));
        assertEq(exchange.nextBatchSequence(marketId), 0);
        vm.prank(sequencer);
        vm.expectRevert(ArenaExchange.InvalidBatch.selector);
        exchange.sealBatch(batchId, keccak256("orders"));
    }

    function testFuzzFinalizedBatchConserves(uint32 rawLots, uint32 rawPrice) external {
        uint128 quantity = uint128(bound(rawLots, 1, 50)) * 10_000;
        uint64 price = uint64(bound(rawPrice, 100_000, 900_000));
        vm.prank(seller);
        exchange.splitCompleteSet(marketId, UNIT);
        ArenaExchange.Order memory buy = _order(buyer, true, 2, price, quantity, 700, "fuzz-buy");
        ArenaExchange.Order memory sell = _order(seller, false, 2, price, quantity, 701, "fuzz-sell");
        bytes32 buyHash = exchange.hashOrder(buy);
        bytes32 sellHash = exchange.hashOrder(sell);
        exchange.submitOrder(buy, _signature(buyerKey, buyHash));
        exchange.submitOrder(sell, _signature(sellerKey, sellHash));
        ArenaExchange.Match memory matched = ArenaExchange.Match(buyHash, sellHash, quantity);
        bytes32 commitment = keccak256(abi.encode(quantity, price));
        vm.prank(sequencer);
        exchange.publishDataCommitment(commitment);
        vm.roll(block.number + 1);
        vm.prank(sequencer);
        bytes32 batchId = exchange.openBatch(marketId, 0, bytes32(0), commitment);
        vm.prank(sequencer);
        exchange.sealBatch(batchId, keccak256("fuzz-orders"));
        bytes32 leaf = _batchLeaf(batchId, 0, matched);
        uint256 debit = (uint256(quantity) * price + 999_999) / 1_000_000;
        uint256 quote = uint256(quantity) * price / 1_000_000;
        uint256 fee = quote * 50 / 10_000;
        uint256 credit = debit - fee;
        bytes32 root = keccak256(abi.encode(bytes32(0), leaf, debit, credit, fee, quantity));
        vm.prank(sequencer);
        exchange.clearBatch(batchId, 2, price, leaf, 1, debit, credit, fee, quantity, root);
        vm.prank(sequencer);
        exchange.commitBatch(batchId);
        vm.prank(sequencer);
        exchange.applyBatchMatch(batchId, 0, matched, new bytes32[](0));
        vm.prank(sequencer);
        exchange.finalizeBatch(batchId);
        assertEq(exchange.nextBatchSequence(marketId), 1);
        assertEq(exchange.lastFinalizedLedgerRoot(marketId), root);
        _assertSolvent();
    }

    function testFuzzRandomizedConsecutiveBatchSequences(uint8 rawSequences, uint8 rawLots) external {
        uint8 sequenceCount = uint8(bound(rawSequences, 1, 5));
        uint128 quantity = uint128(bound(rawLots, 1, 10)) * 10_000;
        vm.prank(seller);
        exchange.splitCompleteSet(marketId, UNIT);
        bytes32 priorRoot;

        for (uint64 sequence; sequence < sequenceCount; ++sequence) {
            uint64 price = uint64(300_000 + sequence * 50_000);
            ArenaExchange.Order memory buy =
                _order(buyer, true, 2, price, quantity, 1_000 + sequence, "sequence-buy");
            ArenaExchange.Order memory sell =
                _order(seller, false, 2, price, quantity, 2_000 + sequence, "sequence-sell");
            buy.clientOrderId = keccak256(abi.encode("sequence-buy", sequence));
            sell.clientOrderId = keccak256(abi.encode("sequence-sell", sequence));
            bytes32 buyHash = exchange.hashOrder(buy);
            bytes32 sellHash = exchange.hashOrder(sell);
            exchange.submitOrder(buy, _signature(buyerKey, buyHash));
            exchange.submitOrder(sell, _signature(sellerKey, sellHash));
            ArenaExchange.Match memory matched = ArenaExchange.Match(buyHash, sellHash, quantity);
            bytes32 commitment = keccak256(abi.encode("randomized-sequence", sequence, quantity));
            vm.prank(sequencer);
            exchange.publishDataCommitment(commitment);
            vm.roll(block.number + 1);
            vm.prank(sequencer);
            bytes32 batchId = exchange.openBatch(marketId, sequence, priorRoot, commitment);
            vm.prank(sequencer);
            exchange.sealBatch(batchId, keccak256(abi.encode("orders", sequence)));
            bytes32 leaf = _batchLeaf(batchId, 0, matched);
            uint256 debit = (uint256(quantity) * price + 999_999) / 1_000_000;
            uint256 quote = uint256(quantity) * price / 1_000_000;
            uint256 fee = quote * 50 / 10_000;
            uint256 credit = debit - fee;
            bytes32 ledgerRoot = keccak256(abi.encode(priorRoot, leaf, debit, credit, fee, quantity));
            vm.prank(sequencer);
            exchange.clearBatch(batchId, 2, price, leaf, 1, debit, credit, fee, quantity, ledgerRoot);
            vm.prank(sequencer);
            exchange.commitBatch(batchId);
            vm.prank(sequencer);
            exchange.applyBatchMatch(batchId, 0, matched, new bytes32[](0));
            vm.prank(sequencer);
            exchange.finalizeBatch(batchId);
            assertEq(exchange.nextBatchSequence(marketId), sequence + 1);
            assertEq(exchange.lastFinalizedLedgerRoot(marketId), ledgerRoot);
            _assertSolvent();
            priorRoot = ledgerRoot;
        }
    }

    function testAtomicFinalizationFailureAndPendingCollateralCannotBeWithdrawn() external {
        vm.prank(seller);
        exchange.splitCompleteSet(marketId, UNIT);
        ArenaExchange.Order memory buy = _order(buyer, true, 1, 500_000, UNIT, 801, "atomic-buy");
        ArenaExchange.Order memory sell = _order(seller, false, 1, 500_000, UNIT, 802, "atomic-sell");
        bytes32 buyHash = exchange.hashOrder(buy);
        bytes32 sellHash = exchange.hashOrder(sell);
        exchange.submitOrder(buy, _signature(buyerKey, buyHash));
        exchange.submitOrder(sell, _signature(sellerKey, sellHash));
        ArenaExchange.Match memory matched = ArenaExchange.Match(buyHash, sellHash, UNIT);

        bytes32 commitment = keccak256("atomic-commitment");
        vm.prank(sequencer);
        exchange.publishDataCommitment(commitment);
        vm.roll(block.number + 1);
        vm.prank(sequencer);
        bytes32 batchId = exchange.openBatch(marketId, 0, bytes32(0), commitment);
        vm.prank(sequencer);
        exchange.sealBatch(batchId, keccak256("atomic-orders"));
        bytes32 leaf = _batchLeaf(batchId, 0, matched);
        uint256 debit = 500_000;
        uint256 fee = 2_500;
        uint256 credit = debit - fee;
        vm.prank(sequencer);
        exchange.clearBatch(
            batchId,
            1,
            500_000,
            leaf,
            1,
            debit,
            credit,
            fee,
            UNIT,
            keccak256("intentionally-wrong-ledger-root")
        );
        vm.prank(sequencer);
        exchange.commitBatch(batchId);
        vm.prank(sequencer);
        exchange.applyBatchMatch(batchId, 0, matched, new bytes32[](0));

        vm.prank(buyer);
        vm.expectRevert(ArenaExchange.InvalidBatch.selector);
        exchange.claimBatchSettlement(batchId);
        uint256 buyerAvailable = exchange.availableCollateral(buyer);
        vm.prank(buyer);
        vm.expectRevert(ArenaExchange.InsufficientCollateral.selector);
        exchange.withdraw(buyerAvailable + 1, buyer);

        uint256 liabilitiesBefore = exchange.totalLiabilities();
        vm.prank(sequencer);
        vm.expectRevert(ArenaExchange.InvariantViolation.selector);
        exchange.finalizeBatch(batchId);
        assertEq(exchange.totalLiabilities(), liabilitiesBefore);
        assertEq(exchange.nextBatchSequence(marketId), 0);
        assertEq(exchange.activeBatchByMarket(marketId), batchId);
        assertEq(exchange.appliedBatchLeaves(batchId, 0), leaf);
        _assertSolvent();
    }

    function _batchLeaf(bytes32 batchId, uint32 index, ArenaExchange.Match memory matched)
        private
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(batchId, index, matched.buyOrderHash, matched.sellOrderHash, matched.quantity)
        );
    }

    function _hashPair(bytes32 a, bytes32 b) private pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }
}

contract ArenaExchangeDay18Test is ArenaExchangeTestBase {
    function testSelfAssertedOutcomeWithoutBoundEvidenceReverts() external {
        vm.warp(block.timestamp + 1 days + 2);
        uint64 now_ = uint64(block.timestamp);
        IArenaResolutionVerifier.ResolutionReport memory primary =
            _report(keccak256("txline-primary"), 2, now_ - 1, now_, true, keccak256("self-asserted"));
        IArenaResolutionVerifier.ResolutionReport memory witness = _report(
            keccak256("approved-result-witness"), 2, now_ - 1, now_, true, keccak256("also-unproven")
        );
        vm.prank(resolver);
        vm.expectRevert(ArenaResolutionVerifier.InvalidEvidenceSignature.selector);
        exchange.resolveMarket(marketId, primary, witness);
        (,,,,, ArenaExchange.MarketStatus status,) = exchange.markets(marketId);
        assertEq(uint8(status), uint8(ArenaExchange.MarketStatus.OPEN));
    }

    function testResolutionRequiresEveryEvidenceCheckAndStoresReplayData() external {
        vm.warp(block.timestamp + 1 days + 2);
        (
            IArenaResolutionVerifier.ResolutionReport memory primary,
            IArenaResolutionVerifier.ResolutionReport memory witness
        ) = _freshReports(marketId, specHash, 2);
        vm.prank(resolver);
        exchange.resolveMarket(marketId, primary, witness);
        (,,,,, ArenaExchange.MarketStatus status, uint8 winner) = exchange.markets(marketId);
        assertEq(uint8(status), uint8(ArenaExchange.MarketStatus.RESOLVED));
        assertEq(winner, 2);
        (,, bytes32 rawPayloadHash, bytes32 digest,,,,) = exchange.normalizedResolutionReports(marketId, 0);
        assertEq(rawPayloadHash, keccak256("raw-primary"));
        assertTrue(exchange.usedResolutionReports(digest));
    }

    function testDivergentAndStaleAuthenticatedSourcesInvalidateNeverSelectWinner() external {
        bytes32 staleMarket = keccak256("stale-market");
        bytes32 staleSpec = keccak256("stale-spec");
        _createMarket(staleMarket, staleSpec);
        vm.warp(block.timestamp + 1 days + 2);
        uint64 now_ = uint64(block.timestamp);
        (
            IArenaResolutionVerifier.ResolutionReport memory primary,
            IArenaResolutionVerifier.ResolutionReport memory witness
        ) = _freshReports(marketId, specHash, 0);
        witness.normalizedOutcome = 2;
        witness = _signReport(marketId, specHash, witness, witnessKey);
        vm.prank(resolver);
        exchange.resolveMarket(marketId, primary, witness);
        (,,,,, ArenaExchange.MarketStatus divergentStatus,) = exchange.markets(marketId);
        assertEq(uint8(divergentStatus), uint8(ArenaExchange.MarketStatus.INVALID));

        now_ = uint64(block.timestamp);
        primary = _report(
            keccak256("txline-primary"), 1, now_ - 122, now_ - 121, true, keccak256("stale-primary")
        );
        witness = _report(
            keccak256("approved-result-witness"), 1, now_ - 122, now_ - 121, true, keccak256("stale-witness")
        );
        primary = _signReport(staleMarket, staleSpec, primary, primaryKey);
        witness = _signReport(staleMarket, staleSpec, witness, witnessKey);
        vm.prank(resolver);
        exchange.resolveMarket(staleMarket, primary, witness);
        (,,,,, ArenaExchange.MarketStatus staleStatus,) = exchange.markets(staleMarket);
        assertEq(uint8(staleStatus), uint8(ArenaExchange.MarketStatus.INVALID));
    }

    function testIdentityFinalitySkewRangeAndGraceChecksFailClosed() external {
        bytes32 identityMarket = keccak256("identity-market");
        bytes32 identitySpec = keccak256("identity-spec");
        bytes32 finalityMarket = keccak256("finality-market");
        bytes32 finalitySpec = keccak256("finality-spec");
        bytes32 skewMarket = keccak256("skew-market");
        bytes32 skewSpec = keccak256("skew-spec");
        bytes32 rangeMarket = keccak256("range-market");
        bytes32 rangeSpec = keccak256("range-spec");
        bytes32 lateMarket = keccak256("late-market");
        bytes32 lateSpec = keccak256("late-spec");
        _createMarket(identityMarket, identitySpec);
        _createMarket(finalityMarket, finalitySpec);
        _createMarket(skewMarket, skewSpec);
        _createMarket(rangeMarket, rangeSpec);
        _createMarket(lateMarket, lateSpec);
        vm.warp(block.timestamp + 1 days + 2);
        uint64 now_ = uint64(block.timestamp);
        IArenaResolutionVerifier.ResolutionReport memory primary =
            _report(keccak256("wrong-source"), 0, now_ - 1, now_, true, keccak256("wrong-source-raw"));
        IArenaResolutionVerifier.ResolutionReport memory witness = _report(
            keccak256("approved-result-witness"), 0, now_ - 1, now_, true, keccak256("identity-witness")
        );
        primary = _signReport(identityMarket, identitySpec, primary, primaryKey);
        witness = _signReport(identityMarket, identitySpec, witness, witnessKey);
        vm.prank(resolver);
        vm.expectRevert(ArenaResolutionVerifier.InvalidEvidenceIdentity.selector);
        exchange.resolveMarket(identityMarket, primary, witness);

        primary =
            _report(keccak256("txline-primary"), 1, now_ - 1, now_, false, keccak256("non-final-primary"));
        witness = _report(
            keccak256("approved-result-witness"), 1, now_ - 1, now_, true, keccak256("final-witness")
        );
        primary = _signReport(finalityMarket, finalitySpec, primary, primaryKey);
        witness = _signReport(finalityMarket, finalitySpec, witness, witnessKey);
        vm.prank(resolver);
        exchange.resolveMarket(finalityMarket, primary, witness);
        (,,,,, ArenaExchange.MarketStatus finalityStatus,) = exchange.markets(finalityMarket);
        assertEq(uint8(finalityStatus), uint8(ArenaExchange.MarketStatus.INVALID));

        primary =
            _report(keccak256("txline-primary"), 1, now_ - 40, now_ - 40, true, keccak256("skew-primary"));
        witness = _report(
            keccak256("approved-result-witness"), 1, now_ - 1, now_, true, keccak256("skew-witness")
        );
        primary = _signReport(skewMarket, skewSpec, primary, primaryKey);
        witness = _signReport(skewMarket, skewSpec, witness, witnessKey);
        vm.prank(resolver);
        exchange.resolveMarket(skewMarket, primary, witness);
        (,,,,, ArenaExchange.MarketStatus skewStatus,) = exchange.markets(skewMarket);
        assertEq(uint8(skewStatus), uint8(ArenaExchange.MarketStatus.INVALID));

        primary = _report(keccak256("txline-primary"), 3, now_ - 1, now_, true, keccak256("range-primary"));
        witness = _report(
            keccak256("approved-result-witness"), 3, now_ - 1, now_, true, keccak256("range-witness")
        );
        primary = _signReport(rangeMarket, rangeSpec, primary, primaryKey);
        witness = _signReport(rangeMarket, rangeSpec, witness, witnessKey);
        vm.prank(resolver);
        exchange.resolveMarket(rangeMarket, primary, witness);
        (,,,,, ArenaExchange.MarketStatus rangeStatus,) = exchange.markets(rangeMarket);
        assertEq(uint8(rangeStatus), uint8(ArenaExchange.MarketStatus.INVALID));

        vm.warp(block.timestamp + 899);
        now_ = uint64(block.timestamp);
        primary = _report(keccak256("txline-primary"), 2, now_ - 1, now_, true, keccak256("late-primary"));
        witness = _report(
            keccak256("approved-result-witness"), 2, now_ - 1, now_, true, keccak256("late-witness")
        );
        primary = _signReport(lateMarket, lateSpec, primary, primaryKey);
        witness = _signReport(lateMarket, lateSpec, witness, witnessKey);
        vm.prank(resolver);
        exchange.resolveMarket(lateMarket, primary, witness);
        (,,,,, ArenaExchange.MarketStatus lateStatus,) = exchange.markets(lateMarket);
        assertEq(uint8(lateStatus), uint8(ArenaExchange.MarketStatus.INVALID));
    }

    function testGraceExpiryInvalidationAndEqualPayoutDustAreDeterministic() external {
        vm.prank(seller);
        exchange.splitCompleteSet(marketId, 3 * UNIT);
        ArenaExchange.Order memory buy = _order(buyer, true, 1, 500_000, UNIT, 901, "invalid-buy");
        ArenaExchange.Order memory sell = _order(seller, false, 1, 500_000, UNIT, 902, "invalid-sell");
        bytes32 buyHash = exchange.hashOrder(buy);
        bytes32 sellHash = exchange.hashOrder(sell);
        exchange.submitOrder(buy, _signature(buyerKey, buyHash));
        exchange.submitOrder(sell, _signature(sellerKey, sellHash));
        ArenaExchange.Match[] memory matches_ = new ArenaExchange.Match[](1);
        matches_[0] = ArenaExchange.Match(buyHash, sellHash, UNIT);
        _publishLegacyBatch(marketId, 1, 500_000, matches_);
        vm.prank(sequencer);
        exchange.executeBatch(marketId, 1, 500_000, matches_);

        vm.warp(block.timestamp + 1 days + 900);
        exchange.invalidateAfterGrace(marketId);
        uint256 sellerBefore = exchange.availableCollateral(seller);
        uint256 buyerBefore = exchange.availableCollateral(buyer);
        vm.prank(seller);
        exchange.redeem(marketId);
        vm.prank(buyer);
        exchange.redeem(marketId);
        assertEq(exchange.availableCollateral(seller) - sellerBefore, 2_666_666);
        assertEq(exchange.availableCollateral(buyer) - buyerBefore, 333_333);
        assertEq(exchange.accruedProtocolDust(), 1);
        assertEq(exchange.marketCollateral(marketId), 0);
        _assertSolvent();
    }
}
