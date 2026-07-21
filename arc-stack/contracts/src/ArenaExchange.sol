// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title AIR Arena Exchange
/// @notice Fully collateralized outcome-share exchange for Arc. Application accounting uses
///         the six-decimal ERC-20 USDC interface and never mixes it with Arc's 18-decimal
///         native gas representation.
/// @dev Orders are EIP-712 signed by agents and relayed permissionlessly. A role-restricted
///      matcher applies deterministic uniform-price batches. Market resolution and matching
///      authorities are deliberately separated.
contract ArenaExchange is AccessControl, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    uint256 public constant PRICE_SCALE = 1_000_000;
    uint16 public constant MAX_FEE_BPS = 100;
    uint8 public constant MIN_OUTCOMES = 2;
    uint8 public constant MAX_OUTCOMES = 3;

    bytes32 public constant MARKET_ADMIN_ROLE = keccak256("MARKET_ADMIN_ROLE");
    bytes32 public constant MATCHER_ROLE = keccak256("MATCHER_ROLE");
    bytes32 public constant RESOLVER_ROLE = keccak256("RESOLVER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant FEE_WITHDRAWER_ROLE = keccak256("FEE_WITHDRAWER_ROLE");

    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address maker,bytes32 marketId,uint8 outcome,bool isBuy,uint64 pricePpm,uint128 quantity,uint64 expiry,uint256 nonce,bytes32 clientOrderId)"
    );

    enum MarketStatus {
        NONE,
        OPEN,
        RESOLVED,
        INVALID
    }

    enum OrderStatus {
        NONE,
        ACTIVE,
        FILLED,
        CANCELLED
    }

    struct Market {
        bytes32 externalIdHash;
        uint8 outcomeCount;
        uint64 closeTime;
        MarketStatus status;
        uint8 winningOutcome;
    }

    struct Order {
        address maker;
        bytes32 marketId;
        uint8 outcome;
        bool isBuy;
        uint64 pricePpm;
        uint128 quantity;
        uint64 expiry;
        uint256 nonce;
        bytes32 clientOrderId;
    }

    struct StoredOrder {
        Order order;
        uint128 filledQuantity;
        uint256 reservedCollateral;
        uint128 reservedShares;
        OrderStatus status;
    }

    struct Match {
        bytes32 buyOrderHash;
        bytes32 sellOrderHash;
        uint128 quantity;
    }

    error ZeroAddress();
    error InvalidAmount();
    error InvalidMarket();
    error InvalidMarketState();
    error InvalidOutcome();
    error InvalidCloseTime();
    error InvalidOrder();
    error InvalidSignature();
    error NonceAlreadyUsed();
    error OrderAlreadyExists();
    error OrderNotActive();
    error NotOrderMaker();
    error InsufficientCollateral();
    error InsufficientShares();
    error InvalidMatch();
    error InvalidFee();
    error UnsupportedCollateral();
    error CollateralTransferMismatch();
    error LiabilityMismatch(uint256 liabilities, uint256 collateralBalance);

    IERC20 public immutable collateral;
    uint8 public immutable collateralDecimals;

    uint16 public feeBps;
    uint256 public accruedProtocolFees;
    uint256 public totalAvailableCollateral;
    uint256 public totalReservedCollateral;
    uint256 public totalMarketCollateral;

    mapping(address account => uint256 amount) public availableCollateral;
    mapping(bytes32 marketId => Market market) public markets;
    mapping(bytes32 marketId => uint256 amount) public marketCollateral;
    mapping(bytes32 marketId => mapping(uint8 outcome => mapping(address account => uint256 amount))) public
        positions;
    mapping(bytes32 orderHash => StoredOrder order) private _orders;
    mapping(address maker => mapping(uint256 nonce => bool used)) public usedNonces;

    event CollateralDeposited(address indexed account, uint256 amount);
    event CollateralWithdrawn(address indexed account, address indexed recipient, uint256 amount);
    event MarketCreated(
        bytes32 indexed marketId, bytes32 indexed externalIdHash, uint8 outcomeCount, uint64 closeTime
    );
    event MarketResolved(bytes32 indexed marketId, uint8 winningOutcome);
    event MarketInvalidated(bytes32 indexed marketId);
    event CompleteSetSplit(bytes32 indexed marketId, address indexed account, uint256 quantity);
    event CompleteSetMerged(bytes32 indexed marketId, address indexed account, uint256 quantity);
    event PositionRedeemed(bytes32 indexed marketId, address indexed account, uint256 payout);
    event OrderSubmitted(
        bytes32 indexed orderHash,
        address indexed maker,
        bytes32 indexed marketId,
        uint8 outcome,
        bool isBuy,
        uint64 pricePpm,
        uint128 quantity
    );
    event OrderCancelled(bytes32 indexed orderHash, address indexed maker);
    event TradeExecuted(
        bytes32 indexed marketId,
        uint8 indexed outcome,
        bytes32 indexed buyOrderHash,
        bytes32 sellOrderHash,
        uint128 quantity,
        uint64 clearingPricePpm,
        uint256 quoteAmount,
        uint256 feeAmount
    );
    event FeeUpdated(uint16 previousFeeBps, uint16 newFeeBps);
    event ProtocolFeesWithdrawn(address indexed recipient, uint256 amount);

    constructor(
        address collateral_,
        address admin_,
        address marketAdmin_,
        address matcher_,
        address resolver_,
        address pauser_,
        address feeWithdrawer_,
        uint16 feeBps_
    ) EIP712("AIR Arena Arc", "1") {
        if (
            collateral_ == address(0) || admin_ == address(0) || marketAdmin_ == address(0)
                || matcher_ == address(0) || resolver_ == address(0) || pauser_ == address(0)
                || feeWithdrawer_ == address(0)
        ) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert InvalidFee();

        collateral = IERC20(collateral_);
        collateralDecimals = IERC20Metadata(collateral_).decimals();
        if (collateralDecimals != 6) revert UnsupportedCollateral();
        feeBps = feeBps_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(MARKET_ADMIN_ROLE, marketAdmin_);
        _grantRole(MATCHER_ROLE, matcher_);
        _grantRole(RESOLVER_ROLE, resolver_);
        _grantRole(PAUSER_ROLE, pauser_);
        _grantRole(FEE_WITHDRAWER_ROLE, feeWithdrawer_);
    }

    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        uint256 beforeBalance = collateral.balanceOf(address(this));
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        if (collateral.balanceOf(address(this)) - beforeBalance != amount) {
            revert CollateralTransferMismatch();
        }
        availableCollateral[msg.sender] += amount;
        totalAvailableCollateral += amount;
        emit CollateralDeposited(msg.sender, amount);
        _assertSolvent();
    }

    function withdraw(uint256 amount, address recipient) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (recipient == address(0)) revert ZeroAddress();
        uint256 available = availableCollateral[msg.sender];
        if (available < amount) revert InsufficientCollateral();
        availableCollateral[msg.sender] = available - amount;
        totalAvailableCollateral -= amount;
        collateral.safeTransfer(recipient, amount);
        emit CollateralWithdrawn(msg.sender, recipient, amount);
        _assertSolvent();
    }

    function createMarket(bytes32 marketId, bytes32 externalIdHash, uint8 outcomeCount, uint64 closeTime)
        external
        onlyRole(MARKET_ADMIN_ROLE)
    {
        if (marketId == bytes32(0) || externalIdHash == bytes32(0)) revert InvalidMarket();
        if (markets[marketId].status != MarketStatus.NONE) revert InvalidMarketState();
        if (outcomeCount < MIN_OUTCOMES || outcomeCount > MAX_OUTCOMES) revert InvalidOutcome();
        // ARC block time is the canonical coarse-grained boundary for immutable market windows.
        // forge-lint: disable-next-line(block-timestamp)
        if (closeTime <= block.timestamp) revert InvalidCloseTime();
        markets[marketId] = Market({
            externalIdHash: externalIdHash,
            outcomeCount: outcomeCount,
            closeTime: closeTime,
            status: MarketStatus.OPEN,
            winningOutcome: 0
        });
        emit MarketCreated(marketId, externalIdHash, outcomeCount, closeTime);
    }

    function splitCompleteSet(bytes32 marketId, uint256 quantity) external whenNotPaused {
        Market memory market = _requireOpenMarket(marketId);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= market.closeTime) revert InvalidMarketState();
        if (quantity == 0) revert InvalidAmount();
        uint256 available = availableCollateral[msg.sender];
        if (available < quantity) revert InsufficientCollateral();

        availableCollateral[msg.sender] = available - quantity;
        totalAvailableCollateral -= quantity;
        marketCollateral[marketId] += quantity;
        totalMarketCollateral += quantity;
        for (uint8 outcome = 0; outcome < market.outcomeCount; ++outcome) {
            positions[marketId][outcome][msg.sender] += quantity;
        }
        emit CompleteSetSplit(marketId, msg.sender, quantity);
        _assertSolvent();
    }

    function mergeCompleteSet(bytes32 marketId, uint256 quantity) external whenNotPaused {
        Market memory market = _requireOpenMarket(marketId);
        if (quantity == 0) revert InvalidAmount();
        for (uint8 outcome = 0; outcome < market.outcomeCount; ++outcome) {
            uint256 balance = positions[marketId][outcome][msg.sender];
            if (balance < quantity) revert InsufficientShares();
            positions[marketId][outcome][msg.sender] = balance - quantity;
        }
        marketCollateral[marketId] -= quantity;
        totalMarketCollateral -= quantity;
        availableCollateral[msg.sender] += quantity;
        totalAvailableCollateral += quantity;
        emit CompleteSetMerged(marketId, msg.sender, quantity);
        _assertSolvent();
    }

    function resolveMarket(bytes32 marketId, uint8 winningOutcome) external onlyRole(RESOLVER_ROLE) {
        Market storage market = markets[marketId];
        // forge-lint: disable-next-line(block-timestamp)
        if (market.status != MarketStatus.OPEN || block.timestamp < market.closeTime) {
            revert InvalidMarketState();
        }
        if (winningOutcome >= market.outcomeCount) revert InvalidOutcome();
        market.status = MarketStatus.RESOLVED;
        market.winningOutcome = winningOutcome;
        emit MarketResolved(marketId, winningOutcome);
    }

    function invalidateMarket(bytes32 marketId) external onlyRole(RESOLVER_ROLE) {
        Market storage market = markets[marketId];
        // forge-lint: disable-next-line(block-timestamp)
        if (market.status != MarketStatus.OPEN || block.timestamp < market.closeTime) {
            revert InvalidMarketState();
        }
        market.status = MarketStatus.INVALID;
        emit MarketInvalidated(marketId);
    }

    function redeem(bytes32 marketId) external {
        Market memory market = markets[marketId];
        uint256 payout;
        if (market.status == MarketStatus.RESOLVED) {
            payout = positions[marketId][market.winningOutcome][msg.sender];
            if (payout == 0) revert InvalidAmount();
            positions[marketId][market.winningOutcome][msg.sender] = 0;
        } else if (market.status == MarketStatus.INVALID) {
            uint256 totalShares;
            for (uint8 outcome = 0; outcome < market.outcomeCount; ++outcome) {
                totalShares += positions[marketId][outcome][msg.sender];
                positions[marketId][outcome][msg.sender] = 0;
            }
            payout = totalShares / market.outcomeCount;
            if (payout == 0) revert InvalidAmount();
        } else {
            revert InvalidMarketState();
        }

        marketCollateral[marketId] -= payout;
        totalMarketCollateral -= payout;
        availableCollateral[msg.sender] += payout;
        totalAvailableCollateral += payout;
        emit PositionRedeemed(marketId, msg.sender, payout);
        _assertSolvent();
    }

    function submitOrder(Order calldata order, bytes calldata signature)
        external
        whenNotPaused
        returns (bytes32 orderHash)
    {
        Market memory market = _requireOpenMarket(order.marketId);
        // Expiry and close-time checks use the same canonical ARC block-time boundary.
        if (
            order.maker == address(0) || order.outcome >= market.outcomeCount || order.pricePpm == 0
                // forge-lint: disable-next-line(block-timestamp)
                || order.pricePpm >= PRICE_SCALE || order.quantity == 0 || order.expiry <= block.timestamp
                // forge-lint: disable-next-line(block-timestamp)
                || block.timestamp >= market.closeTime || order.clientOrderId == bytes32(0)
        ) revert InvalidOrder();
        if (usedNonces[order.maker][order.nonce]) revert NonceAlreadyUsed();

        orderHash = hashOrder(order);
        if (_orders[orderHash].status != OrderStatus.NONE) revert OrderAlreadyExists();
        if (!SignatureChecker.isValidSignatureNow(order.maker, orderHash, signature)) {
            revert InvalidSignature();
        }

        usedNonces[order.maker][order.nonce] = true;
        StoredOrder storage stored = _orders[orderHash];
        stored.order = order;
        stored.status = OrderStatus.ACTIVE;

        if (order.isBuy) {
            uint256 reserve = Math.mulDiv(
                uint256(order.quantity), uint256(order.pricePpm), PRICE_SCALE, Math.Rounding.Ceil
            );
            uint256 available = availableCollateral[order.maker];
            if (available < reserve) revert InsufficientCollateral();
            availableCollateral[order.maker] = available - reserve;
            totalAvailableCollateral -= reserve;
            totalReservedCollateral += reserve;
            stored.reservedCollateral = reserve;
        } else {
            uint256 shares = positions[order.marketId][order.outcome][order.maker];
            if (shares < order.quantity) revert InsufficientShares();
            positions[order.marketId][order.outcome][order.maker] = shares - order.quantity;
            stored.reservedShares = order.quantity;
        }

        emit OrderSubmitted(
            orderHash, order.maker, order.marketId, order.outcome, order.isBuy, order.pricePpm, order.quantity
        );
        _assertSolvent();
    }

    function cancelOrder(bytes32 orderHash) external {
        StoredOrder storage stored = _orders[orderHash];
        if (stored.status != OrderStatus.ACTIVE) revert OrderNotActive();
        if (stored.order.maker != msg.sender) revert NotOrderMaker();
        _releaseReservation(stored);
        stored.status = OrderStatus.CANCELLED;
        emit OrderCancelled(orderHash, msg.sender);
        _assertSolvent();
    }

    function executeBatch(bytes32 marketId, uint8 outcome, uint64 clearingPricePpm, Match[] calldata matches_)
        external
        onlyRole(MATCHER_ROLE)
        whenNotPaused
    {
        Market memory market = _requireOpenMarket(marketId);
        if (
            // forge-lint: disable-next-line(block-timestamp)
            block.timestamp >= market.closeTime || outcome >= market.outcomeCount || clearingPricePpm == 0
                || clearingPricePpm >= PRICE_SCALE || matches_.length == 0
        ) revert InvalidMatch();

        for (uint256 i = 0; i < matches_.length; ++i) {
            Match calldata matched = matches_[i];
            StoredOrder storage buy = _orders[matched.buyOrderHash];
            StoredOrder storage sell = _orders[matched.sellOrderHash];
            if (
                matched.quantity == 0 || buy.status != OrderStatus.ACTIVE || sell.status != OrderStatus.ACTIVE
                    || !buy.order.isBuy || sell.order.isBuy || buy.order.marketId != marketId
                    || sell.order.marketId != marketId || buy.order.outcome != outcome
                    || sell.order.outcome != outcome || clearingPricePpm > buy.order.pricePpm
                    // forge-lint: disable-next-line(block-timestamp)
                    || clearingPricePpm < sell.order.pricePpm || block.timestamp >= buy.order.expiry
                    // forge-lint: disable-next-line(block-timestamp)
                    || block.timestamp >= sell.order.expiry
            ) revert InvalidMatch();

            uint256 buyRemaining = uint256(buy.order.quantity) - buy.filledQuantity;
            uint256 sellRemaining = uint256(sell.order.quantity) - sell.filledQuantity;
            if (matched.quantity > buyRemaining || matched.quantity > sellRemaining) revert InvalidMatch();

            uint128 buyFilledBefore = buy.filledQuantity;
            uint128 buyFilledAfter = buyFilledBefore + matched.quantity;
            uint256 reserveBefore = Math.mulDiv(
                uint256(buyFilledBefore), uint256(buy.order.pricePpm), PRICE_SCALE, Math.Rounding.Ceil
            );
            uint256 reserveAfter = Math.mulDiv(
                uint256(buyFilledAfter), uint256(buy.order.pricePpm), PRICE_SCALE, Math.Rounding.Ceil
            );
            uint256 reserveConsumed = reserveAfter - reserveBefore;
            uint256 quoteAmount = Math.mulDiv(matched.quantity, clearingPricePpm, PRICE_SCALE);
            if (quoteAmount == 0 || reserveConsumed < quoteAmount || buy.reservedCollateral < reserveConsumed)
            {
                revert InvalidMatch();
            }

            uint256 feeAmount = Math.mulDiv(quoteAmount, feeBps, 10_000);
            uint256 sellerProceeds = quoteAmount - feeAmount;
            uint256 buyerRefund = reserveConsumed - quoteAmount;

            buy.filledQuantity = buyFilledAfter;
            sell.filledQuantity += matched.quantity;
            buy.reservedCollateral -= reserveConsumed;
            sell.reservedShares -= matched.quantity;
            totalReservedCollateral -= reserveConsumed;

            if (buyerRefund != 0) {
                availableCollateral[buy.order.maker] += buyerRefund;
                totalAvailableCollateral += buyerRefund;
            }
            availableCollateral[sell.order.maker] += sellerProceeds;
            totalAvailableCollateral += sellerProceeds;
            accruedProtocolFees += feeAmount;
            positions[marketId][outcome][buy.order.maker] += matched.quantity;

            if (buy.filledQuantity == buy.order.quantity) {
                _releaseReservation(buy);
                buy.status = OrderStatus.FILLED;
            }
            if (sell.filledQuantity == sell.order.quantity) {
                if (sell.reservedShares != 0) revert InvalidMatch();
                sell.status = OrderStatus.FILLED;
            }

            emit TradeExecuted(
                marketId,
                outcome,
                matched.buyOrderHash,
                matched.sellOrderHash,
                matched.quantity,
                clearingPricePpm,
                quoteAmount,
                feeAmount
            );
        }
        _assertSolvent();
    }

    function setFeeBps(uint16 newFeeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newFeeBps > MAX_FEE_BPS) revert InvalidFee();
        uint16 previous = feeBps;
        feeBps = newFeeBps;
        emit FeeUpdated(previous, newFeeBps);
    }

    function withdrawProtocolFees(uint256 amount, address recipient)
        external
        onlyRole(FEE_WITHDRAWER_ROLE)
        nonReentrant
    {
        if (amount == 0 || amount > accruedProtocolFees) revert InvalidAmount();
        if (recipient == address(0)) revert ZeroAddress();
        accruedProtocolFees -= amount;
        collateral.safeTransfer(recipient, amount);
        emit ProtocolFeesWithdrawn(recipient, amount);
        _assertSolvent();
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function hashOrder(Order calldata order) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ORDER_TYPEHASH,
                    order.maker,
                    order.marketId,
                    order.outcome,
                    order.isBuy,
                    order.pricePpm,
                    order.quantity,
                    order.expiry,
                    order.nonce,
                    order.clientOrderId
                )
            )
        );
    }

    function getOrder(bytes32 orderHash) external view returns (StoredOrder memory) {
        return _orders[orderHash];
    }

    function totalLiabilities() public view returns (uint256) {
        return
            totalAvailableCollateral + totalReservedCollateral + totalMarketCollateral + accruedProtocolFees;
    }

    function isSolvent() external view returns (bool) {
        return collateral.balanceOf(address(this)) >= totalLiabilities();
    }

    function _requireOpenMarket(bytes32 marketId) private view returns (Market memory market) {
        market = markets[marketId];
        if (market.status != MarketStatus.OPEN) revert InvalidMarketState();
    }

    function _releaseReservation(StoredOrder storage stored) private {
        if (stored.order.isBuy) {
            uint256 release = stored.reservedCollateral;
            if (release != 0) {
                stored.reservedCollateral = 0;
                totalReservedCollateral -= release;
                availableCollateral[stored.order.maker] += release;
                totalAvailableCollateral += release;
            }
        } else {
            uint128 release = stored.reservedShares;
            if (release != 0) {
                stored.reservedShares = 0;
                positions[stored.order.marketId][stored.order.outcome][stored.order.maker] += release;
            }
        }
    }

    function _assertSolvent() private view {
        uint256 liabilities = totalLiabilities();
        uint256 balance = collateral.balanceOf(address(this));
        if (balance < liabilities) revert LiabilityMismatch(liabilities, balance);
    }
}
