// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { ArenaExchange } from "../src/ArenaExchange.sol";
import { MockUSDC } from "../src/MockUSDC.sol";
import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract Mock1271Wallet is IERC1271 {
    using ECDSA for bytes32;

    bytes4 internal constant MAGIC_VALUE = IERC1271.isValidSignature.selector;
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
        return MAGIC_VALUE;
    }
}

contract ArenaExchangeTest is Test {
    uint128 internal constant UNIT = 1e6;
    uint256 internal buyerKey = 0xB0B;
    uint256 internal sellerKey = 0xA11CE;
    address internal buyer;
    address internal seller;
    address internal matcher = makeAddr("matcher");
    address internal resolver = makeAddr("resolver");
    bytes32 internal marketId = keccak256("txline:france-england");

    MockUSDC internal usdc;
    ArenaExchange internal exchange;

    function setUp() external {
        buyer = vm.addr(buyerKey);
        seller = vm.addr(sellerKey);
        usdc = new MockUSDC();
        exchange = new ArenaExchange(
            address(usdc), address(this), address(this), matcher, resolver, address(this), address(this), 50
        );

        usdc.mint(buyer, 100 * UNIT);
        usdc.mint(seller, 100 * UNIT);
        _deposit(buyer, 100 * UNIT);
        _deposit(seller, 100 * UNIT);
        exchange.createMarket(marketId, keccak256("france-england"), 3, uint64(block.timestamp + 1 days));
    }

    function testCompleteLifecycleConservesCollateral() external {
        vm.prank(seller);
        exchange.splitCompleteSet(marketId, 10 * UNIT);

        ArenaExchange.Order memory buy = _order(buyer, true, 1, 600_000, 10 * UNIT, 1, "buy-1");
        ArenaExchange.Order memory sell = _order(seller, false, 1, 550_000, 10 * UNIT, 2, "sell-1");
        bytes32 buyHash = exchange.hashOrder(buy);
        bytes32 sellHash = exchange.hashOrder(sell);

        exchange.submitOrder(buy, _signature(buyerKey, buyHash));
        exchange.submitOrder(sell, _signature(sellerKey, sellHash));

        ArenaExchange.Match[] memory matches_ = new ArenaExchange.Match[](1);
        matches_[0] =
            ArenaExchange.Match({ buyOrderHash: buyHash, sellOrderHash: sellHash, quantity: 10 * UNIT });
        vm.prank(matcher);
        exchange.executeBatch(marketId, 1, 575_000, matches_);

        assertEq(exchange.positions(marketId, 1, buyer), 10 * UNIT);
        assertEq(exchange.positions(marketId, 1, seller), 0);
        assertTrue(exchange.isSolvent());
        assertEq(usdc.balanceOf(address(exchange)), exchange.totalLiabilities());

        vm.warp(block.timestamp + 1 days);
        vm.prank(resolver);
        exchange.resolveMarket(marketId, 1);
        vm.prank(buyer);
        exchange.redeem(marketId);

        assertEq(exchange.availableCollateral(buyer), 104_250_000);
        assertTrue(exchange.isSolvent());
        assertEq(usdc.balanceOf(address(exchange)), exchange.totalLiabilities());
    }

    function testRejectsReplayAndInvalidSignature() external {
        ArenaExchange.Order memory buy = _order(buyer, true, 0, 500_000, UNIT, 7, "buy-replay");
        bytes32 orderHash = exchange.hashOrder(buy);
        bytes memory signature = _signature(buyerKey, orderHash);
        exchange.submitOrder(buy, signature);

        vm.expectRevert(ArenaExchange.NonceAlreadyUsed.selector);
        exchange.submitOrder(buy, signature);

        ArenaExchange.Order memory forged = _order(buyer, true, 0, 500_000, UNIT, 8, "forged");
        bytes memory forgedSignature = _signature(sellerKey, exchange.hashOrder(forged));
        vm.expectRevert(ArenaExchange.InvalidSignature.selector);
        exchange.submitOrder(forged, forgedSignature);
    }

    function testPauseStopsRiskCreationButAllowsWithdrawalAndCancellation() external {
        ArenaExchange.Order memory buy = _order(buyer, true, 0, 500_000, UNIT, 9, "buy-pause");
        bytes32 orderHash = exchange.hashOrder(buy);
        exchange.submitOrder(buy, _signature(buyerKey, orderHash));
        exchange.pause();

        ArenaExchange.Order memory blocked = _order(buyer, true, 0, 500_000, UNIT, 10, "blocked");
        bytes memory blockedSignature = _signature(buyerKey, exchange.hashOrder(blocked));
        vm.expectRevert();
        exchange.submitOrder(blocked, blockedSignature);

        vm.prank(buyer);
        exchange.cancelOrder(orderHash);
        vm.prank(buyer);
        exchange.withdraw(UNIT, buyer);
        assertTrue(exchange.isSolvent());
    }

    function testRelayedCancellationSupportsEoaAndSeparateNonceNamespace() external {
        ArenaExchange.Order memory buy = _order(buyer, true, 0, 500_000, UNIT, 17, "buy-cancel");
        bytes32 orderHash = exchange.hashOrder(buy);
        exchange.submitOrder(buy, _signature(buyerKey, orderHash));

        ArenaExchange.Cancel memory cancellation = ArenaExchange.Cancel({
            maker: buyer, orderHash: orderHash, nonce: 17, deadline: uint64(block.timestamp + 10 minutes)
        });
        bytes memory cancelSignature = _signature(buyerKey, exchange.hashCancel(cancellation));
        exchange.cancelOrderBySig(cancellation, cancelSignature);

        assertTrue(exchange.usedNonces(buyer, 17));
        assertTrue(exchange.usedCancellationNonces(buyer, 17));
        assertEq(uint8(exchange.getOrder(orderHash).status), uint8(ArenaExchange.OrderStatus.CANCELLED));

        vm.expectRevert(ArenaExchange.NonceAlreadyUsed.selector);
        exchange.cancelOrderBySig(cancellation, cancelSignature);
    }

    function testRelayedCancellationWorksDuringPause() external {
        ArenaExchange.Order memory buy = _order(buyer, true, 0, 500_000, UNIT, 18, "paused-cancel");
        bytes32 orderHash = exchange.hashOrder(buy);
        exchange.submitOrder(buy, _signature(buyerKey, orderHash));
        exchange.pause();

        ArenaExchange.Cancel memory cancellation = ArenaExchange.Cancel({
            maker: buyer, orderHash: orderHash, nonce: 1, deadline: uint64(block.timestamp + 10 minutes)
        });
        exchange.cancelOrderBySig(cancellation, _signature(buyerKey, exchange.hashCancel(cancellation)));
        assertEq(uint8(exchange.getOrder(orderHash).status), uint8(ArenaExchange.OrderStatus.CANCELLED));
    }

    function testRelayedCancellationRejectsExpiredWrongMakerAndForgedSignature() external {
        ArenaExchange.Order memory buy = _order(buyer, true, 0, 500_000, UNIT, 19, "invalid-cancel");
        bytes32 orderHash = exchange.hashOrder(buy);
        exchange.submitOrder(buy, _signature(buyerKey, orderHash));

        ArenaExchange.Cancel memory expired = ArenaExchange.Cancel({
            maker: buyer, orderHash: orderHash, nonce: 1, deadline: uint64(block.timestamp - 1)
        });
        bytes memory expiredSignature = _signature(buyerKey, exchange.hashCancel(expired));
        vm.expectRevert(ArenaExchange.InvalidOrder.selector);
        exchange.cancelOrderBySig(expired, expiredSignature);

        ArenaExchange.Cancel memory wrongMaker = ArenaExchange.Cancel({
            maker: seller, orderHash: orderHash, nonce: 1, deadline: uint64(block.timestamp + 10 minutes)
        });
        bytes memory wrongMakerSignature = _signature(sellerKey, exchange.hashCancel(wrongMaker));
        vm.expectRevert(ArenaExchange.NotOrderMaker.selector);
        exchange.cancelOrderBySig(wrongMaker, wrongMakerSignature);

        ArenaExchange.Cancel memory forged = ArenaExchange.Cancel({
            maker: buyer, orderHash: orderHash, nonce: 2, deadline: uint64(block.timestamp + 10 minutes)
        });
        bytes memory forgedSignature = _signature(sellerKey, exchange.hashCancel(forged));
        vm.expectRevert(ArenaExchange.InvalidSignature.selector);
        exchange.cancelOrderBySig(forged, forgedSignature);
    }

    function testErc1271OrderAndCancellation() external {
        uint256 ownerKey = 0xC0FFEE;
        address owner = vm.addr(ownerKey);
        Mock1271Wallet wallet = new Mock1271Wallet(owner);
        usdc.mint(address(wallet), 10 * UNIT);

        vm.startPrank(owner);
        wallet.execute(address(usdc), abi.encodeCall(usdc.approve, (address(exchange), 10 * UNIT)));
        wallet.execute(address(exchange), abi.encodeCall(exchange.deposit, (10 * UNIT)));
        vm.stopPrank();

        ArenaExchange.Order memory buy = _order(address(wallet), true, 0, 500_000, UNIT, 1, "1271-order");
        bytes32 orderHash = exchange.hashOrder(buy);
        exchange.submitOrder(buy, _signature(ownerKey, orderHash));

        ArenaExchange.Cancel memory cancellation = ArenaExchange.Cancel({
            maker: address(wallet),
            orderHash: orderHash,
            nonce: 1,
            deadline: uint64(block.timestamp + 10 minutes)
        });
        exchange.cancelOrderBySig(cancellation, _signature(ownerKey, exchange.hashCancel(cancellation)));
        assertEq(uint8(exchange.getOrder(orderHash).status), uint8(ArenaExchange.OrderStatus.CANCELLED));
    }

    function testErc1271InvalidAndRevertingWalletsFailClosed() external {
        uint256 ownerKey = 0xD00D;
        address owner = vm.addr(ownerKey);
        Mock1271Wallet wallet = new Mock1271Wallet(owner);
        usdc.mint(address(wallet), 10 * UNIT);
        vm.startPrank(owner);
        wallet.execute(address(usdc), abi.encodeCall(usdc.approve, (address(exchange), 10 * UNIT)));
        wallet.execute(address(exchange), abi.encodeCall(exchange.deposit, (10 * UNIT)));
        wallet.configure(true, false);
        vm.stopPrank();

        ArenaExchange.Order memory rejected =
            _order(address(wallet), true, 0, 500_000, UNIT, 1, "1271-reject");
        bytes memory rejectedSignature = _signature(ownerKey, exchange.hashOrder(rejected));
        vm.expectRevert(ArenaExchange.InvalidSignature.selector);
        exchange.submitOrder(rejected, rejectedSignature);

        vm.prank(owner);
        wallet.configure(false, true);
        ArenaExchange.Order memory reverting =
            _order(address(wallet), true, 0, 500_000, UNIT, 2, "1271-revert");
        bytes memory revertingSignature = _signature(ownerKey, exchange.hashOrder(reverting));
        vm.expectRevert(ArenaExchange.InvalidSignature.selector);
        exchange.submitOrder(reverting, revertingSignature);
    }

    function testBatchRejectsSameMakerSelfTrade() external {
        vm.prank(seller);
        exchange.splitCompleteSet(marketId, 2 * UNIT);

        ArenaExchange.Order memory buy = _order(seller, true, 0, 600_000, UNIT, 31, "self-buy");
        ArenaExchange.Order memory sell = _order(seller, false, 0, 400_000, UNIT, 32, "self-sell");
        bytes32 buyHash = exchange.hashOrder(buy);
        bytes32 sellHash = exchange.hashOrder(sell);
        exchange.submitOrder(buy, _signature(sellerKey, buyHash));
        exchange.submitOrder(sell, _signature(sellerKey, sellHash));

        ArenaExchange.Match[] memory matches_ = new ArenaExchange.Match[](1);
        matches_[0] = ArenaExchange.Match({ buyOrderHash: buyHash, sellOrderHash: sellHash, quantity: UNIT });
        vm.prank(matcher);
        vm.expectRevert(ArenaExchange.InvalidMatch.selector);
        exchange.executeBatch(marketId, 0, 500_000, matches_);
    }

    function testAtomicUniformPriceMultiOrderBatch() external {
        vm.prank(seller);
        exchange.splitCompleteSet(marketId, 6 * UNIT);

        ArenaExchange.Order[3] memory buys;
        ArenaExchange.Order[2] memory sells;
        bytes32[3] memory buyHashes;
        bytes32[2] memory sellHashes;
        buys[0] = _order(buyer, true, 0, 600_000, 2 * UNIT, 41, "batch-buy-1");
        buys[1] = _order(buyer, true, 0, 550_000, 2 * UNIT, 42, "batch-buy-2");
        buys[2] = _order(buyer, true, 0, 550_000, 2 * UNIT, 43, "batch-buy-3");
        sells[0] = _order(seller, false, 0, 400_000, 3 * UNIT, 44, "batch-sell-1");
        sells[1] = _order(seller, false, 0, 500_000, 3 * UNIT, 45, "batch-sell-2");

        for (uint256 index = 0; index < buys.length; ++index) {
            buyHashes[index] = exchange.hashOrder(buys[index]);
            exchange.submitOrder(buys[index], _signature(buyerKey, buyHashes[index]));
        }
        for (uint256 index = 0; index < sells.length; ++index) {
            sellHashes[index] = exchange.hashOrder(sells[index]);
            exchange.submitOrder(sells[index], _signature(sellerKey, sellHashes[index]));
        }

        ArenaExchange.Match[] memory matches_ = new ArenaExchange.Match[](4);
        matches_[0] = ArenaExchange.Match({
            buyOrderHash: buyHashes[0], sellOrderHash: sellHashes[0], quantity: 2 * UNIT
        });
        matches_[1] =
            ArenaExchange.Match({ buyOrderHash: buyHashes[1], sellOrderHash: sellHashes[0], quantity: UNIT });
        matches_[2] =
            ArenaExchange.Match({ buyOrderHash: buyHashes[1], sellOrderHash: sellHashes[1], quantity: UNIT });
        matches_[3] = ArenaExchange.Match({
            buyOrderHash: buyHashes[2], sellOrderHash: sellHashes[1], quantity: 2 * UNIT
        });

        vm.prank(matcher);
        exchange.executeBatch(marketId, 0, 525_000, matches_);

        assertEq(exchange.positions(marketId, 0, buyer), 6 * UNIT);
        assertEq(exchange.positions(marketId, 0, seller), 0);
        assertTrue(exchange.isSolvent());
        assertEq(usdc.balanceOf(address(exchange)), exchange.totalLiabilities());
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
        assertTrue(exchange.isSolvent());
    }

    function testFuzzPartialBatchNeverOverfillsOrCreatesNegativeAccounting(
        uint16 rawBuyLots,
        uint16 rawSellLots,
        uint32 rawPrice
    ) external {
        uint128 lot = 10_000;
        uint128 buyQuantity = uint128(bound(uint256(rawBuyLots), 1, 2_000)) * lot;
        uint128 sellQuantity = uint128(bound(uint256(rawSellLots), 1, 2_000)) * lot;
        uint128 fillQuantity = buyQuantity < sellQuantity ? buyQuantity : sellQuantity;
        // A one-lot fill must produce at least one six-decimal collateral atom.
        uint64 price = uint64(bound(uint256(rawPrice), 100, 999_999));

        vm.prank(seller);
        exchange.splitCompleteSet(marketId, 20 * UNIT);

        ArenaExchange.Order memory buy = _order(buyer, true, 2, price, buyQuantity, 81, "fuzz-partial-buy");
        ArenaExchange.Order memory sell =
            _order(seller, false, 2, price, sellQuantity, 82, "fuzz-partial-sell");
        bytes32 buyHash = exchange.hashOrder(buy);
        bytes32 sellHash = exchange.hashOrder(sell);
        exchange.submitOrder(buy, _signature(buyerKey, buyHash));
        exchange.submitOrder(sell, _signature(sellerKey, sellHash));

        ArenaExchange.Match[] memory matches_ = new ArenaExchange.Match[](1);
        matches_[0] =
            ArenaExchange.Match({ buyOrderHash: buyHash, sellOrderHash: sellHash, quantity: fillQuantity });
        vm.prank(matcher);
        exchange.executeBatch(marketId, 2, price, matches_);

        ArenaExchange.StoredOrder memory storedBuy = exchange.getOrder(buyHash);
        ArenaExchange.StoredOrder memory storedSell = exchange.getOrder(sellHash);
        assertEq(storedBuy.filledQuantity, fillQuantity);
        assertEq(storedSell.filledQuantity, fillQuantity);
        assertLe(storedBuy.filledQuantity, storedBuy.order.quantity);
        assertLe(storedSell.filledQuantity, storedSell.order.quantity);
        assertEq(exchange.positions(marketId, 2, buyer), fillQuantity);
        assertEq(usdc.balanceOf(address(exchange)), exchange.totalLiabilities());
        assertTrue(exchange.isSolvent());
    }

    function _deposit(address account, uint256 amount) internal {
        vm.startPrank(account);
        usdc.approve(address(exchange), amount);
        exchange.deposit(amount);
        vm.stopPrank();
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
}
