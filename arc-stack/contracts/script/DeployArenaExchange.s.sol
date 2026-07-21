// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script, console2 } from "forge-std/Script.sol";
import { ArenaExchange } from "../src/ArenaExchange.sol";

contract DeployArenaExchange is Script {
    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5_042_002;
    address internal constant ARC_TESTNET_USDC = 0x3600000000000000000000000000000000000000;

    function run() external returns (ArenaExchange exchange) {
        require(block.chainid == ARC_TESTNET_CHAIN_ID, "wrong deployment chain");
        uint256 privateKey = vm.envUint("ARC_DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(privateKey);
        address admin = vm.envOr("ARC_ADMIN_ADDRESS", deployer);
        address marketAdmin = vm.envOr("ARC_MARKET_ADMIN_ADDRESS", deployer);
        address matcher = vm.envOr("ARC_MATCHER_ADDRESS", deployer);
        address resolver = vm.envOr("ARC_RESOLVER_ADDRESS", deployer);
        address pauser = vm.envOr("ARC_PAUSER_ADDRESS", deployer);
        address feeWithdrawer = vm.envOr("ARC_FEE_WITHDRAWER_ADDRESS", deployer);
        uint16 feeBps = uint16(vm.envOr("ARC_FEE_BPS", uint256(50)));

        vm.startBroadcast(privateKey);
        exchange = new ArenaExchange(
            ARC_TESTNET_USDC, admin, marketAdmin, matcher, resolver, pauser, feeWithdrawer, feeBps
        );
        vm.stopBroadcast();

        console2.log("ArenaExchange", address(exchange));
        console2.log("Deployer", deployer);
        console2.log("Chain ID", block.chainid);
    }
}
