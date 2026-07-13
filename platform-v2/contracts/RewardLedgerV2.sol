// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {BNMTokenV2} from "./BNMTokenV2.sol";
import {IRewardLedgerV2} from "./interfaces/IRewardLedgerV2.sol";

/// @notice Address-bound pull claims for BNM, USDT and NPL rewards.
contract RewardLedgerV2 is Ownable2Step, ReentrancyGuard, IRewardLedgerV2 {
    using SafeERC20 for IERC20;

    enum State {
        None,
        Locked,
        Available,
        Claimed,
        Burned
    }

    struct Entry {
        address beneficiary;
        address asset;
        uint256 amount;
        uint8 role;
        State state;
        bytes32 sourceId;
    }

    address public immutable override bnm;
    bool public claimsPaused = true;
    mapping(address operator => bool enabled) public operators;
    mapping(address asset => uint256 amount) public reservedByAsset;
    mapping(bytes32 rewardId => Entry entry) public entries;
    mapping(bytes32 orderId => bytes32 rewardId) public bnmRewardByOrder;
    mapping(bytes32 sourceId => bool processed) public processedSources;

    event OperatorUpdated(address indexed operator, bool enabled);
    event ClaimsPaused(address indexed account);
    event ClaimsResumed(address indexed account);
    event RewardCreated(bytes32 indexed rewardId, bytes32 indexed sourceId, address indexed beneficiary, address asset, uint256 amount, uint8 role, State state);
    event RewardReleased(bytes32 indexed rewardId, bytes32 indexed sourceId);
    event RewardBurned(bytes32 indexed rewardId, bytes32 indexed sourceId, State previousState);
    event RewardClaimed(bytes32 indexed rewardId, address indexed beneficiary, address indexed asset, uint256 amount, address caller);
    event ExcessTokenRecovered(address indexed asset, address indexed receiver, uint256 amount);

    error InvalidAddress();
    error InvalidAmount();
    error InvalidState(State state);
    error RewardAlreadyExists(bytes32 rewardId);
    error SourceAlreadyProcessed(bytes32 sourceId);
    error NotOperatorOrOwner();
    error ClaimsArePaused();
    error InsufficientFunding(address asset, uint256 available, uint256 required);
    error ReservedFunds(uint256 available, uint256 requested);
    error OwnershipRenounceDisabled();

    constructor(address bnm_, address initialOwner) Ownable(initialOwner) {
        if (bnm_ == address(0) || initialOwner == address(0)) revert InvalidAddress();
        bnm = bnm_;
    }

    modifier onlyOperatorOrOwner() {
        if (msg.sender != owner() && !operators[msg.sender]) revert NotOperatorOrOwner();
        _;
    }

    function setOperator(address operator, bool enabled) external onlyOwner {
        if (operator == address(0)) revert InvalidAddress();
        operators[operator] = enabled;
        emit OperatorUpdated(operator, enabled);
    }

    function setClaimsPaused(bool paused) external onlyOwner {
        if (claimsPaused == paused) return;
        claimsPaused = paused;
        if (paused) emit ClaimsPaused(msg.sender);
        else emit ClaimsResumed(msg.sender);
    }

    function lockBnm(bytes32 orderId, address beneficiary, uint256 amount)
        external
        onlyOperatorOrOwner
        returns (bytes32 rewardId)
    {
        if (orderId == bytes32(0) || beneficiary == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        rewardId = keccak256(abi.encode("BNM_ORDER_V2", orderId));
        if (entries[rewardId].state != State.None) revert RewardAlreadyExists(rewardId);
        entries[rewardId] = Entry(beneficiary, bnm, amount, 0, State.Locked, orderId);
        bnmRewardByOrder[orderId] = rewardId;
        emit RewardCreated(rewardId, orderId, beneficiary, bnm, amount, 0, State.Locked);
    }

    function releaseBnm(bytes32 orderId) external onlyOperatorOrOwner {
        bytes32 rewardId = bnmRewardByOrder[orderId];
        Entry storage entry = entries[rewardId];
        if (entry.state != State.Locked) revert InvalidState(entry.state);
        entry.state = State.Available;
        emit RewardReleased(rewardId, orderId);
    }

    function burnBnm(bytes32 orderId) external onlyOperatorOrOwner {
        bytes32 rewardId = bnmRewardByOrder[orderId];
        Entry storage entry = entries[rewardId];
        if (entry.state != State.Locked && entry.state != State.Available) revert InvalidState(entry.state);
        State previous = entry.state;
        entry.state = State.Burned;
        emit RewardBurned(rewardId, orderId, previous);
    }

    function creditAvailableBatch(bytes32 sourceId, Credit[] calldata credits)
        external
        onlyOperatorOrOwner
        returns (bytes32[] memory rewardIds)
    {
        if (sourceId == bytes32(0)) revert InvalidAddress();
        if (processedSources[sourceId]) revert SourceAlreadyProcessed(sourceId);
        uint256 length = credits.length;
        if (length == 0 || length > 17) revert InvalidAmount();
        processedSources[sourceId] = true;
        rewardIds = new bytes32[](length);
        for (uint256 i = 0; i < length; i++) {
            Credit calldata credit = credits[i];
            if (credit.beneficiary == address(0) || credit.asset == address(0) || credit.asset == bnm) revert InvalidAddress();
            if (credit.amount == 0) revert InvalidAmount();
            uint256 reserved = reservedByAsset[credit.asset];
            uint256 balance = IERC20(credit.asset).balanceOf(address(this));
            uint256 available = balance > reserved ? balance - reserved : 0;
            if (credit.amount > available) revert InsufficientFunding(credit.asset, available, credit.amount);
            reservedByAsset[credit.asset] = reserved + credit.amount;
            bytes32 rewardId = keccak256(abi.encode("CREDIT_V2", sourceId, i, credit.beneficiary, credit.asset, credit.role));
            if (entries[rewardId].state != State.None) revert RewardAlreadyExists(rewardId);
            entries[rewardId] = Entry(credit.beneficiary, credit.asset, credit.amount, credit.role, State.Available, sourceId);
            rewardIds[i] = rewardId;
            emit RewardCreated(rewardId, sourceId, credit.beneficiary, credit.asset, credit.amount, credit.role, State.Available);
        }
    }

    /// @notice Any relayer may submit a claim, but funds always go to the bound beneficiary.
    function claim(bytes32 rewardId) external nonReentrant {
        if (claimsPaused) revert ClaimsArePaused();
        Entry storage entry = entries[rewardId];
        if (entry.state != State.Available) revert InvalidState(entry.state);
        entry.state = State.Claimed;
        if (entry.asset == bnm) {
            BNMTokenV2(bnm).mint(entry.beneficiary, entry.amount);
        } else {
            reservedByAsset[entry.asset] -= entry.amount;
            IERC20(entry.asset).safeTransfer(entry.beneficiary, entry.amount);
        }
        emit RewardClaimed(rewardId, entry.beneficiary, entry.asset, entry.amount, msg.sender);
    }

    function recoverExcessToken(address asset, address receiver, uint256 amount) external onlyOwner nonReentrant {
        if (asset == address(0) || receiver == address(0)) revert InvalidAddress();
        uint256 balance = IERC20(asset).balanceOf(address(this));
        uint256 reserved = reservedByAsset[asset];
        uint256 available = balance > reserved ? balance - reserved : 0;
        if (amount > available) revert ReservedFunds(available, amount);
        IERC20(asset).safeTransfer(receiver, amount);
        emit ExcessTokenRecovered(asset, receiver, amount);
    }

    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenounceDisabled();
    }
}
