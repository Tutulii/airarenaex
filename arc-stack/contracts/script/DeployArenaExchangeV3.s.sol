// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script, console2 } from "forge-std/Script.sol";
import { ArenaExchange } from "../src/ArenaExchange.sol";
import { ArenaResolutionVerifier } from "../src/ArenaResolutionVerifier.sol";

interface IPreviousArenaExchange {
    function collateral() external view returns (address);
    function ORDER_TYPEHASH() external view returns (bytes32);
}

/// @notice Deploys the frozen evidence-bound exchange release on ARC Testnet.
/// @dev The previous non-upgradeable exchange remains deployed for exits and redemption.
contract DeployArenaExchangeV3 is Script {
    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5_042_002;
    address internal constant ARC_TESTNET_USDC = 0x3600000000000000000000000000000000000000;
    bytes32 internal constant EXPECTED_ORDER_TYPEHASH = keccak256(
        "Order(address maker,bytes32 marketId,uint8 outcome,bool isBuy,uint64 pricePpm,uint128 quantity,uint64 expiry,uint256 nonce,bytes32 clientOrderId)"
    );

    function run() external returns (ArenaResolutionVerifier verifier, ArenaExchange exchange) {
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
        address sequencer = vm.envAddress("ARC_SEQUENCER_ADDRESS");
        address resolver = vm.envAddress("ARC_RESOLVER_ADDRESS");
        address protocolLiquidity = vm.envAddress("ARC_PROTOCOL_LIQUIDITY_ADDRESS");
        address emergencyPauser = vm.envAddress("ARC_EMERGENCY_PAUSER_ADDRESS");
        address upgradeMultisig = vm.envAddress("ARC_UPGRADE_MULTISIG_ADDRESS");
        uint16 feeBps = uint16(vm.envUint("ARC_FEE_BPS"));

        vm.startBroadcast(privateKey);
        verifier = new ArenaResolutionVerifier();
        exchange = new ArenaExchange(
            sequencer,
            resolver,
            protocolLiquidity,
            emergencyPauser,
            upgradeMultisig,
            address(verifier),
            feeBps
        );
        vm.stopBroadcast();

        require(address(exchange) != previous, "deployment address unchanged");
        require(address(exchange.collateral()) == ARC_TESTNET_USDC, "new collateral mismatch");
        require(exchange.ARC_CHAIN_ID() == ARC_TESTNET_CHAIN_ID, "chain constant mismatch");
        require(exchange.COLLATERAL_DECIMALS() == 6, "collateral decimals mismatch");
        require(exchange.ORDER_TYPEHASH() == EXPECTED_ORDER_TYPEHASH, "new order format mismatch");
        require(exchange.CANCEL_TYPEHASH() != bytes32(0), "cancellation format missing");
        require(exchange.hasRole(exchange.SEQUENCER_ROLE(), sequencer), "sequencer role mismatch");
        require(exchange.hasRole(exchange.RESOLVER_ROLE(), resolver), "resolver role mismatch");
        require(
            exchange.hasRole(exchange.PROTOCOL_LIQUIDITY_ROLE(), protocolLiquidity), "liquidity role mismatch"
        );
        require(exchange.hasRole(exchange.EMERGENCY_PAUSER_ROLE(), emergencyPauser), "pauser role mismatch");
        require(exchange.hasRole(exchange.UPGRADE_MULTISIG_ROLE(), upgradeMultisig), "upgrade role mismatch");
        require(exchange.feeBps() == feeBps, "fee mismatch");

        console2.log("Previous ArenaExchange", previous);
        console2.log("ArenaResolutionVerifier", address(verifier));
        console2.log("ArenaExchange V3", address(exchange));
        console2.log("Chain ID", block.chainid);
        console2.logBytes32(exchange.ORDER_TYPEHASH());
        console2.logBytes32(exchange.CANCEL_TYPEHASH());
    }
}
