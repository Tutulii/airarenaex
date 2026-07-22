// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script, console2 } from "forge-std/Script.sol";
import { ArenaExchange } from "../src/ArenaExchange.sol";

interface IPreviousArenaExchange {
    function collateral() external view returns (address);
    function ORDER_TYPEHASH() external view returns (bytes32);
}

/// @notice Deploys the non-upgradeable signed-cancellation release on ARC Testnet.
/// @dev Every authority is explicit. The previous exchange remains deployed for exits and redemption.
contract DeployArenaExchangeV2 is Script {
    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5_042_002;
    address internal constant ARC_TESTNET_USDC = 0x3600000000000000000000000000000000000000;
    bytes32 internal constant EXPECTED_ORDER_TYPEHASH = keccak256(
        "Order(address maker,bytes32 marketId,uint8 outcome,bool isBuy,uint64 pricePpm,uint128 quantity,uint64 expiry,uint256 nonce,bytes32 clientOrderId)"
    );

    function run() external returns (ArenaExchange exchange) {
        require(block.chainid == ARC_TESTNET_CHAIN_ID, "wrong deployment chain");
        address previous = vm.envAddress("ARC_PREVIOUS_EXCHANGE_ADDRESS");
        require(previous.code.length != 0, "previous exchange has no code");
        require(
            IPreviousArenaExchange(previous).collateral() == ARC_TESTNET_USDC, "previous collateral mismatch"
        );
        require(
            IPreviousArenaExchange(previous).ORDER_TYPEHASH() == EXPECTED_ORDER_TYPEHASH,
            "previous order format mismatch"
        );

        uint256 privateKey = vm.envUint("ARC_DEPLOYER_PRIVATE_KEY");
        address admin = vm.envAddress("ARC_ADMIN_ADDRESS");
        address marketAdmin = vm.envAddress("ARC_MARKET_ADMIN_ADDRESS");
        address matcher = vm.envAddress("ARC_MATCHER_ADDRESS");
        address resolver = vm.envAddress("ARC_RESOLVER_ADDRESS");
        address pauser = vm.envAddress("ARC_PAUSER_ADDRESS");
        address feeWithdrawer = vm.envAddress("ARC_FEE_WITHDRAWER_ADDRESS");
        uint16 feeBps = uint16(vm.envUint("ARC_FEE_BPS"));

        vm.startBroadcast(privateKey);
        exchange = new ArenaExchange(
            ARC_TESTNET_USDC, admin, marketAdmin, matcher, resolver, pauser, feeWithdrawer, feeBps
        );
        vm.stopBroadcast();

        require(address(exchange) != previous, "deployment address unchanged");
        require(address(exchange.collateral()) == ARC_TESTNET_USDC, "new collateral mismatch");
        require(exchange.ORDER_TYPEHASH() == EXPECTED_ORDER_TYPEHASH, "new order format mismatch");
        require(exchange.CANCEL_TYPEHASH() != bytes32(0), "cancellation format missing");
        require(exchange.hasRole(exchange.DEFAULT_ADMIN_ROLE(), admin), "admin role mismatch");
        require(exchange.hasRole(exchange.MARKET_ADMIN_ROLE(), marketAdmin), "market role mismatch");
        require(exchange.hasRole(exchange.MATCHER_ROLE(), matcher), "matcher role mismatch");
        require(exchange.hasRole(exchange.RESOLVER_ROLE(), resolver), "resolver role mismatch");
        require(exchange.hasRole(exchange.PAUSER_ROLE(), pauser), "pauser role mismatch");
        require(exchange.hasRole(exchange.FEE_WITHDRAWER_ROLE(), feeWithdrawer), "fee role mismatch");
        require(exchange.feeBps() == feeBps, "fee mismatch");

        console2.log("Previous ArenaExchange", previous);
        console2.log("New ArenaExchange", address(exchange));
        console2.log("Chain ID", block.chainid);
        console2.logBytes32(exchange.ORDER_TYPEHASH());
        console2.logBytes32(exchange.CANCEL_TYPEHASH());
    }
}
