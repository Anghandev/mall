// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @notice V2 BNM is minted only when an address-bound ledger reward is claimed.
contract BNMTokenV2 is ERC20, Ownable2Step {
    mapping(address minter => bool allowed) public minters;

    event MinterSet(address indexed minter, bool allowed);

    error InvalidAddress();
    error NotMinter();
    error OwnershipRenounceDisabled();

    constructor(address initialOwner) ERC20("Abu 24K BNM Reward", "BNM") Ownable(initialOwner) {
        if (initialOwner == address(0)) revert InvalidAddress();
    }

    modifier onlyMinter() {
        if (!minters[msg.sender]) revert NotMinter();
        _;
    }

    function setMinter(address minter, bool allowed) external onlyOwner {
        if (minter == address(0)) revert InvalidAddress();
        minters[minter] = allowed;
        emit MinterSet(minter, allowed);
    }

    function mint(address beneficiary, uint256 amount) external onlyMinter {
        if (beneficiary == address(0) || amount == 0) revert InvalidAddress();
        _mint(beneficiary, amount);
    }

    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenounceDisabled();
    }
}
