// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { ArenaExchange } from "../src/ArenaExchange.sol";
import { MockUSDC } from "../src/MockUSDC.sol";

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
