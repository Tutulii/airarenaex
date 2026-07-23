// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { IArenaResolutionVerifier } from "./IArenaResolutionVerifier.sol";

/// @title AIR Arena Exchange
/// @notice Frozen ARC Testnet exchange interface for fully collateralized outcome claims.
contract ArenaExchange is AccessControl, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    uint256 public constant ARC_CHAIN_ID = 5_042_002;
    address public constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    uint8 public constant COLLATERAL_DECIMALS = 6;
    uint256 public constant PAYOUT_ATOMS = 1_000_000;
    uint256 public constant PRICE_SCALE = 1_000_000;
    uint16 public constant MAX_FEE_BPS = 100;
    uint8 public constant MIN_OUTCOMES = 2;
    uint8 public constant MAX_OUTCOMES = 3;

    bytes32 public constant SEQUENCER_ROLE = keccak256("SEQUENCER_ROLE");
    bytes32 public constant RESOLVER_ROLE = keccak256("RESOLVER_ROLE");
    bytes32 public constant PROTOCOL_LIQUIDITY_ROLE = keccak256("PROTOCOL_LIQUIDITY_ROLE");
    bytes32 public constant EMERGENCY_PAUSER_ROLE = keccak256("EMERGENCY_PAUSER_ROLE");
    bytes32 public constant UPGRADE_MULTISIG_ROLE = DEFAULT_ADMIN_ROLE;

    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address maker,bytes32 marketId,uint8 outcome,bool isBuy,uint64 pricePpm,uint128 quantity,uint64 expiry,uint256 nonce,bytes32 clientOrderId)"
    );
    bytes32 public constant CANCEL_TYPEHASH =
        keccak256("Cancel(address maker,bytes32 orderHash,uint256 nonce,uint64 deadline)");

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
    enum BatchStatus {
        NONE,
        OPEN,
        SEALED,
        CLEARED,
        COMMITTED,
        APPLIED,
        FINALIZED,
        ABORTED
    }

    struct Market {
        bytes32 specHash;
        bytes32 externalIdHash;
        bytes32 resolutionRuleHash;
        uint64 closeTime;
        uint8 outcomeCount;
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

    struct Cancel {
        address maker;
        bytes32 orderHash;
        uint256 nonce;
        uint64 deadline;
    }

    struct Match {
        bytes32 buyOrderHash;
        bytes32 sellOrderHash;
        uint128 quantity;
    }

    struct Batch {
        bytes32 marketId;
        bytes32 priorRoot;
        bytes32 dataCommitment;
        bytes32 orderRoot;
        bytes32 matchRoot;
        bytes32 expectedLedgerRoot;
        bytes32 rollingLedgerRoot;
        uint64 sequence;
        uint64 clearingPricePpm;
        uint32 matchCount;
        uint32 appliedCount;
        uint8 outcome;
        BatchStatus status;
        uint256 expectedDebits;
        uint256 expectedCredits;
        uint256 expectedFees;
        uint256 expectedClaimAtoms;
        uint256 appliedDebits;
        uint256 appliedCredits;
        uint256 appliedFees;
        uint256 appliedClaimDebits;
        uint256 appliedClaimCredits;
    }

    struct NormalizedResolutionReport {
        bytes32 sourceId;
        bytes32 sourceEventId;
        bytes32 rawPayloadHash;
        bytes32 reportDigest;
        uint64 observedAt;
        uint64 publishedAt;
        bool finalResult;
        uint8 normalizedOutcome;
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
    error WrongChain();
    error RoleCollision();
    error UnsupportedRole();
    error CollateralTransferMismatch();
    error LiabilityMismatch(uint256 liabilities, uint256 collateralBalance);
    error InvariantViolation();
    error InvalidBatch();
    error BatchConflict();
    error InvalidProof();
    error EvidenceReplay();

    IERC20 public immutable collateral;
    IArenaResolutionVerifier public immutable resolutionVerifier;

    uint16 public feeBps;
    uint256 public accruedProtocolFees;
    uint256 public accruedProtocolDust;
    uint256 public totalAvailableCollateral;
    uint256 public totalReservedCollateral;
    uint256 public totalMarketCollateral;
    uint256 public totalPendingBatchCollateral;

    mapping(address account => uint256 amount) public availableCollateral;
    mapping(bytes32 marketId => Market market) public markets;
    mapping(bytes32 marketId => IArenaResolutionVerifier.ResolutionRule rule) public resolutionRules;
    mapping(bytes32 marketId => uint256 amount) public marketCollateral;
    mapping(bytes32 marketId => uint256 atoms) public completeSetAtomsOutstanding;
    mapping(bytes32 marketId => mapping(uint8 outcome => uint256 atoms)) public claimSupplyAtoms;
    mapping(bytes32 marketId => uint256 remainderUnits) public invalidationRemainderUnits;
    mapping(bytes32 marketId => mapping(uint8 outcome => mapping(address account => uint256 amount))) public
        positions;
    mapping(bytes32 orderHash => StoredOrder order) private _orders;
    mapping(address maker => mapping(uint256 nonce => bool used)) public usedNonces;
    mapping(address maker => mapping(uint256 nonce => bool used)) public usedCancellationNonces;

    mapping(bytes32 commitment => uint256 blockNumber) public publishedDataCommitments;
    mapping(bytes32 batchId => Batch batch) private _batches;
    mapping(bytes32 marketId => bytes32 batchId) public activeBatchByMarket;
    mapping(bytes32 marketId => uint64 sequence) public nextBatchSequence;
    mapping(bytes32 marketId => bytes32 root) public lastFinalizedLedgerRoot;
    mapping(bytes32 batchId => mapping(uint32 index => bytes32 leaf)) public appliedBatchLeaves;
    mapping(bytes32 batchId => mapping(address account => uint256 atoms)) public pendingBatchCollateral;
    mapping(bytes32 batchId => mapping(address account => uint256 atoms)) public pendingBatchShares;

    mapping(bytes32 digest => bool used) public usedResolutionReports;
    mapping(bytes32 marketId => mapping(uint8 sourceIndex => NormalizedResolutionReport report)) public
        normalizedResolutionReports;

    event CollateralDeposited(address indexed account, uint256 amount);
    event CollateralWithdrawn(address indexed account, address indexed recipient, uint256 amount);
    event MarketCreated(
        bytes32 indexed marketId,
        bytes32 indexed specHash,
        bytes32 indexed externalIdHash,
        bytes32 resolutionRuleHash,
        uint8 outcomeCount,
        uint64 closeTime
    );
    event MarketResolved(
        bytes32 indexed marketId, uint8 winningOutcome, bytes32 primaryReport, bytes32 witnessReport
    );
    event MarketInvalidated(bytes32 indexed marketId, bytes32 primaryReport, bytes32 witnessReport);
    event ResolutionReportStored(
        bytes32 indexed marketId,
        bytes32 indexed sourceId,
        bytes32 indexed reportDigest,
        bytes32 rawPayloadHash,
        uint8 normalizedOutcome,
        bool finalResult,
        uint64 observedAt,
        uint64 publishedAt
    );
    event CompleteSetSplit(bytes32 indexed marketId, address indexed account, uint256 quantity);
    event CompleteSetMerged(bytes32 indexed marketId, address indexed account, uint256 quantity);
    event PositionRedeemed(bytes32 indexed marketId, address indexed account, uint256 payout, uint256 dust);
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
    event DataCommitmentPublished(bytes32 indexed commitment, uint256 indexed blockNumber);
    event BatchStatusChanged(
        bytes32 indexed batchId, bytes32 indexed marketId, uint64 indexed sequence, BatchStatus status
    );
    event BatchMatchApplied(bytes32 indexed batchId, uint32 indexed index, bytes32 indexed leaf);
    event BatchSettlementClaimed(
        bytes32 indexed batchId, address indexed account, uint256 collateralAtoms, uint256 shareAtoms
    );
    event FeeUpdated(uint16 previousFeeBps, uint16 newFeeBps);
    event ProtocolRevenueWithdrawn(address indexed recipient, uint256 fees, uint256 dust);

    constructor(
        address sequencer,
        address resolver,
        address protocolLiquidityAgent,
        address emergencyPauser,
        address upgradeMultisig,
        address resolutionVerifier_,
        uint16 feeBps_
    ) EIP712("AIR Arena Arc", "1") {
        if (block.chainid != ARC_CHAIN_ID) revert WrongChain();
        if (
            sequencer == address(0) || resolver == address(0) || protocolLiquidityAgent == address(0)
                || emergencyPauser == address(0) || upgradeMultisig == address(0)
                || resolutionVerifier_ == address(0)
        ) revert ZeroAddress();
        address[5] memory authorities =
            [sequencer, resolver, protocolLiquidityAgent, emergencyPauser, upgradeMultisig];
        for (uint256 i; i < authorities.length; ++i) {
            for (uint256 j = i + 1; j < authorities.length; ++j) {
                if (authorities[i] == authorities[j]) revert RoleCollision();
            }
        }
        if (resolutionVerifier_.code.length == 0) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert InvalidFee();

        collateral = IERC20(ARC_USDC);
        if (IERC20Metadata(ARC_USDC).decimals() != COLLATERAL_DECIMALS) revert UnsupportedCollateral();
        resolutionVerifier = IArenaResolutionVerifier(resolutionVerifier_);
        feeBps = feeBps_;

        _grantRole(SEQUENCER_ROLE, sequencer);
        _grantRole(RESOLVER_ROLE, resolver);
        _grantRole(PROTOCOL_LIQUIDITY_ROLE, protocolLiquidityAgent);
        _grantRole(EMERGENCY_PAUSER_ROLE, emergencyPauser);
        _grantRole(UPGRADE_MULTISIG_ROLE, upgradeMultisig);
    }

    function grantRole(bytes32 role, address account) public override onlyRole(getRoleAdmin(role)) {
        if (!_supportedRole(role)) revert UnsupportedRole();
        if (_hasOperationalRole(account)) revert RoleCollision();
        _grantRole(role, account);
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

    function createMarket(
        bytes32 marketId,
        bytes32 specHash,
        bytes32 externalIdHash,
        uint8 outcomeCount,
        uint64 closeTime,
        IArenaResolutionVerifier.ResolutionRule calldata rule
    ) external onlyRole(UPGRADE_MULTISIG_ROLE) {
        if (marketId == bytes32(0) || specHash == bytes32(0) || externalIdHash == bytes32(0)) revert InvalidMarket();
        if (markets[marketId].status != MarketStatus.NONE) revert InvalidMarketState();
        if (outcomeCount < MIN_OUTCOMES || outcomeCount > MAX_OUTCOMES) revert InvalidOutcome();
        if (closeTime <= block.timestamp) revert InvalidCloseTime();
        if (
            rule.primarySourceId == bytes32(0) || rule.witnessSourceId == bytes32(0)
                || rule.sourceEventId == bytes32(0) || rule.primarySigner == address(0)
                || rule.witnessSigner == address(0) || rule.primarySigner == rule.witnessSigner
                || rule.primarySourceId == rule.witnessSourceId || rule.maxReportAgeSeconds == 0
                || rule.graceSeconds == 0
        ) revert InvalidMarket();
        bytes32 ruleHash = keccak256(abi.encode(rule));
        markets[marketId] = Market({
            specHash: specHash,
            externalIdHash: externalIdHash,
            resolutionRuleHash: ruleHash,
            closeTime: closeTime,
            outcomeCount: outcomeCount,
            status: MarketStatus.OPEN,
            winningOutcome: 0
        });
        resolutionRules[marketId] = rule;
        emit MarketCreated(marketId, specHash, externalIdHash, ruleHash, outcomeCount, closeTime);
    }

    function splitCompleteSet(bytes32 marketId, uint256 quantity) external whenNotPaused {
        Market memory market = _requireOpenMarket(marketId);
        if (block.timestamp >= market.closeTime) revert InvalidMarketState();
        if (quantity == 0 || quantity % PAYOUT_ATOMS != 0) revert InvalidAmount();
        uint256 available = availableCollateral[msg.sender];
        if (available < quantity) revert InsufficientCollateral();

        availableCollateral[msg.sender] = available - quantity;
        totalAvailableCollateral -= quantity;
        marketCollateral[marketId] += quantity;
        completeSetAtomsOutstanding[marketId] += quantity;
        totalMarketCollateral += quantity;
        for (uint8 outcome; outcome < market.outcomeCount; ++outcome) {
            positions[marketId][outcome][msg.sender] += quantity;
            claimSupplyAtoms[marketId][outcome] += quantity;
        }
        _assertOpenMarketIssuanceInvariant(marketId, market.outcomeCount);
        emit CompleteSetSplit(marketId, msg.sender, quantity);
        _assertSolvent();
    }

    function mergeCompleteSet(bytes32 marketId, uint256 quantity) external whenNotPaused {
        Market memory market = _requireOpenMarket(marketId);
        if (quantity == 0 || quantity % PAYOUT_ATOMS != 0) revert InvalidAmount();
        for (uint8 outcome; outcome < market.outcomeCount; ++outcome) {
            uint256 balance = positions[marketId][outcome][msg.sender];
            if (balance < quantity) revert InsufficientShares();
            positions[marketId][outcome][msg.sender] = balance - quantity;
            claimSupplyAtoms[marketId][outcome] -= quantity;
        }
        marketCollateral[marketId] -= quantity;
        completeSetAtomsOutstanding[marketId] -= quantity;
        totalMarketCollateral -= quantity;
        availableCollateral[msg.sender] += quantity;
        totalAvailableCollateral += quantity;
        _assertOpenMarketIssuanceInvariant(marketId, market.outcomeCount);
        emit CompleteSetMerged(marketId, msg.sender, quantity);
        _assertSolvent();
    }

    function resolveMarket(
        bytes32 marketId,
        IArenaResolutionVerifier.ResolutionReport calldata primary,
        IArenaResolutionVerifier.ResolutionReport calldata witness
    ) external onlyRole(RESOLVER_ROLE) {
        Market storage market = markets[marketId];
        if (market.status != MarketStatus.OPEN || block.timestamp < market.closeTime) {
            revert InvalidMarketState();
        }
        IArenaResolutionVerifier.ResolutionRule storage rule = resolutionRules[marketId];
        IArenaResolutionVerifier.VerificationResult memory result = resolutionVerifier.verify(
            address(this), marketId, market.specHash, market.outcomeCount, rule, primary, witness
        );
        if (usedResolutionReports[result.primaryDigest] || usedResolutionReports[result.witnessDigest]) {
            revert EvidenceReplay();
        }
        usedResolutionReports[result.primaryDigest] = true;
        usedResolutionReports[result.witnessDigest] = true;
        _storeReport(marketId, 0, primary, result.primaryDigest);
        _storeReport(marketId, 1, witness, result.witnessDigest);
        result.validQuorum = result.validQuorum && block.timestamp - market.closeTime <= rule.graceSeconds;
        if (result.validQuorum) {
            market.status = MarketStatus.RESOLVED;
            market.winningOutcome = result.normalizedOutcome;
            emit MarketResolved(
                marketId, result.normalizedOutcome, result.primaryDigest, result.witnessDigest
            );
        } else {
            market.status = MarketStatus.INVALID;
            emit MarketInvalidated(marketId, result.primaryDigest, result.witnessDigest);
        }
    }

    function invalidateAfterGrace(bytes32 marketId) external {
        Market storage market = markets[marketId];
        IArenaResolutionVerifier.ResolutionRule storage rule = resolutionRules[marketId];
        if (
            market.status != MarketStatus.OPEN
                || block.timestamp < uint256(market.closeTime) + uint256(rule.graceSeconds)
        ) revert InvalidMarketState();
        market.status = MarketStatus.INVALID;
        emit MarketInvalidated(marketId, bytes32(0), bytes32(0));
    }

    function redeem(bytes32 marketId) external nonReentrant {
        Market memory market = markets[marketId];
        if (market.status != MarketStatus.RESOLVED && market.status != MarketStatus.INVALID) {
            revert InvalidMarketState();
        }
        uint256 totalShares;
        uint256 payout;
        for (uint8 outcome; outcome < market.outcomeCount; ++outcome) {
            uint256 balance = positions[marketId][outcome][msg.sender];
            totalShares += balance;
            if (market.status == MarketStatus.RESOLVED && outcome == market.winningOutcome) payout = balance;
            if (balance != 0) {
                positions[marketId][outcome][msg.sender] = 0;
                claimSupplyAtoms[marketId][outcome] -= balance;
            }
        }
        if (totalShares == 0) revert InvalidAmount();

        uint256 dust;
        if (market.status == MarketStatus.INVALID) {
            payout = totalShares / market.outcomeCount;
            uint256 remainder = invalidationRemainderUnits[marketId] + (totalShares % market.outcomeCount);
            dust = remainder / market.outcomeCount;
            invalidationRemainderUnits[marketId] = remainder % market.outcomeCount;
        }
        uint256 released = payout + dust;
        marketCollateral[marketId] -= released;
        completeSetAtomsOutstanding[marketId] -= released;
        totalMarketCollateral -= released;
        if (payout != 0) {
            availableCollateral[msg.sender] += payout;
            totalAvailableCollateral += payout;
        }
        if (dust != 0) accruedProtocolDust += dust;
        emit PositionRedeemed(marketId, msg.sender, payout, dust);
        _assertSolvent();
    }

    function submitOrder(Order calldata order, bytes calldata signature)
        external
        whenNotPaused
        returns (bytes32 orderHash)
    {
        Market memory market = _requireOpenMarket(order.marketId);
        if (
            order.maker == address(0) || order.outcome >= market.outcomeCount || order.pricePpm == 0
                || order.pricePpm >= PRICE_SCALE || order.quantity == 0 || order.expiry <= block.timestamp
                || block.timestamp >= market.closeTime || order.clientOrderId == bytes32(0)
        ) revert InvalidOrder();
        if (usedNonces[order.maker][order.nonce]) revert NonceAlreadyUsed();
        orderHash = hashOrder(order);
        if (_orders[orderHash].status != OrderStatus.NONE) revert OrderAlreadyExists();
        if (!resolutionVerifier.isValidSigner(order.maker, orderHash, signature)) {
            revert InvalidSignature();
        }

        usedNonces[order.maker][order.nonce] = true;
        StoredOrder storage stored = _orders[orderHash];
        stored.order = order;
        stored.status = OrderStatus.ACTIVE;
        if (order.isBuy) {
            uint256 reserve = _priceAtomsCeil(order.quantity, order.pricePpm);
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

    function cancelOrder(bytes32 orderHash) external nonReentrant {
        StoredOrder storage stored = _orders[orderHash];
        if (stored.status != OrderStatus.ACTIVE) revert OrderNotActive();
        if (stored.order.maker != msg.sender) revert NotOrderMaker();
        _cancelOrder(stored, orderHash, msg.sender);
    }

    function cancelOrderBySig(Cancel calldata cancellation, bytes calldata signature) external nonReentrant {
        if (cancellation.maker == address(0) || cancellation.deadline < block.timestamp) {
            revert InvalidOrder();
        }
        if (usedCancellationNonces[cancellation.maker][cancellation.nonce]) revert NonceAlreadyUsed();
        StoredOrder storage stored = _orders[cancellation.orderHash];
        if (stored.status != OrderStatus.ACTIVE) revert OrderNotActive();
        if (stored.order.maker != cancellation.maker) revert NotOrderMaker();
        bytes32 digest = hashCancel(cancellation);
        if (!resolutionVerifier.isValidSigner(cancellation.maker, digest, signature)) {
            revert InvalidSignature();
        }
        usedCancellationNonces[cancellation.maker][cancellation.nonce] = true;
        _cancelOrder(stored, cancellation.orderHash, cancellation.maker);
    }

    function publishDataCommitment(bytes32 commitment) external onlyRole(SEQUENCER_ROLE) whenNotPaused {
        if (commitment == bytes32(0)) revert InvalidBatch();
        uint256 published = publishedDataCommitments[commitment];
        if (published != 0) revert BatchConflict();
        publishedDataCommitments[commitment] = block.number;
        emit DataCommitmentPublished(commitment, block.number);
    }

    function openBatch(bytes32 marketId, uint64 sequence, bytes32 priorRoot, bytes32 dataCommitment)
        external
        onlyRole(SEQUENCER_ROLE)
        whenNotPaused
        returns (bytes32 batchId)
    {
        Market memory market = _requireOpenMarket(marketId);
        if (
            block.timestamp >= market.closeTime || sequence != nextBatchSequence[marketId]
                || priorRoot != lastFinalizedLedgerRoot[marketId]
                || activeBatchByMarket[marketId] != bytes32(0)
                || publishedDataCommitments[dataCommitment] == 0
                || publishedDataCommitments[dataCommitment] >= block.number
        ) revert InvalidBatch();
        batchId = keccak256(abi.encode(marketId, sequence, priorRoot, dataCommitment));
        if (_batches[batchId].status != BatchStatus.NONE) revert BatchConflict();
        Batch storage batch = _batches[batchId];
        batch.marketId = marketId;
        batch.sequence = sequence;
        batch.priorRoot = priorRoot;
        batch.dataCommitment = dataCommitment;
        batch.rollingLedgerRoot = priorRoot;
        batch.status = BatchStatus.OPEN;
        activeBatchByMarket[marketId] = batchId;
        emit BatchStatusChanged(batchId, marketId, sequence, BatchStatus.OPEN);
    }

    function sealBatch(bytes32 batchId, bytes32 orderRoot) external onlyRole(SEQUENCER_ROLE) whenNotPaused {
        Batch storage batch = _batches[batchId];
        if (batch.status != BatchStatus.OPEN || orderRoot == bytes32(0)) revert InvalidBatch();
        batch.orderRoot = orderRoot;
        batch.status = BatchStatus.SEALED;
        emit BatchStatusChanged(batchId, batch.marketId, batch.sequence, BatchStatus.SEALED);
    }

    function clearBatch(
        bytes32 batchId,
        uint8 outcome,
        uint64 clearingPricePpm,
        bytes32 matchRoot,
        uint32 matchCount,
        uint256 expectedDebits,
        uint256 expectedCredits,
        uint256 expectedFees,
        uint256 expectedClaimAtoms,
        bytes32 expectedLedgerRoot
    ) external onlyRole(SEQUENCER_ROLE) whenNotPaused {
        Batch storage batch = _batches[batchId];
        Market memory market = _requireOpenMarket(batch.marketId);
        if (
            batch.status != BatchStatus.SEALED || outcome >= market.outcomeCount || clearingPricePpm == 0
                || clearingPricePpm >= PRICE_SCALE || matchRoot == bytes32(0) || matchCount == 0
                || expectedLedgerRoot == bytes32(0) || expectedDebits != expectedCredits + expectedFees
        ) revert InvalidBatch();
        batch.outcome = outcome;
        batch.clearingPricePpm = clearingPricePpm;
        batch.matchRoot = matchRoot;
        batch.matchCount = matchCount;
        batch.expectedDebits = expectedDebits;
        batch.expectedCredits = expectedCredits;
        batch.expectedFees = expectedFees;
        batch.expectedClaimAtoms = expectedClaimAtoms;
        batch.expectedLedgerRoot = expectedLedgerRoot;
        batch.status = BatchStatus.CLEARED;
        emit BatchStatusChanged(batchId, batch.marketId, batch.sequence, BatchStatus.CLEARED);
    }

    function commitBatch(bytes32 batchId) external onlyRole(SEQUENCER_ROLE) whenNotPaused {
        Batch storage batch = _batches[batchId];
        if (batch.status != BatchStatus.CLEARED) revert InvalidBatch();
        batch.status = BatchStatus.COMMITTED;
        emit BatchStatusChanged(batchId, batch.marketId, batch.sequence, BatchStatus.COMMITTED);
    }

    function applyBatchMatch(bytes32 batchId, uint32 index, Match calldata matched, bytes32[] calldata proof)
        external
        onlyRole(SEQUENCER_ROLE)
        whenNotPaused
    {
        Batch storage batch = _batches[batchId];
        bytes32 leaf = keccak256(
            abi.encode(batchId, index, matched.buyOrderHash, matched.sellOrderHash, matched.quantity)
        );
        bytes32 applied = appliedBatchLeaves[batchId][index];
        if (applied != bytes32(0)) {
            if (applied != leaf) revert BatchConflict();
            return;
        }
        if (batch.status != BatchStatus.COMMITTED && batch.status != BatchStatus.APPLIED) {
            revert InvalidBatch();
        }
        if (index != batch.appliedCount || index >= batch.matchCount) revert InvalidBatch();
        if (!resolutionVerifier.verifyMerkle(proof, batch.matchRoot, leaf)) revert InvalidProof();

        (uint256 debits, uint256 credits, uint256 fees) =
            _applyMatch(batch.marketId, batch.outcome, batch.clearingPricePpm, matched, batchId);
        appliedBatchLeaves[batchId][index] = leaf;
        batch.appliedDebits += debits;
        batch.appliedCredits += credits;
        batch.appliedFees += fees;
        batch.appliedClaimDebits += matched.quantity;
        batch.appliedClaimCredits += matched.quantity;
        batch.appliedCount = index + 1;
        batch.rollingLedgerRoot =
            keccak256(abi.encode(batch.rollingLedgerRoot, leaf, debits, credits, fees, matched.quantity));
        if (batch.appliedCount == batch.matchCount) {
            batch.status = BatchStatus.APPLIED;
            emit BatchStatusChanged(batchId, batch.marketId, batch.sequence, BatchStatus.APPLIED);
        }
        emit BatchMatchApplied(batchId, index, leaf);
        _assertSolvent();
    }

    function finalizeBatch(bytes32 batchId) external onlyRole(SEQUENCER_ROLE) {
        Batch storage batch = _batches[batchId];
        if (
            batch.status != BatchStatus.APPLIED || batch.appliedCount != batch.matchCount
                || batch.appliedDebits != batch.expectedDebits
                || batch.appliedCredits != batch.expectedCredits || batch.appliedFees != batch.expectedFees
                || batch.appliedClaimDebits != batch.expectedClaimAtoms
                || batch.appliedClaimCredits != batch.expectedClaimAtoms
                || batch.appliedDebits != batch.appliedCredits + batch.appliedFees
                || batch.rollingLedgerRoot != batch.expectedLedgerRoot
        ) revert InvariantViolation();
        totalPendingBatchCollateral -= batch.appliedFees;
        accruedProtocolFees += batch.appliedFees;
        batch.status = BatchStatus.FINALIZED;
        lastFinalizedLedgerRoot[batch.marketId] = batch.expectedLedgerRoot;
        nextBatchSequence[batch.marketId] = batch.sequence + 1;
        activeBatchByMarket[batch.marketId] = bytes32(0);
        emit BatchStatusChanged(batchId, batch.marketId, batch.sequence, BatchStatus.FINALIZED);
        _assertSolvent();
    }

    function abortBatch(bytes32 batchId) external onlyRole(SEQUENCER_ROLE) {
        Batch storage batch = _batches[batchId];
        if (
            batch.status == BatchStatus.NONE || batch.status == BatchStatus.APPLIED
                || batch.status == BatchStatus.FINALIZED || batch.status == BatchStatus.ABORTED
                || batch.appliedCount != 0
        ) revert InvalidBatch();
        batch.status = BatchStatus.ABORTED;
        activeBatchByMarket[batch.marketId] = bytes32(0);
        emit BatchStatusChanged(batchId, batch.marketId, batch.sequence, BatchStatus.ABORTED);
    }

    function claimBatchSettlement(bytes32 batchId) external nonReentrant {
        Batch storage batch = _batches[batchId];
        if (batch.status != BatchStatus.FINALIZED) revert InvalidBatch();
        uint256 collateralAtoms = pendingBatchCollateral[batchId][msg.sender];
        uint256 shareAtoms = pendingBatchShares[batchId][msg.sender];
        if (collateralAtoms == 0 && shareAtoms == 0) revert InvalidAmount();
        if (collateralAtoms != 0) {
            pendingBatchCollateral[batchId][msg.sender] = 0;
            totalPendingBatchCollateral -= collateralAtoms;
            availableCollateral[msg.sender] += collateralAtoms;
            totalAvailableCollateral += collateralAtoms;
        }
        if (shareAtoms != 0) {
            pendingBatchShares[batchId][msg.sender] = 0;
            positions[batch.marketId][batch.outcome][msg.sender] += shareAtoms;
        }
        emit BatchSettlementClaimed(batchId, msg.sender, collateralAtoms, shareAtoms);
        _assertSolvent();
    }

    /// @notice Compatibility entry point. New callers should use the restartable lifecycle above.
    /// @dev The exact match set must have been committed in a prior block.
    function executeBatch(bytes32 marketId, uint8 outcome, uint64 clearingPricePpm, Match[] calldata matches_)
        external
        onlyRole(SEQUENCER_ROLE)
        whenNotPaused
    {
        bytes32 commitment =
            keccak256(abi.encode("AIR_ARENA_LEGACY_BATCH_V1", marketId, outcome, clearingPricePpm, matches_));
        if (publishedDataCommitments[commitment] == 0 || publishedDataCommitments[commitment] >= block.number)
        {
            revert InvalidBatch();
        }
        Market memory market = _requireOpenMarket(marketId);
        if (
            block.timestamp >= market.closeTime || outcome >= market.outcomeCount || clearingPricePpm == 0
                || clearingPricePpm >= PRICE_SCALE || matches_.length == 0
        ) revert InvalidMatch();
        for (uint256 i; i < matches_.length; ++i) {
            _applyMatch(marketId, outcome, clearingPricePpm, matches_[i], bytes32(0));
        }
        _assertSolvent();
    }

    function setFeeBps(uint16 newFeeBps) external onlyRole(UPGRADE_MULTISIG_ROLE) {
        if (newFeeBps > MAX_FEE_BPS) revert InvalidFee();
        uint16 previous = feeBps;
        feeBps = newFeeBps;
        emit FeeUpdated(previous, newFeeBps);
    }

    function withdrawProtocolRevenue(uint256 fees, uint256 dust, address recipient)
        external
        onlyRole(UPGRADE_MULTISIG_ROLE)
        nonReentrant
    {
        if ((fees == 0 && dust == 0) || fees > accruedProtocolFees || dust > accruedProtocolDust) {
            revert InvalidAmount();
        }
        if (recipient == address(0)) revert ZeroAddress();
        accruedProtocolFees -= fees;
        accruedProtocolDust -= dust;
        collateral.safeTransfer(recipient, fees + dust);
        emit ProtocolRevenueWithdrawn(recipient, fees, dust);
        _assertSolvent();
    }

    function pause() external onlyRole(EMERGENCY_PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(UPGRADE_MULTISIG_ROLE) {
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

    function hashCancel(Cancel calldata cancellation) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    CANCEL_TYPEHASH,
                    cancellation.maker,
                    cancellation.orderHash,
                    cancellation.nonce,
                    cancellation.deadline
                )
            )
        );
    }

    function getOrder(bytes32 orderHash) external view returns (StoredOrder memory) {
        return _orders[orderHash];
    }

    function totalLiabilities() public view returns (uint256) {
        return totalAvailableCollateral + totalReservedCollateral + totalMarketCollateral
            + totalPendingBatchCollateral + accruedProtocolFees + accruedProtocolDust;
    }

    function isSolvent() external view returns (bool) {
        return collateral.balanceOf(address(this)) >= totalLiabilities();
    }

    function _applyMatch(
        bytes32 marketId,
        uint8 outcome,
        uint64 clearingPricePpm,
        Match calldata matched,
        bytes32 pendingBatchId
    ) private returns (uint256 debits, uint256 credits, uint256 fees) {
        StoredOrder storage buy = _orders[matched.buyOrderHash];
        StoredOrder storage sell = _orders[matched.sellOrderHash];
        if (
            matched.quantity == 0 || buy.status != OrderStatus.ACTIVE || sell.status != OrderStatus.ACTIVE
                || !buy.order.isBuy || sell.order.isBuy || buy.order.marketId != marketId
                || sell.order.marketId != marketId || buy.order.outcome != outcome
                || sell.order.outcome != outcome || buy.order.maker == sell.order.maker
                || clearingPricePpm > buy.order.pricePpm || clearingPricePpm < sell.order.pricePpm
                || block.timestamp >= buy.order.expiry || block.timestamp >= sell.order.expiry
        ) revert InvalidMatch();
        uint256 buyRemaining = uint256(buy.order.quantity) - buy.filledQuantity;
        uint256 sellRemaining = uint256(sell.order.quantity) - sell.filledQuantity;
        if (matched.quantity > buyRemaining || matched.quantity > sellRemaining) revert InvalidMatch();

        uint128 buyFilledAfter = buy.filledQuantity + matched.quantity;
        uint256 reserveBefore = _priceAtomsCeil(buy.filledQuantity, buy.order.pricePpm);
        uint256 reserveAfter = _priceAtomsCeil(buyFilledAfter, buy.order.pricePpm);
        uint256 reserveConsumed = reserveAfter - reserveBefore;
        uint256 quoteAmount = uint256(matched.quantity) * clearingPricePpm / PRICE_SCALE;
        if (quoteAmount == 0 || reserveConsumed < quoteAmount || buy.reservedCollateral < reserveConsumed) {
            revert InvalidMatch();
        }
        uint256 feeAmount = quoteAmount * feeBps / 10_000;
        uint256 sellerProceeds = quoteAmount - feeAmount;
        uint256 buyerRefund = reserveConsumed - quoteAmount;

        buy.filledQuantity = buyFilledAfter;
        sell.filledQuantity += matched.quantity;
        buy.reservedCollateral -= reserveConsumed;
        sell.reservedShares -= matched.quantity;
        totalReservedCollateral -= reserveConsumed;
        if (pendingBatchId == bytes32(0)) {
            availableCollateral[buy.order.maker] += buyerRefund;
            availableCollateral[sell.order.maker] += sellerProceeds;
            totalAvailableCollateral += buyerRefund + sellerProceeds;
            accruedProtocolFees += feeAmount;
            positions[marketId][outcome][buy.order.maker] += matched.quantity;
        } else {
            pendingBatchCollateral[pendingBatchId][buy.order.maker] += buyerRefund;
            pendingBatchCollateral[pendingBatchId][sell.order.maker] += sellerProceeds;
            pendingBatchShares[pendingBatchId][buy.order.maker] += matched.quantity;
            totalPendingBatchCollateral += reserveConsumed;
        }
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
        return (reserveConsumed, buyerRefund + sellerProceeds, feeAmount);
    }

    function _storeReport(
        bytes32 marketId,
        uint8 sourceIndex,
        IArenaResolutionVerifier.ResolutionReport calldata report,
        bytes32 digest
    ) private {
        normalizedResolutionReports[marketId][sourceIndex] = NormalizedResolutionReport({
            sourceId: report.sourceId,
            sourceEventId: report.sourceEventId,
            rawPayloadHash: report.rawPayloadHash,
            reportDigest: digest,
            observedAt: report.observedAt,
            publishedAt: report.publishedAt,
            finalResult: report.finalResult,
            normalizedOutcome: report.normalizedOutcome
        });
        emit ResolutionReportStored(
            marketId,
            report.sourceId,
            digest,
            report.rawPayloadHash,
            report.normalizedOutcome,
            report.finalResult,
            report.observedAt,
            report.publishedAt
        );
    }

    /// @dev quantity is uint128 and price is uint64, so the checked product cannot exceed uint192.
    function _priceAtomsCeil(uint128 quantity, uint64 pricePpm) private pure returns (uint256) {
        uint256 product = uint256(quantity) * pricePpm;
        return (product + PRICE_SCALE - 1) / PRICE_SCALE;
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

    function _cancelOrder(StoredOrder storage stored, bytes32 orderHash, address maker) private {
        _releaseReservation(stored);
        stored.status = OrderStatus.CANCELLED;
        emit OrderCancelled(orderHash, maker);
        _assertSolvent();
    }

    function _supportedRole(bytes32 role) private pure returns (bool) {
        return role == UPGRADE_MULTISIG_ROLE || role == SEQUENCER_ROLE || role == RESOLVER_ROLE
            || role == PROTOCOL_LIQUIDITY_ROLE || role == EMERGENCY_PAUSER_ROLE;
    }

    function _hasOperationalRole(address account) private view returns (bool) {
        return hasRole(UPGRADE_MULTISIG_ROLE, account) || hasRole(SEQUENCER_ROLE, account)
            || hasRole(RESOLVER_ROLE, account) || hasRole(PROTOCOL_LIQUIDITY_ROLE, account)
            || hasRole(EMERGENCY_PAUSER_ROLE, account);
    }

    function _openMarketIssuanceInvariantHolds(bytes32 marketId, uint8 outcomeCount)
        private
        view
        returns (bool)
    {
        uint256 outstanding = completeSetAtomsOutstanding[marketId];
        if (marketCollateral[marketId] != outstanding || outstanding % PAYOUT_ATOMS != 0) return false;
        for (uint8 outcome; outcome < outcomeCount; ++outcome) {
            if (claimSupplyAtoms[marketId][outcome] != outstanding) return false;
        }
        return true;
    }

    function _assertOpenMarketIssuanceInvariant(bytes32 marketId, uint8 outcomeCount) private view {
        if (!_openMarketIssuanceInvariantHolds(marketId, outcomeCount)) revert InvariantViolation();
    }

    function _assertSolvent() private view {
        uint256 liabilities = totalLiabilities();
        uint256 balance = collateral.balanceOf(address(this));
        if (balance < liabilities) revert LiabilityMismatch(liabilities, balance);
    }
}
