// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {BNMToken} from "./BNMToken.sol";

/// @title Abu24KRewardLedger
/// @notice Pull-based locked/available/claimed reward ledger for BNM and NPL claims.
contract Abu24KRewardLedger is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant BSC_NPL = 0x4E8277AB31e4956b2CD48449793a57656DfC03D2;

    enum State {
        Locked,
        Available,
        Claimed,
        Burned
    }

    struct Entry {
        address user;
        bytes32 orderId;
        address asset;
        uint256 amount;
        uint8 bucket;
        State state;
    }

    BNMToken public immutable bnm;
    IERC20 public immutable npl;
    uint256 public nplReserved;
    Entry[] public entries;
    mapping(bytes32 orderId => uint256[] entryIds) public orderEntries;
    mapping(address operator => bool enabled) public operators;

    event RewardLocked(uint256 indexed entryId, bytes32 indexed orderId, address indexed user, address asset, uint256 amount, uint8 bucket);
    event RewardReleased(uint256 indexed entryId, bytes32 indexed orderId);
    event RewardClaimed(uint256 indexed entryId, address indexed user, address asset, uint256 amount);
    event LockedRewardBurned(uint256 indexed entryId, bytes32 indexed orderId);
    event UnclaimedRewardBurned(uint256 indexed entryId, bytes32 indexed orderId, State previousState);
    event LedgerPaused(address indexed account);
    event LedgerUnpaused(address indexed account);
    event OperatorUpdated(address indexed operator, bool enabled);

    error InvalidAddress();
    error InvalidNplAddress(address token);
    error InvalidAmount();
    error InvalidEntry();
    error InvalidState(State current);
    error UnsupportedAsset(address asset);
    error InsufficientNplFunding(uint256 available, uint256 required);
    error NotEntryOwner();
    error NotOperatorOrOwner();
    error OwnershipRenounceDisabled();

    constructor(address bnm_, address npl_, address initialOwner) Ownable(initialOwner) {
        if (bnm_ == address(0) || npl_ == address(0) || initialOwner == address(0)) revert InvalidAddress();
        if (block.chainid == 56 && npl_ != BSC_NPL) revert InvalidNplAddress(npl_);
        bnm = BNMToken(bnm_);
        npl = IERC20(npl_);
    }

    function entryCount() external view returns (uint256) {
        return entries.length;
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

    function lockReward(address user, bytes32 orderId, address asset, uint256 amount, uint8 bucket) external onlyOperatorOrOwner whenNotPaused returns (uint256 entryId) {
        if (user == address(0) || asset == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (asset == address(npl)) {
            uint256 balance = npl.balanceOf(address(this));
            uint256 available = balance > nplReserved ? balance - nplReserved : 0;
            if (amount > available) revert InsufficientNplFunding(available, amount);
            nplReserved += amount;
        } else if (asset != address(bnm)) {
            revert UnsupportedAsset(asset);
        }
        entryId = entries.length;
        entries.push(Entry({ user: user, orderId: orderId, asset: asset, amount: amount, bucket: bucket, state: State.Locked }));
        orderEntries[orderId].push(entryId);
        emit RewardLocked(entryId, orderId, user, asset, amount, bucket);
    }

    /// @notice Settlement recovery remains available while claims are paused.
    function releaseOrderRewards(bytes32 orderId) external onlyOperatorOrOwner {
        uint256[] storage ids = orderEntries[orderId];
        for (uint256 i = 0; i < ids.length; i++) {
            Entry storage entry = entries[ids[i]];
            if (entry.state == State.Locked) {
                entry.state = State.Available;
                emit RewardReleased(ids[i], orderId);
            }
        }
    }

    function claim(uint256 entryId) external nonReentrant whenNotPaused {
        if (entryId >= entries.length) revert InvalidEntry();
        Entry storage entry = entries[entryId];
        if (entry.user != msg.sender) revert NotEntryOwner();
        if (entry.state != State.Available) revert InvalidState(entry.state);
        entry.state = State.Claimed;
        if (entry.asset == address(bnm)) {
            bnm.mint(entry.user, entry.amount);
        } else {
            nplReserved -= entry.amount;
            npl.safeTransfer(entry.user, entry.amount);
        }
        emit RewardClaimed(entryId, entry.user, entry.asset, entry.amount);
    }

    /// @notice Emergency path for forced refunds: burn not-yet-claimable rewards while claims are paused.
    function emergencyBurnLocked(bytes32 orderId) external onlyOwner whenPaused {
        _emergencyBurnUnclaimed(orderId, false);
    }

    /// @notice Emergency path for forced refunds after rewards have already moved to Available but were not claimed yet.
    function emergencyBurnUnclaimed(bytes32 orderId) external onlyOwner whenPaused {
        _emergencyBurnUnclaimed(orderId, true);
    }

    /// @notice Recovery path used atomically by Escrow refunds. Claims may be paused independently.
    function burnOrderRewards(bytes32 orderId) external onlyOperatorOrOwner returns (uint256 burnedCount) {
        return _emergencyBurnUnclaimed(orderId, true);
    }

    function _emergencyBurnUnclaimed(bytes32 orderId, bool includeAvailable) private returns (uint256 burnedCount) {
        uint256[] storage ids = orderEntries[orderId];
        for (uint256 i = 0; i < ids.length; i++) {
            Entry storage entry = entries[ids[i]];
            if (entry.state == State.Locked || (includeAvailable && entry.state == State.Available)) {
                State previousState = entry.state;
                entry.state = State.Burned;
                if (entry.asset == address(npl)) nplReserved -= entry.amount;
                if (previousState == State.Locked) emit LockedRewardBurned(ids[i], orderId);
                emit UnclaimedRewardBurned(ids[i], orderId, previousState);
                burnedCount += 1;
            }
        }
    }

    function pause() external onlyOwner {
        _pause();
        emit LedgerPaused(msg.sender);
    }

    function unpause() external onlyOwner {
        _unpause();
        emit LedgerUnpaused(msg.sender);
    }

    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenounceDisabled();
    }
}
